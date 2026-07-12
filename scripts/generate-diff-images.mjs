#!/usr/bin/env node
// Techsplains step 2 — source the visuals per segment. "Did you know" slots
// try a stock VIDEO clip first (Pexels Videos — moving visuals beat a static
// card). Photo slots go REAL PHOTOS first: Openverse (CC photos from
// Flickr/Wikimedia — the "actual photo of the actual thing" look) → Pexels
// stock → Vertex image gen as the last resort. All source logic lives in
// lib/image-sourcing.mjs (shared with the PDF course pipeline).
//
// Usage:
//   PEXELS_API_KEY=... node scripts/generate-diff-images.mjs <scripts.json>
//
// Writes media to public/generated-diff/<stamp>/ and adds aImg/bImg (or
// aVideo for clips) to each segment in the JSON, in place. CC BY photo
// credits are appended to the video's Facebook caption automatically.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { stockImage, genImage, openverseImage, stockVideo, configureImageGcp } from "./lib/image-sourcing.mjs";
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";

const { client: CLIENT_ID, rest: imgArgs } = takeClientArg(process.argv.slice(2));
// Point the vision-gate + image-gen at THIS client's GCP (Techsplains isolated,
// Tranzzie = shared/Jurie). Without this a Tranzzie batch would source on the
// Techsplains project. Techsplains resolves to the same project as before.
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
configureImageGcp({ project: cfg.gcp.project, imageLocation: cfg.gcp.imageLocation, apply: cfg.applyGcpEnv });
const scriptsArg = imgArgs[0];
if (!scriptsArg) {
  console.error("Usage: node scripts/generate-diff-images.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

// Batch stamp from the scripts filename so all steps share one folder name.
const stamp = stampFromScriptsPath(scriptsPath);
const relDir = path.posix.join("generated-diff", stamp);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const CONCURRENCY = parseInt(process.env.TECHSPLAINS_IMG_CONCURRENCY || "1", 10);
// "auto" (default) = stock-first with AI fallback (unchanged for Techsplains).
// "ai" = skip stock entirely and generate every slot (lets a brand pick a
// consistent look — e.g. flat-vector or photoreal product renders — via
// DIFF_IMAGE_STYLE_TAIL).
const IMAGE_SOURCE = (process.env.DIFF_IMAGE_SOURCE || "auto").toLowerCase();

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
  `Sourcing ${jobs.length} visual(s) — stock video (DYK) → Openverse real photos → Pexels${PEXELS_KEY ? "" : " (NO PEXELS KEY)"} → image-gen fallback…`,
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
    const existingRel =
      job.side === "a" ? job.s.aVideo || job.s.aImg : job.s.bImg;
    if (existingRel) {
      try {
        await fs.access(path.join(projectRoot, "public", existingRel));
        done++;
        console.log(`  [${done + failed}/${jobs.length}] SKIP ${base} (already sourced)`);
        continue;
      } catch { /* file gone — regenerate */ }
    }
    try {
      // Source order: stock video (DYK slots) → Openverse → Pexels → AI.
      let rel;
      let source = "";

      // "Did you know" videos get a MOVING visual when one exists.
      if (IMAGE_SOURCE !== "ai" && job.v.variant === "didyouknow") {
        try {
          const clip = await stockVideo(
            job.query || label, label, usedIds, path.join(absDir, `${base}.mp4`),
          );
          if (clip) {
            rel = path.posix.join(relDir, `${base}.mp4`);
            job.s.aVideo = rel;
            job.s.aVideoDurationSec = clip.durationSec;
            source = "pexels-video";
          }
        } catch (err) {
          console.warn(`    stock video failed (${String(err.message || err).slice(0, 60)})`);
        }
      }

      if (!source) {
        const stockOut = path.join(absDir, `${base}.jpg`);
        // Stock sourcing (real photos) is skipped in "ai" mode.
        if (IMAGE_SOURCE !== "ai") {
          try {
            const ov = await openverseImage(job.query || label, label, otherLabel, usedIds, stockOut);
            if (ov) {
              source = "openverse";
              if (ov.credit) job.s[job.side === "a" ? "aCredit" : "bCredit"] = ov.credit;
            }
          } catch (err) {
            console.warn(`    openverse failed (${String(err.message || err).slice(0, 60)})`);
          }
          if (!source) {
            try {
              if (await stockImage(job.query || label, label, otherLabel, usedIds, stockOut))
                source = "pexels";
            } catch (err) {
              console.warn(`    pexels search failed (${String(err.message || err).slice(0, 60)})`);
            }
          }
        }
        if (source) {
          rel = path.posix.join(relDir, `${base}.jpg`);
        } else {
          await genImage(job.prompt, path.join(absDir, `${base}.png`), fallback);
          rel = path.posix.join(relDir, `${base}.png`);
          source = "AI";
        }
        job.s[job.side === "a" ? "aImg" : "bImg"] = rel;
      }
      done++;
      console.log(`  [${done + failed}/${jobs.length}] ${path.posix.basename(rel)} [${source}]  (${job.v.title} — ${label})`);
    } catch (err) {
      failed++;
      console.warn(`  [${done + failed}/${jobs.length}] FAILED ${base}: ${String(err.message || err).slice(0, 140)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// DYK slideshow: build s.media (up to DIFF_DYK_MEDIA images) from the script's
// mediaPrompts so the "did you know" card cross-fades through several visuals
// instead of showing one static frame. The primary aImg becomes media[0]; the
// extra distinct beats are generated here. Skipped when a stock VIDEO was used
// (that path stays a moving clip) or when no mediaPrompts were provided.
const DYK_MEDIA_MAX = Math.max(1, parseInt(process.env.DIFF_DYK_MEDIA || "3", 10));
for (let vi = 0; vi < videos.length; vi++) {
  const v = videos[vi];
  if (v.variant !== "didyouknow") continue;
  const s = v.segments[0];
  // In "ai" mode the image slideshow always wins. Otherwise, keep a stock VIDEO
  // clip (aVideo) as-is and skip the slideshow.
  if (!s || (s.aVideo && IMAGE_SOURCE !== "ai")) continue;
  const prompts = Array.isArray(s.mediaPrompts) ? s.mediaPrompts.filter((p) => p && p.trim()) : [];
  if (!prompts.length) continue;
  // Generate every slide FRESH from mediaPrompts — do NOT reuse s.aImg, because
  // the director QC step (which runs after this) may re-source/replace aImg and
  // leave a media[] entry pointing at a deleted file.
  const media = [];
  for (let k = 0; k < prompts.length && media.length < DYK_MEDIA_MAX; k++) {
    const base = `${String(vi + 1).padStart(2, "0")}-1a-m${k + 1}`;
    const rel = path.posix.join(relDir, `${base}.png`);
    const abs = path.join(absDir, `${base}.png`);
    try {
      await fs.access(abs); // resume: reuse an already-generated slide
      media.push(rel);
      continue;
    } catch { /* generate below */ }
    const fallback =
      `clean minimal flat illustration for "${v.title}" (a ${v.category} explainer): ${prompts[k]}. ` +
      `Single centered subject, friendly and clear, no text.`;
    try {
      await genImage(prompts[k], abs, fallback);
      media.push(rel);
      console.log(`  slideshow ${base} [AI]  (${v.title})`);
    } catch (err) {
      console.warn(`  slideshow ${base} FAILED: ${String(err.message || err).slice(0, 80)}`);
    }
  }
  if (media.length) s.media = media;
}

// Photo attribution: CC BY / BY-SA images legally require credit, so it rides
// in the Facebook caption. Credits live on the segments (aCredit/bCredit) so
// quota-starved reruns don't lose or duplicate them — the caption's credit
// line is rebuilt from scratch every run.
for (const v of videos) {
  const credits = [
    ...new Set(v.segments.flatMap((s) => [s.aCredit, s.bCredit]).filter(Boolean)),
  ];
  v.caption = (v.caption || "").replace(/\n*📷[^\n]*$/u, "").trimEnd();
  if (credits.length) v.caption += `\n\n📷 ${credits.join(" · ")}`;
}

await fs.writeFile(scriptsPath, JSON.stringify(videos, null, 2));
console.log(`\n✓ ${done}/${jobs.length} image(s) → public/${relDir}`);
if (failed) console.log(`  (${failed} failed — render step will skip incomplete videos)`);
