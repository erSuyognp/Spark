#!/usr/bin/env node
/**
 * Cache pre-seeder.
 *
 * Generates Spark Cards ahead of time and writes them into KV, so a visitor
 * pasting a covered syllabus gets an instant cached response instead of
 * waiting ~30s per card and spending your balance during the demo.
 *
 * It imports the Worker's own key derivation (src/keys.js), so a seeded entry
 * is guaranteed to be found by the running Worker. It also lifts the prompt
 * and model choices out of the Worker and wrangler.toml rather than copying
 * them, so seeded cards are identical to live ones.
 *
 *   node scripts/seed.mjs --dir seed --dry-run    # plan only, spends nothing
 *   node scripts/seed.mjs --dir seed --budget 5   # generate, stop at $5
 *
 * Needs ANTHROPIC_API_KEY in the environment. Read once, never logged, never
 * written to disk.
 */
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { topicsKey, cardKey, galleryKey } from "../src/keys.js";

const run = promisify(execFile);

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes("--" + n);

const DIR    = arg("dir", "seed");
const LEVEL  = arg("level", "Undergraduate — intro");
const BUDGET = parseFloat(arg("budget", "5"));
const CONC   = parseInt(arg("concurrency", "3"), 10);
const DRY    = has("dry-run");

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY && !DRY) {
  console.error("ANTHROPIC_API_KEY is not set. Export it, or pass --dry-run.");
  process.exit(1);
}

// Config comes from wrangler.toml so there is a single source of truth.
const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const cfg = (k, d) => (toml.match(new RegExp("^" + k + '\\s*=\\s*"([^"]+)"', "m")) || [, d])[1];
const NAMESPACE    = cfg("id");
const MODEL_TOPICS = cfg("MODEL_TOPICS", "claude-haiku-4-5");
const MODEL_CARDS  = cfg("MODEL_CARDS", "claude-sonnet-5");
const EFFORT       = cfg("CARD_EFFORT", "medium");

const PRICES = { "claude-opus-5": [5, 25], "claude-sonnet-5": [2, 10], "claude-haiku-4-5": [1, 5] };

// The prompt is lifted from the Worker so seeded cards match live ones exactly.
const workerSrc = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const SYSTEM = workerSrc.match(/const SYSTEM = `([\s\S]*?)`;\r?\n/)[1];

const S = (p) => ({ type: "object", additionalProperties: false, required: Object.keys(p), properties: p });
const STR = { type: "string" };
const TOPICS_SCHEMA = S({ course: STR, topics: { type: "array", items: S({ name: STR, gist: STR }) } });
const CARD_SCHEMA = S({
  topic: STR, one_line: STR,
  hook: S({
    question: STR, why_it_bites: STR,
    options: { type: "array", items: S({ text: STR, correct: { type: "boolean" }, note: STR }) },
    hints: { type: "array", items: STR }, reveal: STR
  }),
  everyday: { type: "array", items: S({ title: STR, detail: STR }) },
  industry: { type: "array", items: S({ sector: STR, role: STR, how: STR }) },
  build_it: S({ title: STR, needs: { type: "array", items: STR }, steps: { type: "array", items: STR } }),
  if_it_vanished: STR
});

let spentMicros = 0;
const usd = (m) => "$" + (m / 1e6).toFixed(4);

async function call(model, user, schema, maxTokens, effort, thinking) {
  const output_config = { format: { type: "json_schema", schema } };
  if (effort && !model.startsWith("claude-haiku")) output_config.effort = effort;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model, max_tokens: maxTokens,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config, ...(thinking ? { thinking } : {}),
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 150));
  const data = await res.json();

  const u = data.usage || {};
  const [pin, pout] = PRICES[model] || PRICES["claude-sonnet-5"];
  spentMicros += Math.round(
    ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 +
      (u.cache_read_input_tokens || 0) * 0.1) * pin + (u.output_tokens || 0) * pout);

  if (data.stop_reason === "refusal") throw new Error("model declined");
  if (data.stop_reason === "max_tokens") { const e = new Error("truncated"); e.truncated = true; throw e; }
  return JSON.parse(data.content.find((b) => b.type === "text").text);
}

// The same three-rung fallback the Worker uses for truncated generations.
async function callWithFallback(model, user, schema, maxTokens, effort) {
  const rungs = [[effort, null], ["low", null], ["low", { type: "disabled" }]];
  for (let i = 0; i < rungs.length; i++) {
    try { return await call(model, user, schema, maxTokens, rungs[i][0], rungs[i][1]); }
    catch (e) { if (!e.truncated || i === rungs.length - 1) throw e; }
  }
}

