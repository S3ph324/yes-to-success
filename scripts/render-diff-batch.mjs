#!/usr/bin/env node
// Techsplains step 4/4 — render each scripted video to MP4 (h264+aac) and
// export to the client folder with a review gallery + captions file.
//
// Usage:
//   node scripts/render-diff-batch.mjs <scripts.json>
//
// Videos missing their voiceover or any comparison image are skipped — a
// half-assembled video never ships (same rule as the poster pipeline).

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient, slugify } from "./lib/diff-config.mjs";
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";
import { compositionFor, posePropsFor } from "./lib/render-diff-helpers.mjs";
import { buildManifest } from "./lib/techsplains-manifest.mjs";

const { client: CLIENT_ID, rest: renderArgs } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
const scriptsArg = renderArgs[0];

if (!scriptsArg) {
  console.error("Usage: node scripts/render-diff-batch.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

const stamp = stampFromScriptsPath(scriptsPath);
const EXPORT_DIR = process.env.DIFF_EXPORT_DIR || process.env.TECHSPLAINS_EXPORT_DIR || cfg.exportDir;
const exportDir = path.join(EXPORT_DIR, stamp);
await fs.mkdir(exportDir, { recursive: true });

// All staticFile() assets (voice mp3s, comparison images, mascot poses, fonts)
// must exist BEFORE bundle() — the bundle snapshots public/ (learned the hard
// way on Railway). Audio/images steps ran before this script, so we're safe.
console.log("Bundling Remotion project (one-time)…");
const t0 = Date.now();
const bundleLocation = await bundle({
  entryPoint: path.join(projectRoot, "src", "index.ts"),
  webpackOverride: (c) => c,
});
console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const results = [];
let failed = 0;
let skipped = 0;
const poses = posePropsFor(cfg);

for (let vi = 0; vi < videos.length; vi++) {
  const v = videos[vi];
  const fname = `techsplains-${String(vi + 1).padStart(2, "0")}-${slugify(v.title)}.mp4`;

  const assetsOk =
    v.audio &&
    Array.isArray(v.phases) &&
    v.phases.length > 0 &&
    // Single-image ("did you know") segments have no B side by design, and
    // may carry a stock video CLIP (aVideo) instead of a still.
    v.segments.every((s) => (s.aImg || s.aVideo) && (s.bImg || !s.bLabel));
  if (!assetsOk) {
    skipped++;
    console.warn(`  [${vi + 1}/${videos.length}] SKIP ${v.title}: missing audio/images`);
    continue;
  }

  const inputProps = {
    segments: v.segments.map((s) => ({
      aLabel: s.aLabel,
      bLabel: s.bLabel,
      aImg: s.aImg || "",
      bImg: s.bImg || "",
      ...(s.aVideo
        ? { aVideo: s.aVideo, aVideoDurationSec: s.aVideoDurationSec || 8 }
        : {}),
    })),
    phases: v.phases,
    audioSrc: v.audio,
    durationSec: v.durationSec,
    handle: cfg.handle,
    accent: cfg.accent,
    poses,
  };

  try {
    const tStart = Date.now();
    // "Did you know" videos render on their own dark full-bleed template.
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: compositionFor(cfg.template, v.variant),
      inputProps,
    });
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      audioCodec: "aac",
      outputLocation: path.join(exportDir, fname),
      inputProps,
    });
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`  [${vi + 1}/${videos.length}] ${fname}  (${v.durationSec}s video, rendered in ${dt}s)`);
    results.push({ fname, v });
  } catch (err) {
    failed++;
    console.warn(`  [${vi + 1}/${videos.length}] FAILED ${fname}: ${String(err.message || err).slice(0, 160)}`);
  }
}

// Review gallery + captions for Buffer / manual posting.
const rows = results
  .map(
    ({ fname, v }, i) =>
      `<figure><video src="./${fname}" controls preload="metadata"></video>` +
      `<figcaption><b>#${i + 1} — ${v.title}</b><br>${(v.caption || "").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</figcaption></figure>`,
  )
  .join("\n");
const html = `<!doctype html><meta charset="utf-8"><title>${cfg.brandName} videos ${stamp}</title>
<style>body{background:#111;color:#eee;font-family:system-ui;margin:24px}
h1{font-size:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px}
figure{margin:0;background:#1c1c1c;border-radius:8px;overflow:hidden}
video{width:100%;display:block;aspect-ratio:9/16}figcaption{padding:10px 12px;font-size:13px;line-height:1.4;color:#bbb}</style>
<h1>${cfg.brandName} — ${results.length} video(s) — ${stamp}</h1>
<p>Review, then queue in Buffer. Files in: ${exportDir}</p>
<div class="grid">${rows}</div>`;
await fs.writeFile(path.join(exportDir, "gallery.html"), html);
await fs.writeFile(
  path.join(exportDir, "captions.txt"),
  results
    .map(({ v }, i) => `#${i + 1} — ${v.title}\n${v.caption || ""}\n${"-".repeat(40)}\n`)
    .join("\n"),
);
await fs.writeFile(
  path.join(exportDir, "manifest.json"),
  JSON.stringify(buildManifest(results), null, 2),
);

console.log(
  `\n✓ ${results.length}/${videos.length} video(s)\n` +
    `  Export : ${exportDir}\n` +
    `  Review : ${path.join(exportDir, "gallery.html")}`,
);
if (failed) console.log(`  (${failed} failed — see warnings)`);
if (skipped) console.log(`  (${skipped} skipped — incomplete assets)`);

// Cleanup: generated audio/images are baked into the MP4s now.
if (process.env.DIFF_KEEP_TEMP !== "1" && process.env.TECHSPLAINS_KEEP_TEMP !== "1") {
  await fs.rm(path.join(projectRoot, "public", "generated-diff", stamp), { recursive: true, force: true }).catch(() => {});
  await fs.rm(scriptsPath, { force: true }).catch(() => {});
  console.log("Cleanup done.");
}

process.exit(videos.length > 0 && results.length === 0 ? 1 : 0);
