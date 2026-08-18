/**
 * Spark — API worker.
 *
 * The browser never sees an API key. It calls two endpoints on its own origin:
 *
 *   POST /api/topics  { syllabus, course, level }  -> { course, topics[] }
 *   POST /api/spark   { topic, course, level }     -> a Spark Card
 *
 * Three things keep a public endpoint from becoming an open tap on the
 * deployer's credit card, in order of how much they actually matter:
 *
 *   1. Caching. Courses repeat enormously — thousands of students take
 *      "Intro Thermodynamics". Cards are keyed by a hash of the topic, not
 *      the syllabus, so two differently-worded syllabi covering the same
 *      concept share one cached card. This is the main cost control.
 *   2. Hard spend caps in dollars, metered from actual reported token usage:
 *      a lifetime cap and a per-day cap. Cache hits cost nothing.
 *   3. Per-IP rate limits, per minute and per day.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const CARD_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// USD per million tokens, [input, output]. Used to meter real spend against
// the budget cap — update these if Anthropic's prices change.
const PRICES = {
  "claude-opus-5":    [5.0, 25.0],
  "claude-sonnet-5":  [2.0, 10.0],   // intro pricing; reverts to 3/15 after 2026-08-31
  "claude-haiku-4-5": [1.0,  5.0]
};

// Haiku 4.5 rejects output_config.effort outright ("This model does not
// support the effort parameter"), so the field has to be omitted for it.
const supportsEffort = (model) => !model.startsWith("claude-haiku");

// Cost of one call in microdollars (1e-6 USD), from the usage the API reports.
// Cache writes bill at 1.25x input, cache reads at 0.1x.
function costMicros(model, usage){
  const [pin, pout] = PRICES[model] || PRICES["claude-sonnet-5"];
  const u = usage || {};
  const inTok = (u.input_tokens || 0)
              + (u.cache_creation_input_tokens || 0) * 1.25
              + (u.cache_read_input_tokens || 0) * 0.1;
  return Math.round(inTok * pin + (u.output_tokens || 0) * pout);
}

/* ============================================================
   Schemas — constrain the model's output so neither this worker
   nor the frontend has to defend against malformed JSON.
   ============================================================ */

const TOPICS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["course", "topics"],
  properties: {
    course: { type: "string" },
    topics: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["name", "gist"],
        properties: { name: { type: "string" }, gist: { type: "string" } }
      }
    }
  }
};

const CARD_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["topic", "one_line", "hook", "everyday", "industry", "build_it", "if_it_vanished"],
  properties: {
    topic: { type: "string" },
    one_line: { type: "string" },
    hook: {
      type: "object", additionalProperties: false,
      required: ["question", "why_it_bites", "options", "hints", "reveal"],
      properties: {
        question: { type: "string" },
        why_it_bites: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            required: ["text", "correct", "note"],
            properties: { text: { type: "string" }, correct: { type: "boolean" }, note: { type: "string" } }
          }
        },
        hints: { type: "array", items: { type: "string" } },
        reveal: { type: "string" }
      }
    },
    everyday: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["title", "detail"],
        properties: { title: { type: "string" }, detail: { type: "string" } }
      }
    },
    industry: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["sector", "role", "how"],
        properties: { sector: { type: "string" }, role: { type: "string" }, how: { type: "string" } }
      }
    },
    build_it: {
      type: "object", additionalProperties: false,
      required: ["title", "needs", "steps"],
      properties: {
        title: { type: "string" },
        needs: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } }
      }
    },
    if_it_vanished: { type: "string" }
  }
};

/* ============================================================
   The prompt. This is the product — it encodes the method of two
   specific teachers.

   It carries a cache breakpoint, but whether that does anything is
   model-dependent: measured at ~1970 tokens under Sonnet 5's tokenizer it
   clears that model's 1024-token minimum and caches, while under Haiku 4.5
   (4096-token minimum) it silently does not. Output tokens dominate cost
   here either way, so this is a latency win more than a money one.
   ============================================================ */

