#!/usr/bin/env node
/**
 * Backfill the Discover gallery from topic lists already in KV.
 *
 * The gallery was added after cards had already been generated, so those
 * courses had no gallery entry and Discover looked empty. This reads every
 * stored topic list and publishes a gallery entry for it.
 *
 * Safe to re-run: entries are keyed by course name, so re-running updates
 * rather than duplicating. Costs nothing — it makes no API calls.
 *
 *   node scripts/backfill-gallery.mjs --dry-run
 *   node scripts/backfill-gallery.mjs
 */
import { readFile, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { galleryKey } from "../src/keys.js";

const run = promisify(execFile);
const DRY = process.argv.includes("--dry-run");
const LEVEL = "Undergraduate — intro";

const toml = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const NAMESPACE = toml.match(/^id\s*=\s*"([^"]+)"/m)[1];

const kv = (args) =>
  run("npx", ["wrangler", "kv", ...args, "--namespace-id=" + NAMESPACE, "--remote"],
      { shell: true, maxBuffer: 64 << 20 });

const { stdout: listed } = await kv(["key", "list"]);
const topicKeys = JSON.parse(listed).map((k) => k.name).filter((n) => n.startsWith("topics:"));
console.log(`Found ${topicKeys.length} stored topic lists.\n`);

// Keyed by gallery key: two stored topic lists can resolve to the same course
// name, and the bulk API rejects a payload containing the same key twice.
const byKey = new Map();
for (const key of topicKeys) {
  let parsed;
  try {
    const { stdout } = await kv(["key", "get", key]);
    parsed = JSON.parse(stdout);
  } catch (e) {
    console.log(`  skip ${key} (unreadable)`);
    continue;
  }
  if (!parsed || !parsed.course || !parsed.topics || !parsed.topics.length) {
    console.log(`  skip ${key} (no course/topics)`);
    continue;
  }
  const gKey = await galleryKey(parsed.course, LEVEL);
  const dupe = byKey.has(gKey);
  console.log(`  ${parsed.course}  (${parsed.topics.length} topics)${dupe ? "  [merging duplicate course name]" : ""}`);
  // On a collision keep the richer topic list rather than whichever came last.
  if (dupe && byKey.get(gKey).value.topics.length >= parsed.topics.length) continue;
  byKey.set(gKey, {
    key: gKey,
    value: {
      course: parsed.course,
      level: LEVEL,
      // Only the model-generated course name and topics are published.
      topics: parsed.topics.map((t) => ({ name: t.name, gist: t.gist })),
      createdAt: Date.now()
    }
  });
}

const entries = [...byKey.values()];

if (DRY) {
  console.log(`\nDry run: would publish ${entries.length} gallery entries.`);
  process.exit(0);
}

if (!entries.length) { console.log("\nNothing to backfill."); process.exit(0); }

const file = "./.backfill-bulk.json";
await writeFile(file, JSON.stringify(entries.map((e) => ({
  key: e.key, value: JSON.stringify(e.value), expiration_ttl: 60 * 60 * 24 * 30
}))));
try {
  await kv(["bulk", "put", file]);
  console.log(`\nPublished ${entries.length} courses to Discover.`);
} finally {
  await unlink(file).catch(() => {});
}

// Drop the assembled gallery cache so the change shows immediately.
await kv(["key", "delete", "gallery-cache"]).catch(() => {});
console.log("Gallery cache cleared.");
