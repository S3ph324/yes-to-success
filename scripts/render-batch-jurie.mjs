#!/usr/bin/env node
// Multi-client poster renderer (JurieQuoteCard composition) → client export
// folder for manual posting. Client-aware via config/clients.json. John
// Calub's render-batch.mjs is separate and untouched.
//
// Usage:
//   node scripts/render-batch-jurie.mjs [--client id] <quotes.json>
// Env:
//   JURIE_EXPORT_DIR  - override the client export folder

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import {
  projectRoot,
  resolveClient,
  takeClientArg,
} from "./lib/client.mjs";

const { client: clientArg, rest } = takeClientArg(process.argv.slice(2));
const client = await resolveClient(clientArg);

const quotesArg = rest[0];
if (!quotesArg) {
  console.error(
    "Usage: node scripts/render-batch-jurie.mjs [--client id] <quotes.json>",
  );
  process.exit(1);
}
const quotesPath = path.isAbsolute(quotesArg)
  ? quotesArg
  : path.join(process.cwd(), quotesArg);
const quotes = JSON.parse(await fs.readFile(quotesPath, "utf-8"));

const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;

// Client brand preset.
let preset = null;
try {
  const presets = JSON.parse(
    await fs.readFile(
      path.join(projectRoot, "config", "brand-presets.json"),
      "utf-8",
    ),
  );
  preset =
    presets.find((p) => p.id === client.brandPresetId) ||
    presets.find((p) => p.client === client.id) ||
    null;
} catch {
  /* fall back to component defaults */
}

// Per-run override from the dashboard "Include logo" checkbox.
const NO_LOGO = process.env.DASHBOARD_NO_LOGO === "1";

// Poster style — locked to "cinematic" (the proven style) for now.
// The flat/split variants are disabled pending further polish; this keeps
// the dashboard option removed from view AND immune to any stale env var.
const POSTER_STYLES = ["cinematic"];

// ── Aspect-ratio distribution ─────────────────────────────────────────────
// Dashboard "Aspect ratio mix" lets the user pick e.g. 1:1 25% / 4:5 50% /
// 9:16 25% and have the batch split that way instead of being all 4:5.
// DASHBOARD_ASPECT_DIST is a JSON string like {"1:1":25,"4:5":50,"9:16":25}.
// Builds a length-N array of ratios, proportionally rounded (largest-
// remainder method) and interleaved so same-ratio posters don't cluster.
const ASPECT_RATIOS = ["1:1", "4:5", "9:16"];
function buildAspectPlan(distRaw, n) {
  let dist = null;
  try {
    dist = JSON.parse(distRaw || "");
  } catch {
    /* not set / malformed — fall through to null */
  }
  if (!dist || typeof dist !== "object") return null;
  const entries = Object.entries(dist).filter(
    ([k, v]) => ASPECT_RATIOS.includes(k) && Number(v) > 0,
  );
  if (!entries.length) return null;
  const total = entries.reduce((a, [, v]) => a + Number(v), 0);
  if (total <= 0) return null;
  const raw = entries.map(([k, v]) => [k, (Number(v) / total) * n]);
  const buckets = raw.map(([k, r]) => ({ k, count: Math.floor(r), rem: r - Math.floor(r) }));
  let assigned = buckets.reduce((a, b) => a + b.count, 0);
  buckets
    .slice()
    .sort((a, b) => b.rem - a.rem)
    .forEach((b) => {
      if (assigned < n) {
        b.count += 1;
        assigned += 1;
      }
    });
  // Interleave: always pull from whichever bucket has the most remaining,
  // so a 25/50/25 split reads roughly 4:5,1:1,4:5,9:16,4:5,1:1,4:5,9:16…
  const out = [];
  const live = buckets.map((b) => ({ k: b.k, remaining: b.count }));
  for (let i = 0; i < n; i++) {
    live.sort((a, b) => b.remaining - a.remaining);
    const pick = live.find((b) => b.remaining > 0);
    if (!pick) break;
    pick.remaining -= 1;
    out.push(pick.k);
  }
  return out;
}
const ASPECT_PLAN = buildAspectPlan(process.env.DASHBOARD_ASPECT_DIST, quotes.length);
if (ASPECT_PLAN) {
  const tally = {};
  ASPECT_PLAN.forEach((r) => (tally[r] = (tally[r] || 0) + 1));
  console.log(
    "Aspect ratio mix: " +
      Object.entries(tally).map(([k, v]) => `${k}×${v}`).join("  "),
  );
}

