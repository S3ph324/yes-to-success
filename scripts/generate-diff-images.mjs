#!/usr/bin/env node
// Techsplains step 2/4 — source the two comparison images per segment
// (4 per video). REAL STOCK PHOTOS first (Pexels search on the script's
// searchQuery — the user rejected AI-rendered examples); Vertex image gen
// (gemini-2.5-flash-image) only as the fallback when the stock search misses.
//
// Usage:
//   PEXELS_API_KEY=... node scripts/generate-diff-images.mjs <scripts.json>
//
// Writes images to public/generated-diff/<stamp>/ and adds aImg/bImg (paths
// relative to public/) to each segment in the JSON, in place.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./lib/client.mjs";
import { stockImage, genImage } from "./lib/image-sourcing.mjs";

const scriptsArg = process.argv[2];
if (!scriptsArg) {
  console.error("Usage: node scripts/generate-diff-images.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

// Batch stamp from the scripts filename so all steps share one folder name.
const stamp =
  scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] ||
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const relDir = path.posix.join("generated-diff", stamp);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const CONCURRENCY = parseInt(process.env.TECHSPLAINS_IMG_CONCURRENCY || "1", 10);

// Flatten all slots, run with bounded concurrency (same idea as poster-batch).
const jobs = [];
videos.forEach((v, vi) => {
  v.segments.forEach((s, si) => {
    jobs.push({ v, s, vi, si, side: "a", prompt: s.aImagePrompt, query: s.aSearchQuery });
    // "didyouknow" segments are single-image: no B side.
    if (s.bLabel) jobs.push({ v, s, vi, si, side: "b", prompt: s.bImagePrompt, query: s.bSearchQuery });
  });
});

console.log(
  `Sourcing ${jobs.length} comparison image(s) — Pexels stock${PEXELS_KEY ? "" : " (NO KEY)"} → image-gen fallback…`,
);
let done = 0;
let failed = 0;
let cursor = 0;
const usedByVideo = new Map();
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const base = `${String(job.vi + 1).padStart(2, "0")}-${job.si + 1}${job.side}`;
    const label = job.side === "a" ? job.s.aLabel : job.s.bLabel;
    const otherLabel = job.side === "a" ? job.s.bLabel : job.s.aLabel;
    if (!usedByVideo.has(job.vi)) usedByVideo.set(job.vi, new Set());
    const usedIds = usedByVideo.get(job.vi);
    // Context matters: without it the model illustrates the WORD, not the
    // concept — "Thunderbolt" (the port) came back as a storm cloud. For
    // "general" videos the literal meaning IS the subject (frog, jam, moth),
    // so only steer away from it on tech categories.
    const fallback =
      `clean minimal flat illustration representing "${label}" in the context of ` +
      `"${job.v.title}" (a ${job.v.category} explainer video). ` +
      (job.v.category === "general"
        ? `Depict the everyday subject itself, literally and recognizably. `
        : `Depict the actual tech concept, never the literal/weather/food meaning of the word. `) +
      `Single centered subject, friendly and clear.`;
    // Resume support: a slot that already generated (path in JSON + file on
    // disk) is skipped, so quota-starved reruns only pay for the gaps.
    const existingRel = job.s[job.side === "a" ? "aImg" : "bImg"];
    if (existingRel) {
      try {
        await fs.access(path.join(projectRoot, "public", existingRel));
        done++;
        console.log(`  [${done + failed}/${jobs.length}] SKIP ${base} (already sourced)`);
        continue;
      } catch { /* file gone — regenerate */ }
    }
    try {
      // Source order: Pexels stock → AI generation.
      let rel;
      let source = "";
      const stockOut = path.join(absDir, `${base}.jpg`);
      try {
        if (await stockImage(job.query || label, label, otherLabel, usedIds, stockOut))
          source = "pexels";
      } catch (err) {
        console.warn(`    pexels search failed (${String(err.message || err).slice(0, 60)})`);
      }
      if (source) {
        rel = path.posix.join(relDir, `${base}.jpg`);
      } else {
        await genImage(job.prompt, path.join(absDir, `${base}.png`), fallback);
        rel = path.posix.join(relDir, `${base}.png`);
        source = "AI";
      }
      job.s[job.side === "a" ? "aImg" : "bImg"] = rel;
      done++;
      console.log(`  [${done + failed}/${jobs.length}] ${path.posix.basename(rel)} [${source}]  (${job.v.title} — ${label})`);
    } catch (err) {
      failed++;
      console.warn(`  [${done + failed}/${jobs.length}] FAILED ${base}: ${String(err.message || err).slice(0, 140)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await fs.writeFile(scriptsPath, JSON.stringify(videos, null, 2));
console.log(`\n✓ ${done}/${jobs.length} image(s) → public/${relDir}`);
if (failed) console.log(`  (${failed} failed — render step will skip incomplete videos)`);
