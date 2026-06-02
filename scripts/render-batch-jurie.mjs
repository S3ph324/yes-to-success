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

// Poster style(s) to render — comma-separated from dashboard checkboxes.
// Distributed round-robin across quotes: "cinematic,flat" on 8 quotes → 4 each.
const POSTER_STYLES = (process.env.DASHBOARD_POSTER_STYLES || "cinematic")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => ["cinematic", "flat", "split"].includes(s));
if (!POSTER_STYLES.length) POSTER_STYLES.push("cinematic");

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
const outDir = path.join(projectRoot, "out", "cards", `${client.id}-${stamp}`);
const exportDir = path.join(EXPORT_DIR, stamp);
await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(exportDir, { recursive: true });

let i = 0;
let failed = 0;
for (const q of quotes) {
  i += 1;
  // Assign style round-robin: quote 1 → styles[0], quote 2 → styles[1], etc.
  const posterStyle = POSTER_STYLES[(i - 1) % POSTER_STYLES.length];
  const slug = slugify(q.quote || `poster-${i}`);
  const styleSuffix = POSTER_STYLES.length > 1 ? `_${posterStyle}` : "";
  const fname = `${client.id}-${String(i).padStart(2, "0")}-${slug}${styleSuffix}.png`;
  const outPath = path.join(outDir, fname);
  const inputProps = {
    topLines: q.topLines || [],
    bottomLines: q.bottomLines || [],
    quote: q.quote || "",
    keyword: (q.keyword || "").toUpperCase(),
    ctaComment: (q.ctaComment || brand.ctaComment).toUpperCase(),
    ctaTail: q.ctaTail || brand.ctaTail,
    useCta: q.useCta !== false,
    bgSrc: q.bgPath || "",
    aspectRatio: q.aspectRatio || "4:5",
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
    await fs.copyFile(outPath, path.join(exportDir, fname));
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
    const slug = slugify(q.quote || `poster-${idx + 1}`);
    const fn = `${client.id}-${String(idx + 1).padStart(2, "0")}-${slug}.png`;
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
    `  Working copies : ${outDir}\n` +
    `  Client export  : ${exportDir}\n` +
    `  Review         : ${path.join(exportDir, "gallery.html")}`,
);
if (failed > 0) console.log(`  (${failed} failed — see warnings)`);