const brand = {
  brandGold: preset?.brandAccent || "#F5C13B",
  brandGoldLight: "#FFE27A",
  brandGoldDeep: preset?.brandAccentDeep || "#C7902A",
  brandRed: preset?.brandPrimary || "#E11522",
  logoSrc: NO_LOGO ? "" : preset?.logoSrc || "",
  logoPosition: preset?.logoPosition || "top-center",
  logoSize:
    typeof preset?.logoSize === "number" ? preset.logoSize : 0.10,
  ctaComment: preset?.ctaComment || "MENTOR",
  ctaTail: preset?.ctaTail || "LEARN MORE",
};

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

console.log(`Rendering ${quotes.length} ${client.label} poster(s)…`);
console.log("Bundling Remotion project (one-time)…");
const t0 = Date.now();
const bundleLocation = await bundle({
  entryPoint: path.join(projectRoot, "src", "index.ts"),
  webpackOverride: (c) => c,
});
console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const exportDir = path.join(EXPORT_DIR, stamp);
await fs.mkdir(exportDir, { recursive: true });

// Clean up old working-copy cache to prevent ENOSPC on container disk.
const cardsRoot = path.join(projectRoot, "out", "cards");
try {
  const oldDirs = await fs.readdir(cardsRoot);
  for (const d of oldDirs) {
    fs.rm(path.join(cardsRoot, d), { recursive: true, force: true }).catch(() => {});
  }
} catch { /* out/cards may not exist — skip */ }

let i = 0;
let failed = 0;
for (const q of quotes) {
  i += 1;
  // Assign style round-robin: quote 1 → styles[0], quote 2 → styles[1], etc.
  const posterStyle = POSTER_STYLES[(i - 1) % POSTER_STYLES.length];
  // Aspect ratio: dashboard distribution wins over whatever the content step
  // wrote (it always defaults to 4:5); falls back to per-quote/4:5 if unset.
  const aspectRatio = ASPECT_PLAN ? ASPECT_PLAN[i - 1] : (q.aspectRatio || "4:5");
  const slug = slugify(q.quote || `poster-${i}`);
  const styleSuffix = POSTER_STYLES.length > 1 ? `_${posterStyle}` : "";
  const fname = `${client.id}-${String(i).padStart(2, "0")}-${slug}${styleSuffix}.png`;
  const outPath = path.join(exportDir, fname); // render directly to export — no intermediate copy
  const inputProps = {
    topLines: q.topLines || [],
    bottomLines: q.bottomLines || [],
    quote: q.quote || "",
    keyword: (q.keyword || "").toUpperCase(),
    ctaComment: (q.ctaComment || brand.ctaComment).toUpperCase(),
    ctaTail: q.ctaTail || brand.ctaTail,
    useCta: q.useCta !== false,
    bgSrc: q.bgPath || "",
    aspectRatio,
    brandGold: brand.brandGold,
    brandGoldLight: brand.brandGoldLight,
    brandGoldDeep: brand.brandGoldDeep,
    brandRed: brand.brandRed,
    logoSrc: brand.logoSrc,
    logoPosition: brand.logoPosition,
    logoSize: brand.logoSize,
    headlineFont: "",
    posterStyle,
  };
  try {
    const tStart = Date.now();
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: "JurieQuoteCard",
      inputProps,
    });
    await renderStill({
      composition,
      serveUrl: bundleLocation,
      output: outPath,
      inputProps,
      imageFormat: "png",
      frame: 60,
    });
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`  [${i}/${quotes.length}] ${fname}  (${dt}s)`);
  } catch (err) {
    failed += 1;
    console.warn(
      `  [${i}/${quotes.length}] FAILED ${fname}: ${err.message?.slice(0, 120) || err}`,
    );
  }
}