// wrangler refreshes its OAuth token lazily, so the first call after a while
// can fail with a transient "Authentication error [code: 10000]". Retry once.
async function existingKeys() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await run("npx", ["wrangler", "kv", "key", "list",
        "--namespace-id=" + NAMESPACE, "--remote"], { shell: true, maxBuffer: 64 << 20 });
      return new Set(JSON.parse(stdout).map((k) => k.name));
    } catch (e) {
      if (attempt === 1) throw new Error("could not list KV keys: " + String(e.message).slice(0, 120));
      console.log("   (KV listing failed, retrying once - usually a token refresh)");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function bulkPut(entries) {
  const path = "./.seed-bulk.json";
  await writeFile(path, JSON.stringify(entries.map((e) => ({
    key: e.key, value: JSON.stringify(e.value), expiration_ttl: 60 * 60 * 24 * 30
  }))));
  try {
    await run("npx", ["wrangler", "kv", "bulk", "put", path,
      "--namespace-id=" + NAMESPACE, "--remote"], { shell: true, maxBuffer: 64 << 20 });
  } finally { await unlink(path).catch(() => {}); }
}

async function pool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx]); }
  }));
}

const files = (await readdir(new URL("../" + DIR + "/", import.meta.url)))
  .filter((f) => f.endsWith(".txt")).sort();
if (!files.length) { console.error("No .txt syllabi found in " + DIR + "/"); process.exit(1); }

console.log("Seeding from " + DIR + "/  (" + files.length + " syllabi)");
console.log("  topics: " + MODEL_TOPICS + "   cards: " + MODEL_CARDS + " @ " + EFFORT);
console.log("  level:  " + LEVEL);
console.log("  budget: $" + BUDGET.toFixed(2) + (DRY ? "   [DRY RUN - no API calls, no uploads]" : ""));
console.log("");

const already = DRY ? new Set() : await existingKeys();
const entries = [];
let made = 0, skipped = 0, failed = 0, stopped = false;

for (const f of files) {
  if (stopped) break;
  const syllabus = await readFile(new URL("../" + DIR + "/" + f, import.meta.url), "utf8");
  console.log(f);

  if (DRY) { console.log("   would parse topics, then generate one card per topic\n"); continue; }

  const tKey = await topicsKey(syllabus, LEVEL);
  let parsed;
  try {
    parsed = await callWithFallback(MODEL_TOPICS,
      "Here is a course syllabus. Pull out the distinct teachable concepts - the things a lecture " +
      "would actually be built around. Skip administrivia: grading policy, office hours, textbook " +
      "lists, exam dates, attendance rules. Aim for the 8 most substantial concepts, fewer if the " +
      "course is small. For each, give a short name and a one-sentence gist of what it covers.\n\n" +
      "Level: " + LEVEL + "\n\nSYLLABUS:\n" + syllabus,
      TOPICS_SCHEMA, 4000, "low");
  } catch (e) { console.log("   FAILED to parse: " + e.message + "\n"); failed++; continue; }

  const topics = (parsed.topics || []).slice(0, 8);
  entries.push({ key: tKey, value: { course: parsed.course, topics } });
  // Publish to the Discover gallery. Only the course name and topic list —
  // never the syllabus text itself.
  entries.push({
    key: await galleryKey(parsed.course, LEVEL),
    value: { course: parsed.course, level: LEVEL,
             topics: topics.map((t) => ({ name: t.name, gist: t.gist })), createdAt: Date.now() }
  });
  console.log("   " + topics.length + " topics   (" + usd(spentMicros) + " so far)");

  await pool(topics, CONC, async (t) => {
    if (stopped) return;
    const key = await cardKey(t.name, t.gist, LEVEL);
    if (already.has(key)) { console.log("   - skip (already cached)  " + t.name); skipped++; return; }
    if (spentMicros / 1e6 >= BUDGET) {
      if (!stopped) console.log("   ! budget of $" + BUDGET.toFixed(2) + " reached - stopping");
      stopped = true; return;
    }
    try {
      const card = await callWithFallback(MODEL_CARDS,
        "Build the opening for this topic.\n\nTOPIC: " + t.name +
        "\nWHAT IT COVERS: " + t.gist + "\nCOURSE: " + parsed.course + "\nLEVEL: " + LEVEL,
        CARD_SCHEMA, 16000, EFFORT);
      entries.push({ key, value: card });
      made++;
      console.log("   - ok   " + usd(spentMicros).padStart(9) + "  " + t.name);
    } catch (e) { failed++; console.log("   - FAIL  " + t.name + ": " + e.message); }
  });
  console.log("");
}

if (DRY) { console.log("Dry run complete - nothing generated, nothing spent."); process.exit(0); }

if (entries.length) {
  console.log("Uploading " + entries.length + " KV entries...");
  await bulkPut(entries);
  console.log("Uploaded.\n");
}

console.log("=".repeat(60));
console.log("cards generated: " + made + "   skipped: " + skipped + "   failed: " + failed);
console.log("spent this run:  " + usd(spentMicros));
console.log("=".repeat(60));