const SYSTEM = `You design the opening five minutes of a lecture — the part almost every course skips.

Two teachers are your model.

The first taught trigonometry. Instead of opening with the identities, he asked the class to work out the height of the school building using nothing but a tape measure and the length of its shadow. The equation stopped being a thing to memorise and became a tool that answered a question the students actually now wanted answered.

The second taught thermodynamics. Before the lecture he asked: if you switch on an air conditioner in a sealed room, does the room get warmer or colder? Then: what if you run a fan instead? He refused to answer either. The class sat through the whole lecture holding those questions, and understood the material because they were hunting for something. At the end, he asked again — and this time they knew.

Your job, for one topic, is to build that opening.

THE HOOK is the centre of the card. It must:
- be answerable in one or two sentences, but not from intuition alone — the obvious answer should be wrong, or the right answer should feel surprising
- concern something physical, familiar, or observable, not a textbook abstraction
- be genuinely unresolvable without the concept being taught. If a student could reason it out with common sense, it is not a hook.
- never contain its own answer, or telegraph it

Write the hook the way that physics teacher spoke: plain, curious, slightly mischievous. No preamble, no "have you ever wondered", no "in this lecture we will".

OPTIONS: give three or four candidate answers. Exactly one is correct. The wrong ones must be tempting — they should be what a smart person actually says before they know better. Each option's note explains, in one sentence, why it is right or where the reasoning goes wrong.

HINTS: two or three, in order, each nudging further. A hint points at the thing to notice; it never states the conclusion.

REVEAL: the answer, and the moment where it connects to the named concept. Explain the mechanism, not just the verdict. Three to five sentences.

EVERYDAY: two or three places this concept is already acting on the student's life, today, whether they know it or not. Be concrete and specific — a named object or situation, not a category.

INDUSTRY: two or three places this is load-bearing in real work. Name the sector, name the actual job title that touches it, and say what that person concretely does with it — a calculation they run, a decision it settles, a failure it prevents. Never write "used in engineering" or "important in finance". If a specific well-known system depends on it, name the system.

BUILD_IT: a small thing the student can actually do this week to see the concept with their own eyes. It must be genuinely doable with a phone, a laptop, cheap materials, or free software. No lab equipment. Steps should be short and real.

IF_IT_VANISHED: one or two sentences on what visibly breaks in the world if humans had never worked this out. Concrete, not grand.

Write for the stated level. Be specific everywhere; specificity is the entire product. Never pad, never hedge, and never explain that something is important — show it.`;

/* ============================================================
   Small helpers
   ============================================================ */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const fail = (message, status) => json({ error: message }, status);

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

// Collapse whitespace and case so trivially different wordings share a cache
// entry. Deliberately conservative — it must not merge different courses.
const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

const utcDay = () => new Date().toISOString().slice(0, 10);
const utcMinute = () => new Date().toISOString().slice(0, 16);

/* ============================================================
   Rate limiting and the daily cap.

   KV is eventually consistent, so a burst of simultaneous requests can slip
   a few past a limit. That is an acceptable trade here: these are cost
   guardrails, not a security boundary, and being approximately right is
   enough to stop a shared link from draining an account.
   ============================================================ */

