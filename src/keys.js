/**
 * Cache-key derivation, shared by the Worker and the seeder script.
 *
 * These two must agree byte-for-byte or seeded entries are simply never
 * found — a silent, expensive failure. Keeping one implementation and
 * importing it from both places removes any chance of drift.
 *
 * Web Crypto is global in both Workers and Node 18+, so this file runs
 * unmodified in either.
 */

/** Collapse case and whitespace so trivially different wordings share a key.
 *  Deliberately conservative: it must never merge genuinely different courses. */
export const normalize = (s) =>
  String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** First 40 hex chars of SHA-256 — plenty to avoid collisions, short enough
 *  to keep KV keys readable. */
export async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

/** A parsed topic list, keyed by the syllabus text it came from. */
export const topicsKey = async (syllabus, level) =>
  `topics:${await sha256(normalize(syllabus) + "|" + level)}`;

/** A generated card, keyed by the TOPIC rather than the syllabus — so two
 *  students whose syllabi are worded differently but cover the same concept
 *  share one card. This is what makes pre-seeding worthwhile. */
export const cardKey = async (name, gist, level) =>
  `cards:${await sha256(normalize(name) + "|" + normalize(gist) + "|" + level)}`;

/** A public gallery entry, keyed by course name so regenerating the same course
 *  updates one entry instead of filling the gallery with near-duplicates.
 *
 *  Note what a gallery entry deliberately does NOT contain: the raw syllabus
 *  text a visitor pasted. Syllabi carry instructor names, section numbers, and
 *  sometimes the student's own details. Only the model-generated course name and
 *  topic list are published. */
export const galleryKey = async (course, level) =>
  `gallery:${await sha256(normalize(course) + "|" + level)}`;
