# Spark

**The first five minutes your lectures are missing.**

Paste a course syllabus. Get, for every topic, a question you can't stop thinking about —
with the answer deliberately withheld — followed by where that idea is quietly running the
world.

🔗 **Live:** https://fun-professor.er-suyognp.workers.dev
*No sign-up, no API key, nothing to install. Three sample courses run instantly.*

Built for the **PathFinder's Challenge** · Category 01 — Degree Planning & Discovery

---

## The problem

Every syllabus tells you *what* you'll cover and *when* the exam is. Almost none of them tell
you **why any of it matters**.

Two teachers changed how I think about that.

The first taught trigonometry. Instead of opening with the identities, he asked us to work
out the height of the school building using nothing but a tape measure and the length of its
shadow. The equation stopped being a thing to memorise and became a tool that answered a
question we now actually wanted answered.

The second taught thermodynamics. Before the lecture he asked: *if you switch on an air
conditioner in a sealed room, does the room get warmer or colder? What if you run a fan
instead?* He refused to answer either. We sat through the whole lecture holding those
questions — and understood the material, because we were hunting for something. At the end
he asked again, and this time we knew.

That gap is the entire product. Spark reconstructs those five minutes for any syllabus.

## What it produces

Real output from the live site, for a topic in an optics course:

> **Take a clear glass rod and drop it into a glass of water — you can still see its outline
> clearly. Now drop the same rod into a jar of ordinary vegetable cooking oil. It vanishes, as
> if the glass simply isn't there anymore. The glass didn't dissolve, melt, or change colour.
> What actually happened to it?**
>
> - The oil absorbs all the light before it reaches your eye
> - ✅ The glass and the oil have nearly the same refractive index, so light doesn't bend or reflect at their boundary
> - The oil dissolves a thin invisible layer of the glass surface, smoothing it
> - Vegetable oil is naturally more transparent than water

…and under **where it pays the bills**:

> **Gemology** — *Gemologist certifying stones*
> Immerses an unknown stone in a liquid of known refractive index and watches whether its
> outline disappears — exactly the trick above — to authenticate the mineral. This is a
> standard bench test.

Each card carries seven parts: the hook, tempting wrong answers, progressive hints, the
reveal, where it already touches your life, where it pays the bills, a build-it-this-week
experiment, and what breaks in the world if nobody had worked it out.

## The one design decision that matters

**Everything stays locked until you commit to a guess.**

The reveal, the applications, the industry uses — all hidden until you pick an option or
explicitly skip. That isn't a UI flourish; it's the physics teacher's method encoded. A
question you've *answered wrong* is one you want the answer to. A question with the answer
printed underneath is just more text.

There's also a **lecture mode** that projects the hook full-screen with the answer hidden, so
a teacher can do exactly what mine did.

## How it works

```
syllabus text
     │
     ▼
POST /api/topics ──────► claude-haiku-4-5      strips grading policy, office hours,
     │                   (cheap, mechanical)    textbook lists → clean topic list
     ▼
POST /api/spark  ──────► claude-sonnet-5       one call per topic, 3 concurrent,
  (per topic)            (quality matters)      JSON-schema constrained
     │
     ▼
  KV cache (30 days, keyed by TOPIC)  ──►  cards stream into the page as they land
```

Two models on purpose: parsing a syllabus is mechanical, so it runs on the cheap model; the
card *is* the product, so it runs on the better one.

**The cache is keyed by topic, not by syllabus.** Two students whose syllabi are worded
completely differently but both cover "the second law of thermodynamics" share one generated
card. Courses repeat enormously — that single decision is what makes this affordable.

### Stack

| | |
|---|---|
| Frontend | One HTML file, ~1,200 lines. No framework, no build step. |
| Backend | One Cloudflare Worker, ~500 lines. |
| Storage | Cloudflare KV. |
| Models | `claude-haiku-4-5` (parsing) + `claude-sonnet-5` (cards) |

```
public/index.html          the whole frontend
src/index.js               the Worker: API, caching, spend caps, rate limits
src/keys.js                cache-key derivation, shared by Worker and seeder
scripts/seed.mjs           pre-generate cards so demos are instant and free
scripts/check-secrets.sh   run before every push
test/worker.test.html      70 assertions, Anthropic call stubbed
seed/                      syllabi to pre-generate, one .txt per course
```

## What it costs — measured, not estimated

Every number here came from real runs against the live API.

| | Model | Measured |
|---|---|---|
| Parse a syllabus into topics | `claude-haiku-4-5` | $0.0030 |
| One card | `claude-sonnet-5` @ medium | $0.019 – $0.031 |
| **A full 8-topic syllabus** | | **$0.1747** |

**$25 ≈ 140 fresh syllabi**, plus unlimited cached repeats.

### Why not run everything on the cheap model

Same topic, same prompt. Haiku's "correct" option read:

> *"Air molecules bumping the pieces make reassembly vanishingly unlikely; a movie of the
> shattering played backward would show the pieces moving in a pattern no random collisions
> would ever produce."*

That gives the answer away inside the option — the one thing the prompt forbids. Sonnet's:
*"It isn't forbidden — it's just spectacularly improbable."*

On the industry section Haiku wrote *"Servers dissipate heat — lots of it."* Sonnet wrote
*"tracks entropy generation across each tray of the distillation column, then redesigns
reflux ratios to cut steam costs at a refinery."*

Specificity is the whole product, so the default spends 2.5× for it. Set
`MODEL_CARDS = "claude-haiku-4-5"` in `wrangler.toml` and judge for yourself.

## Pre-seeding (do this before a demo)