// Contact-sheet gallery + captions file for manual posting.
const rows = quotes
  .map((q, idx) => {
    const style = POSTER_STYLES[idx % POSTER_STYLES.length];
    const styleSuffix = POSTER_STYLES.length > 1 ? `_${style}` : "";
    const slug = slugify(q.quote || `poster-${idx + 1}`);
    const fn = `${client.id}-${String(idx + 1).padStart(2, "0")}-${slug}${styleSuffix}.png`;
    const cap = (q.caption || "").replace(/</g, "&lt;");
    return `<figure><img src="./${fn}"/><figcaption><b>#${idx + 1}</b><br>${cap.replace(/\n/g, "<br>")}</figcaption></figure>`;
  })
  .join("\n");
const html = `<!doctype html><meta charset="utf-8"><title>${client.label} posters ${stamp}</title>
<style>body{background:#111;color:#eee;font-family:system-ui;margin:24px}
h1{font-size:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px}
figure{margin:0;background:#1c1c1c;border-radius:8px;overflow:hidden}
img{width:100%;display:block}figcaption{padding:10px 12px;font-size:13px;line-height:1.4;color:#bbb}</style>
<h1>${client.label} — ${quotes.length} posters — ${stamp}</h1>
<p>Posters + captions for manual posting. Files also in: ${exportDir}</p>
<div class="grid">${rows}</div>`;
await fs.writeFile(path.join(exportDir, "gallery.html"), html);
await fs.writeFile(
  path.join(exportDir, "captions.txt"),
  quotes
    .map((q, idx) => `#${idx + 1}\n${q.caption || ""}\n${"-".repeat(40)}\n`)
    .join("\n"),
);

console.log(
  `\n✓ ${quotes.length - failed}/${quotes.length} poster(s)\n` +
    `  Client export  : ${exportDir}\n` +
    `  Review         : ${path.join(exportDir, "gallery.html")}`,
);
if (failed > 0) console.log(`  (${failed} failed — see warnings)`);

// ── Disk cleanup: delete generated backgrounds + quotes JSON ─────────────
// Background PNGs are now baked into the rendered posters — no longer needed.
// Quotes JSON is also done. Wipe both to recover container disk space.
console.log("Cleaning up temp files…");
const bgRoot = path.join(projectRoot, "public", "generated-bg");
try {
  // Delete background images for this batch
  const usedBgDirs = new Set(
    quotes.map(q => q.bgPath ? path.dirname(path.join(projectRoot, "public", q.bgPath)) : null)
      .filter(Boolean)
  );
  for (const dir of usedBgDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  // Also sweep ANY remaining generated-bg subdirs (from crashed/failed previous runs)
  const remaining = await fs.readdir(bgRoot).catch(() => []);
  for (const sub of remaining) {
    await fs.rm(path.join(bgRoot, sub), { recursive: true, force: true }).catch(() => {});
  }
} catch { /* ignore */ }

// Delete the quotes JSON file (it lives in out/ and is no longer needed)
fs.rm(quotesPath, { force: true }).catch(() => {});

// Sweep any old JSON files from out/ (from previous crashed runs)
try {
  const outFiles = await fs.readdir(path.join(projectRoot, "out"));
  for (const f of outFiles) {
    if (f.endsWith(".json") || f.endsWith(".txt"))
      fs.rm(path.join(projectRoot, "out", f), { force: true }).catch(() => {});
  }
} catch { /* ignore */ }
console.log("Cleanup done.");