async function bumpCounter(kv, key, ttlSeconds) {
  const current = parseInt((await kv.get(key)) || "0", 10);
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

async function checkRateLimit(env, ip) {
  const perMinute = parseInt(env.RATE_LIMIT_PER_MINUTE || "40", 10);
  const perDay = parseInt(env.RATE_LIMIT_PER_DAY || "150", 10);

  const minuteCount = await bumpCounter(env.SPARK_KV, `rl:m:${ip}:${utcMinute()}`, 120);
  if (minuteCount > perMinute) {
    return "You're going a bit fast — wait a minute and try again.";
  }

  const dayCount = await bumpCounter(env.SPARK_KV, `rl:d:${ip}:${utcDay()}`, 60 * 60 * 25);
  if (dayCount > perDay) {
    return "You've hit today's limit for this site. The sample courses still work.";
  }

  return null;
}

/* Spend is metered in microdollars (1e-6 USD) from the usage each call
   reports, against two ceilings: a lifetime cap (the prepaid balance you are
   willing to burn) and a per-day cap (so one bad day can't drain the lot).

   Checked before a call and recorded after it. A call already in flight can
   therefore carry the total slightly past a cap — with a worst case of one
   card, a few cents, that is the right trade against making every request
   wait on a write. */
const readMicros = async (kv, key) => parseInt((await kv.get(key)) || "0", 10);

async function budgetState(env) {
  const totalCap = Math.round(parseFloat(env.MAX_SPEND_USD_TOTAL || "20") * 1e6);
  const dayCap   = Math.round(parseFloat(env.MAX_SPEND_USD_DAY   || "5")  * 1e6);
  const [total, today] = await Promise.all([
    readMicros(env.SPARK_KV, "spend:total"),
    readMicros(env.SPARK_KV, `spend:${utcDay()}`)
  ]);
  return { total, today, totalCap, dayCap,
           okay: total < totalCap && today < dayCap,
           exhausted: total >= totalCap };
}

async function recordSpend(env, micros) {
  if (!micros) return;
  const dayKey = `spend:${utcDay()}`;
  const [total, today] = await Promise.all([
    readMicros(env.SPARK_KV, "spend:total"),
    readMicros(env.SPARK_KV, dayKey)
  ]);
  await Promise.all([
    env.SPARK_KV.put("spend:total", String(total + micros)),
    env.SPARK_KV.put(dayKey, String(today + micros), { expirationTtl: 60 * 60 * 25 })
  ]);
}

/* ============================================================
   Claude
   ============================================================ */

/* One call. Returns the parsed value plus what it cost in microdollars.
   `effort` is dropped for models that reject it (Haiku). */
async function callOnce(env, { model, user, schema, maxTokens, effort }) {
  const output_config = { format: { type: "json_schema", schema } };
  if (effort && supportsEffort(model)) output_config.effort = effort;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      // Array form so the prompt can carry a cache breakpoint. The system
      // prompt is byte-identical on every request, so the first call writes
      // the cache and the rest read it at ~10% of input price.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config,
      messages: [{ role: "user", content: user }]
    })
  });

  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = (j.error && j.error.message) || ""; } catch (_) {}
    // Never forward the upstream body to the browser — it can echo request
    // details. Log it for the operator, return something generic.
    console.error("anthropic error", res.status, detail);
    if (res.status === 429) throw new Error("The service is busy right now — try again shortly.");
    if (res.status === 401) throw new Error("This site's API key is misconfigured.");
    throw new Error("The generator failed on that request.");
  }

  const data = await res.json();

  // Safety classifiers can decline a request: HTTP 200 with stop_reason "refusal".
  if (data.stop_reason === "refusal") throw new Error("The model declined that request.");

  // Adaptive thinking shares max_tokens with the answer, so a topic the model
  // chews on for a long time can run out of room mid-JSON. Measured: this hits
  // roughly 1 card in 8 at effort "medium". Flagged for the caller to retry.
  if (data.stop_reason === "max_tokens") {
    const err = new Error("That topic produced too much output.");
    err.truncated = true;
    throw err;
  }

  // Thinking blocks precede text on this model, so never index content[0].
  const block = (data.content || []).find(b => b.type === "text");
  if (!block) throw new Error("Empty response from the model.");

  const micros = costMicros(model, data.usage);
  console.log(JSON.stringify({
    msg: "usage", model,
    in: data.usage && data.usage.input_tokens,
    out: data.usage && data.usage.output_tokens,
    cache_write: data.usage && data.usage.cache_creation_input_tokens,
    cache_read: data.usage && data.usage.cache_read_input_tokens,
    usd: (micros / 1e6).toFixed(5)
  }));

  return { value: JSON.parse(block.text), micros };
}

/* Retries a truncated generation once at low effort, which cuts thinking spend
   and reliably leaves room for the JSON. The first attempt's cost still counts
   against the budget — it was really spent. */
async function callClaude(env, opts) {
  try {
    return await callOnce(env, opts);
  } catch (err) {
    if (!err.truncated || opts.effort === "low") throw err;
    console.log(JSON.stringify({ msg: "retrying truncated generation at low effort" }));
    const retry = await callOnce(env, { ...opts, effort: "low" });
    return { ...retry, micros: retry.micros + (err.micros || 0) };
  }
}

/* ============================================================
   Handlers
   ============================================================ */

const LEVELS = new Set([
  "High school",
  "Undergraduate — intro",
  "Undergraduate — advanced",
  "Graduate"
]);

function readCommon(body) {
  const level = LEVELS.has(body.level) ? body.level : "Undergraduate — intro";
  const course = String(body.course || "").slice(0, 200);
  return { level, course };
}

