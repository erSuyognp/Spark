# Spark

Paste a course syllabus, get the opening five minutes your lectures are missing: a
counterintuitive question per topic with the answer withheld, then the real-world and
industry uses behind it.

Visitors need **no account, no API key, and nothing installed.** One Cloudflare Worker
serves both the site and the API; the key lives server-side as an encrypted secret.

```
public/index.html        the whole frontend — no build step, no framework
src/index.js             the Worker: /api/topics and /api/spark, caching, spend caps, rate limits
wrangler.toml            config; models and every limit are vars you can tune
test/worker.test.html    66 behaviour tests, Anthropic call stubbed
scripts/check-secrets.sh run before every push
```

## Security first — this is a public repo

The API key is **never** in this repository. It lives in Cloudflare's encrypted secret
store, set once with `wrangler secret put`, and is readable only by the running Worker.

- `.gitignore` blocks `.dev.vars`, `.env`, `*.key`, `*.pem`
- `.dev.vars.example` holds a placeholder; copy it to `.dev.vars` (gitignored) for local dev
- `scripts/check-secrets.sh` fails the build if a key ever reaches the working tree —
  it works before `git init`, and it is tested against a planted key
- The `id` under `[[kv_namespaces]]` is **not** a secret; Cloudflare's own docs commit it

```bash
bash scripts/check-secrets.sh
```

> **Rotate any key you have ever pasted into a chat window, an issue, or a screenshot.**
> Create a fresh one in the Console, `wrangler secret put` it, then revoke the old one.
> Rotation is the only thing that undoes an exposure.

## Deploy

Free tier is enough: 100k Worker requests/day, 1k KV writes/day.

> **`npm` not found?** Node.js ships wrangler's toolchain, so install it first
> (`winget install OpenJS.NodeJS.LTS` on Windows) — then **open a new terminal**.
> An already-open shell keeps its old `PATH` and will still say "npm is not
> recognised" even though Node installed correctly.
>
> npm 11+ also blocks `esbuild` and `workerd` postinstall scripts by default;
> `workerd` is the Workers runtime, so it is required. This repo records the
> approval in `package.json` under `allowScripts`, so a fresh `npm install`
> handles it. Approving manually: `npm approve-scripts workerd`.

```bash
npm install
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

That prints a live `https://spark.<your-subdomain>.workers.dev`. Watch live logs, including
a per-call `usd` figure:

```bash
npx wrangler tail
```

## What it actually costs — measured, not estimated

One real 8-topic ML syllabus, run end to end against the live API with the production
prompts:

| Stage | Model | Measured |
|---|---|---|
| Parse syllabus into topics | `claude-haiku-4-5` | $0.0030 |
| 8 cards | `claude-sonnet-5` @ effort medium | $0.019 – $0.031 each |
| **Whole syllabus** | | **$0.1747** |

**$25 buys roughly 143 fresh syllabi**, plus unlimited cached repeats. Going all-Haiku
(`MODEL_CARDS = "claude-haiku-4-5"`) drops it to about $0.09 a syllabus — roughly 280 —
at a real quality cost, below.

Two models on purpose: parsing a syllabus is mechanical, so it runs on the cheap model;
the card *is* the product, so it runs on the better one.

### Why not all-Haiku

Same topic (the second law of thermodynamics), same prompt. Haiku's correct option:

> *"Air molecules bumping the pieces make reassembly vanishingly unlikely; a movie of the
> shattering played backward would show the pieces moving in a pattern no random collisions
> would ever produce."*

That gives the answer away inside the option, which is the one thing the prompt forbids.
Sonnet's: *"It isn't forbidden — it's just spectacularly improbable."*

On the industry section, Haiku produced *"Servers dissipate heat — lots of it"*; Sonnet
produced *"tracks entropy generation across each tray of the distillation column, then
redesigns reflux ratios to cut steam costs at a refinery."* Specificity is the whole
product, so the default spends 2.5× for it. Switch models in `wrangler.toml` and judge
for yourself.

## Spend caps

Spend is metered in microdollars from the token usage each response actually reports —
not guessed from averages — against two ceilings:

| Var | Default | Meaning |
|---|---|---|
| `MAX_SPEND_USD_TOTAL` | `20` | Lifetime cap across the whole deployment |
| `MAX_SPEND_USD_DAY` | `5` | Per-day cap, so one bad day can't drain the rest |
| `RATE_LIMIT_PER_MINUTE` | `40` | Per IP; one syllabus is ~9 requests |
| `RATE_LIMIT_PER_DAY` | `150` | Per IP; ~15 syllabi per person per day |

Past a cap the API returns a friendly 503 and the site falls back to its three
pre-written sample courses, which never cost anything. Cached cards keep serving after
the budget is gone — the cap meters misses only.

Set `MAX_SPEND_USD_TOTAL` below your prepaid balance. With $25 on the key, `20` leaves
headroom for the caps being approximate (below).

## Why it stays cheap in practice

Courses repeat enormously — thousands of students take Intro Thermodynamics. Cards are
cached in KV for 30 days keyed by a hash of **the topic**, not the syllabus, so two
students whose syllabi are worded differently but cover the same concept share one
generated card. Hits cost nothing, don't count against the caps, and return instantly;
the UI marks them with ⚡.

The system prompt carries a `cache_control` breakpoint, but whether it does anything is
model-dependent, and the failure is silent. Measured: under Sonnet 5's tokenizer the
prefix is ~1970 tokens, clearing that model's 1024-token minimum, so it caches. Under
Haiku 4.5 (4096-token minimum) it does not. Either way output tokens are ~99% of the
bill here, so this is a latency win more than a money one.

## Known behaviour

- **Intermittent truncation, handled.** Sonnet 5's adaptive thinking shares `max_tokens`
  with the answer, so a card occasionally runs out of room mid-JSON — observed once in 8
  cards, and not reproducible per-topic. The Worker retries that card once at `low`
  effort, which reliably leaves room. If the retry also truncates, that one topic
  reports an error and the rest of the feed still renders.
- **Rate limiting is approximate.** KV is eventually consistent, so a burst can slip a
  few requests past a limit, and a call already in flight can carry spend slightly past a
  cap — worst case one card, a few cents. These are cost guardrails, not a security
  boundary. Cloudflare's native rate-limiting binding is the upgrade if you need exactness.
- **Limits are per IP**, so a campus behind one NAT shares a bucket. Raise
  `RATE_LIMIT_PER_DAY` if you deploy for a specific institution.
- The API is same-origin only, so another site can't point its frontend at your
  deployment and spend your balance.

## Tests

```bash
python -m http.server 8791
```

Open `http://localhost:8791/test/worker.test.html` — 66 assertions against the real
`src/index.js` with `fetch` and KV stubbed. `localhost` matters: the tests need a secure
context for `crypto.subtle` and a real origin for ES module imports.

Covered: routing and validation, cache hits and keying, dollar caps, per-IP limits, the
truncation retry, and that an upstream error body is never forwarded to the browser.

## Local development

```bash
cp .dev.vars.example .dev.vars   # then paste your key into .dev.vars
npx wrangler dev
```

The sample courses need none of this — open `public/index.html` directly and all three
run fully offline.