Generating a card live takes ~30s and costs ~$0.022. Serving a cached one takes under half a
second and costs nothing. So generate ahead of time:

```bash
node scripts/seed.mjs --dir seed --dry-run
```

```bash
node scripts/seed.mjs --dir seed --budget 5
```

Drop one `.txt` per course into `seed/` — paste the syllabus verbatim, administrivia
included; the parser strips it.

**Measured:** 11 cards across 2 courses for **$0.4582**, zero failures. Afterwards, pasting a
covered syllabus into the live site returned **8/8 cards from cache in 3.8s total** instead of
~240s, at **$0.00** to the visitor.

The seeder imports the Worker's own `src/keys.js` and lifts the prompt straight out of
`src/index.js`, so seeded entries are guaranteed to be found and identical to live ones. It
skips anything already cached, so re-running is cheap.

`--budget` is approximate: requests already in flight finish, so a $0.40 budget stopped at
$0.4582 with three concurrent workers. Set it slightly under what you mean.

## Setup

Free tier is enough: 100k Worker requests/day, 1k KV writes/day.

> **`npm` not found?** Install Node.js (`winget install OpenJS.NodeJS.LTS` on Windows), then
> **open a new terminal** — an existing shell keeps its old `PATH` and will still say "npm is
> not recognised" even though the install succeeded.
>
> npm 11+ also blocks the `esbuild` and `workerd` postinstall scripts by default, and
> `workerd` is the Workers runtime. This repo records the approval in `package.json` under
> `allowScripts`, so a fresh `npm install` handles it.

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler kv namespace create SPARK_KV
```

Paste the printed `id` into `[[kv_namespaces]]` in `wrangler.toml`, then:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

```bash
npx wrangler deploy
```

You also need to register a **workers.dev subdomain** once, in the Cloudflare dashboard under
Compute (Workers) → Workers & Pages. Without it the deploy succeeds but produces no public URL.

> Setting the secret by piping rather than typing? Use `echo`, not `printf '%s'`. Without a
> trailing newline wrangler stores a mangled value and you get a 401 that looks exactly like
> a bad key.

## Guardrails

Spend is metered in microdollars from the token usage each response actually reports — not
estimated from averages — against two ceilings.

| Var | Default | Meaning |
|---|---|---|
| `MAX_SPEND_USD_TOTAL` | `20` | Lifetime cap across the deployment |
| `MAX_SPEND_USD_DAY` | `5` | Per-day cap |
| `RATE_LIMIT_PER_MINUTE` | `40` | Per IP (one syllabus ≈ 9 requests) |
| `RATE_LIMIT_PER_DAY` | `150` | Per IP |
| `MODEL_TOPICS` / `MODEL_CARDS` | haiku / sonnet | See the cost table |
| `CARD_EFFORT` | `medium` | Ignored on Haiku, which rejects the parameter |

Past a cap the API returns a friendly 503 and the site falls back to its pre-written samples.
Cached cards keep serving after the budget is gone — the caps meter misses only.

## Security

The API key is **never** in this repository. It lives in Cloudflare's encrypted secret store
and is readable only by the running Worker. A static host could not do this — which is why
there's a Worker at all rather than plain GitHub Pages.

- `.gitignore` blocks `.dev.vars`, `.env`, `*.key`, `*.pem`
- `scripts/check-secrets.sh` fails if key material reaches the working tree; it works before
  `git init` and is tested against a planted key
- The API is same-origin only, so another site can't point its frontend at this deployment
  and spend its budget
- The `id` under `[[kv_namespaces]]` is **not** a secret — Cloudflare's own docs commit it

```bash
bash scripts/check-secrets.sh
```

## Tests

```bash
python -m http.server 8791
```

Open `http://localhost:8791/test/worker.test.html` — **70 assertions** against the real
`src/index.js` with `fetch` and KV stubbed. `localhost` matters: the tests need a secure
context for `crypto.subtle` and a real origin for ES module imports.

Covered: routing and validation, cache keying and hits, dollar caps, per-IP limits, the
truncation fallback ladder, and that an upstream error body is never forwarded to the browser.

## Known behaviour

- **Intermittent truncation, handled.** Adaptive thinking shares `max_tokens` with the answer,
  so a card occasionally runs out of room mid-JSON — observed at roughly 1 in 5, and
  stochastic rather than topic-specific. The Worker walks a three-rung ladder: configured
  effort → `low` → `low` with thinking disabled, where output is bounded and cannot truncate.
  Truncated attempts are still billed, because they really do burn their full `max_tokens` — a
  failure costs more than a success.
- **Caps are approximate.** KV is eventually consistent and in-flight requests finish, so a
  burst can carry spend slightly past a cap. These are cost guardrails, not a security
  boundary; Cloudflare's native rate-limiting binding is the upgrade if you need exactness.
- **Limits are per IP**, so a campus behind one NAT shares a bucket. Raise
  `RATE_LIMIT_PER_DAY` for an institutional deployment.
- **Prompt caching is model-dependent and fails silently.** The system prompt clears Sonnet 5's
  1024-token minimum but not Haiku 4.5's 4096-token one. Output dominates cost here anyway, so
  it's a latency win more than a money one.

## Roadmap

- Seed a full course catalogue so nearly every paste is instant
- Let students save and share a card set for a course
- A teacher view that exports lecture openers straight to slides
- Difficulty calibration from which options students actually pick

## Local development

```bash
cp .dev.vars.example .dev.vars   # paste your key into .dev.vars (gitignored)
```

```bash
npx wrangler dev
```

The sample courses need none of this — open `public/index.html` directly and all three run
fully offline.

---

*For every teacher who asked the question before giving the answer.*
