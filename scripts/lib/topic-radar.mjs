// Topic radar — the "what should we post about today" source.
//
// WHY NOT FACEBOOK: monitoring Facebook's general feed was tested and does not
// work. The home feed rendered 8 articles of which 2 were readable, and both
// were personal chatter rather than anything topical. Post search returned ONE
// result per query and would not paginate — 8 scrolls on "AI para sa business"
// and 10 on the deliberately broad "eyeglasses" both yielded a single post —
// and Facebook injects obfuscation characters through the text to defeat
// scrapers. On top of that the feed is algorithmically personal: it shows what
// Facebook thinks you want, not what is happening in a subject. Wrong
// instrument for the job.
//
// Web search returns dated, on-topic, paginated results with no login and no
// scraping, so the radar runs on findings gathered there instead.
//
// NOTE ON HOW THIS RUNS: web search is an assistant-side capability, not
// something a Node process can call. So the *gathering* is done by Claude in
// session and handed to recordFindings(); this module owns the durable part —
// dedupe against what has already been posted, ranking, and persistence. That
// split is also why the carousel is manual-trigger for now.

import fs from "node:fs/promises";
import path from "node:path";

export const VERTICALS = ["ai", "business", "eyewear"];

const radarPath = (persistBase, vertical) =>
  path.join(persistBase, "config", `topic-radar-${vertical}.json`);

const norm = (s) => String(s || "").toLowerCase().replace(/\W+/g, " ").trim();

async function readJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return fallback; }
}

/** Topics already turned into carousels, so the radar never re-suggests them. */
export async function coveredTopics(persistBase) {
  const ledger = await readJson(path.join(persistBase, "config", "jurie-topic-ledger.json"), []);
  return Array.isArray(ledger) ? ledger.map((e) => e.topic).filter(Boolean) : [];
}

/**
 * Merge newly gathered findings into a vertical's radar file.
 * @param {object}  o
 * @param {string}  o.vertical  one of VERTICALS
 * @param {Array}   o.findings  [{ angle, why, source }]
 *   angle  — the carousel-ready topic, in Jurie's terms not the source's
 *   why    — one line on why it matters to her audience
 *   source — where it came from, for her own fact-checking
 * @returns {Promise<{added:number, total:number, path:string}>}
 */
export async function recordFindings({ persistBase, vertical, findings = [] }) {
  if (!VERTICALS.includes(vertical)) throw new Error(`Unknown vertical "${vertical}".`);
  const p = radarPath(persistBase, vertical);
  const existing = await readJson(p, []);
  const list = Array.isArray(existing) ? existing : [];

  // Never re-suggest something already posted, or already sitting in the radar.
  const covered = new Set((await coveredTopics(persistBase)).map(norm));
  const present = new Set(list.map((e) => norm(e.angle)));

  const seenAt = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const f of findings) {
    const angle = String(f.angle || "").trim();
    if (!angle) continue;
    const k = norm(angle);
    if (covered.has(k) || present.has(k)) continue;
    present.add(k);
    list.unshift({ angle, why: String(f.why || "").trim(), source: String(f.source || "").trim(), seenAt, used: false });
    added++;
  }
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(list.slice(0, 300), null, 1));
  return { added, total: list.length, path: p };
}

/** Unused topic candidates, freshest first. */
export async function pending({ persistBase, vertical, limit = 20 }) {
  const list = await readJson(radarPath(persistBase, vertical), []);
  return (Array.isArray(list) ? list : []).filter((e) => !e.used).slice(0, limit);
}

/** Mark a candidate consumed once it has become a carousel. */
export async function markUsed({ persistBase, vertical, angle }) {
  const p = radarPath(persistBase, vertical);
  const list = await readJson(p, []);
  if (!Array.isArray(list)) return false;
  const k = norm(angle);
  let hit = false;
  for (const e of list) if (norm(e.angle) === k) { e.used = true; hit = true; }
  if (hit) await fs.writeFile(p, JSON.stringify(list, null, 1));
  return hit;
}