async function handleTopics(env, body) {
  const syllabus = String(body.syllabus || "").slice(0, 20000);
  if (syllabus.trim().length < 20) {
    return fail("That syllabus is too short to read.", 400);
  }
  const { level, course } = readCommon(body);

  const key = `topics:${await sha256(normalize(syllabus) + "|" + level)}`;
  const hit = await env.SPARK_KV.get(key, "json");
  if (hit) return json({ ...hit, cached: true });

  const budget = await budgetState(env);
  if (!budget.okay) {
    return fail(budget.exhausted
      ? "This site has used up its generation budget. The sample courses still work."
      : "This site has hit its daily generation limit. The sample courses still work.", 503);
  }

  const user =
    "Here is a course syllabus. Pull out the distinct teachable concepts — the things a lecture " +
    "would actually be built around. Skip administrivia: grading policy, office hours, textbook " +
    "lists, exam dates, attendance rules. Aim for the 8 most substantial concepts, fewer if the " +
    "course is small. For each, give a short name and a one-sentence gist of what it covers.\n\n" +
    (course ? "Course: " + course + "\n" : "") +
    "Level: " + level + "\n\nSYLLABUS:\n" + syllabus;

  // Topic extraction is mechanical parsing, so it runs on the cheap model.
  const { value: parsed, micros } = await callClaude(env, {
    model: env.MODEL_TOPICS || "claude-haiku-4-5",
    user, schema: TOPICS_SCHEMA, maxTokens: 4000, effort: "low"
  });
  await recordSpend(env, micros);

  const result = { course: parsed.course, topics: (parsed.topics || []).slice(0, 8) };
  if (!result.topics.length) return fail("Couldn't find any teachable topics in that text.", 422);

  await env.SPARK_KV.put(key, JSON.stringify(result), { expirationTtl: CARD_TTL_SECONDS });
  return json({ ...result, cached: false });
}

async function handleSpark(env, body) {
  const topic = body.topic || {};
  const name = String(topic.name || "").slice(0, 300);
  const gist = String(topic.gist || "").slice(0, 1000);
  if (!name) return fail("No topic given.", 400);

  const { level, course } = readCommon(body);

  // Keyed on the topic, not the syllabus — so two students whose syllabi are
  // worded differently but cover the same concept share one generated card.
  const key = `cards:${await sha256(normalize(name) + "|" + normalize(gist) + "|" + level)}`;
  const hit = await env.SPARK_KV.get(key, "json");
  if (hit) return json({ card: hit, cached: true });

  const budget = await budgetState(env);
  if (!budget.okay) {
    return fail(budget.exhausted
      ? "This site has used up its generation budget. The sample courses still work."
      : "This site has hit its daily generation limit. The sample courses still work.", 503);
  }

  const user =
    "Build the opening for this topic.\n\n" +
    "TOPIC: " + name + "\n" +
    "WHAT IT COVERS: " + gist + "\n" +
    (course ? "COURSE: " + course + "\n" : "") +
    "LEVEL: " + level;

  // The card is the product, so it runs on the better model.
  const { value: card, micros } = await callClaude(env, {
    model: env.MODEL_CARDS || "claude-sonnet-5",
    user, schema: CARD_SCHEMA, maxTokens: 16000, effort: env.CARD_EFFORT || "medium"
  });
  await recordSpend(env, micros);

  await env.SPARK_KV.put(key, JSON.stringify(card), { expirationTtl: CARD_TTL_SECONDS });
  return json({ card, cached: false });
}

/* ============================================================
   Entry point
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return fail("Use POST.", 405);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return fail("This site isn't configured with an API key yet. The sample courses still work.", 503);
    }

    // Same-origin only. The frontend ships from this same Worker, so no CORS
    // headers are needed — and omitting them stops other sites from building
    // on this deployment's budget.
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== url.host) {
          return fail("Cross-origin requests are not allowed.", 403);
        }
      } catch (_) {
        return fail("Bad origin header.", 403);
      }
    }

    let body;
    try { body = await request.json(); }
    catch (_) { return fail("Expected a JSON body.", 400); }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const limited = await checkRateLimit(env, ip);
    if (limited) return fail(limited, 429);

    try {
      if (url.pathname === "/api/topics") return await handleTopics(env, body);
      if (url.pathname === "/api/spark") return await handleSpark(env, body);
      return fail("Unknown endpoint.", 404);
    } catch (err) {
      console.error("handler error", err && err.stack ? err.stack : err);
      return fail(err.message || "Something went wrong.", 502);
    }
  }
};
