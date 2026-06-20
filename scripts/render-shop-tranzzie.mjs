#!/usr/bin/env node
// TikTok-Shop product-listing renderer (Tranzzie). Takes a SERIES of real
// product photos the user uploaded and composites Tranzzie-branded carousel
// cards over them — deterministic, no AI image generation (the product is
// never redrawn). Brand-safe copy only: no competitor trademarks, and specs
// are stated as features, never cures or guarantees.
//
// Inputs (env, set by the dashboard /api/generate-shop handler):
//   DASHBOARD_SHOP_PHOTOS    JSON array of absolute paths to product photos
//   DASHBOARD_SHOP_SPECS     JSON array of spec ids (anti_rad/uv400/…)
//   DASHBOARD_SHOP_PRODUCT   product / model name (e.g. "Aria")
//   DASHBOARD_SHOP_COLOR     colour label (e.g. "Black / Gold")
//   DASHBOARD_SHOP_MATERIAL  material / finish label (e.g. "Lightweight Metal")
//   DASHBOARD_SHOP_ASPECT    "1:1" | "4:5" | "9:16"  (TikTok Shop = 1:1 default)
//   JURIE_EXPORT_DIR         output folder (per-client export dir)
//
// Output: <export>/<stamp>/  — 5 cards (hero, studio, variant, detail, specs)
//   + gallery.html + captions.txt (brand-safe product description).

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot, resolveClient } from "./lib/client.mjs";

process.on("unhandledRejection", (r) => { console.error("[shop] unhandledRejection:", r?.stack || r?.message || String(r)); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("[shop] uncaughtException:", e?.stack || e?.message || String(e)); process.exit(1); });

const client = await resolveClient("tranzzie");

// ── Inputs ───────────────────────────────────────────────────────────────
const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const photos = parseJson(process.env.DASHBOARD_SHOP_PHOTOS, []).filter(Boolean);
const VALID_SPECS = ["anti_rad", "uv400", "photochromic", "polarized", "anti_glare", "anti_scratch"];
const specs = parseJson(process.env.DASHBOARD_SHOP_SPECS, []).filter((s) => VALID_SPECS.includes(s));
const productName = (process.env.DASHBOARD_SHOP_PRODUCT || "").trim().slice(0, 40);
const colorLabel = (process.env.DASHBOARD_SHOP_COLOR || "").trim().slice(0, 30);
const materialLabel = (process.env.DASHBOARD_SHOP_MATERIAL || "").trim().slice(0, 30);
const aspect = ["1:1", "4:5", "9:16"].includes(process.env.DASHBOARD_SHOP_ASPECT) ? process.env.DASHBOARD_SHOP_ASPECT : "1:1";

if (!photos.length) { console.error("No product photos provided — upload at least one."); process.exit(1); }

// ── Brand preset (colours + logo) ────────────────────────────────────────
let preset = null;
try {
  const PERSIST = process.env.PERSIST_BASE || projectRoot;
  const presets = JSON.parse(await fs.readFile(path.join(PERSIST, "config", "brand-presets.json"), "utf-8").catch(() =>
    fs.readFile(path.join(projectRoot, "config", "brand-presets.json"), "utf-8")));
  preset = presets.find((p) => p.id === "preset_tranzzie") || presets.find((p) => p.client === "tranzzie") || null;
} catch { /* component defaults */ }
const brandGold = preset?.brandAccent || "#F4B400";
const brandRed = preset?.brandPrimary || "#E11522";
// Established/subtitle tag from the brand preset (e.g. "SINCE 2019") — configurable,
// never hardcoded in the card. Empty hides it.
const establishedTag = (preset?.subtitle || "").trim();
// Studio trust pills — overridable via DASHBOARD_SHOP_PILLS; default avoids any
// specific returns/policy claim that may not match the seller's terms.
let shopPills = [];
try { shopPills = JSON.parse(process.env.DASHBOARD_SHOP_PILLS || "[]"); } catch { shopPills = []; }
if (!Array.isArray(shopPills) || !shopPills.length) shopPills = ["Premium Build", "Fashion Forward", "Everyday Comfort"];
shopPills = shopPills.map((p) => String(p).slice(0, 24)).slice(0, 3);

// Logo variants: white-lettering on dark cards, dark-lettering on light cards.
// Both resolved relative to public/ (staticFile) when present.
const publicDir = path.join(projectRoot, "public");
const existsRel = async (rel) => { try { await fs.access(path.join(publicDir, rel)); return rel; } catch { return ""; } };
const logoSrc = preset?.logoSrc ? await existsRel(preset.logoSrc) : await existsRel("brand/tranzzie-logo.png");
const logoDarkSrc = await existsRel("brand/tranzzie-logo-dark.png");

// ── Stage uploaded photos under public/ so staticFile() can resolve them ──
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const stageRel = path.posix.join("_shop-input", stamp);
const stageDir = path.join(publicDir, stageRel);
await fs.mkdir(stageDir, { recursive: true });
const staged = [];
for (let i = 0; i < photos.length; i++) {
  const ext = (path.extname(photos[i]) || ".png").toLowerCase();
  const rel = path.posix.join(stageRel, `photo-${String(i + 1).padStart(2, "0")}${ext}`);
  try {
    await fs.copyFile(photos[i], path.join(publicDir, rel));
    staged.push(rel);
  } catch (e) {
    console.warn(`  skip photo ${i + 1}: ${e.message}`);
  }
}
if (!staged.length) { console.error("Could not stage any uploaded photos."); process.exit(1); }

// ── Card plan ─────────────────────────────────────────────────────────────
// 4 photo cards + 1 spec card. Photos cycle if fewer than 4 were uploaded.
const photoAt = (i) => staged[i % staged.length];
const plan = [
  { cardType: "hero",    photoSrc: photoAt(0) },
  { cardType: "studio",  photoSrc: photoAt(1) },
  { cardType: "variant", photoSrc: photoAt(2) },
  { cardType: "detail",  photoSrc: photoAt(3) },
  { cardType: "specs",   photoSrc: "" },
];

const featureLine = materialLabel ? `${materialLabel} build for everyday wear.` : "Built for everyday wear.";

// ── Render ─────────────────────────────────────────────────────────────────
const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;
const exportDir = path.join(EXPORT_DIR, stamp);
await fs.mkdir(exportDir, { recursive: true });

console.log(`Rendering ${plan.length} Tranzzie shop card(s) for "${productName || "product"}"…`);
console.log("Bundling Remotion project (one-time)…");
const t0 = Date.now();
const bundleLocation = await bundle({ entryPoint: path.join(projectRoot, "src", "index.ts"), webpackOverride: (c) => c });
console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const slug = (productName || "product").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "product";
let failed = 0;
for (let i = 0; i < plan.length; i++) {
  const p = plan[i];
  const fname = `tranzzie-${String(i + 1).padStart(2, "0")}-${slug}_${p.cardType}.png`;
  const outPath = path.join(exportDir, fname);
  const inputProps = {
    photoSrc: p.photoSrc,
    cardType: p.cardType,
    specs,
    productName,
    colorLabel,
    materialLabel,
    featureLine,
    brandName: client.label || "Tranzzie Eyeglasses",
    establishedTag,
    pills: shopPills,
    logoSrc,
    logoDarkSrc,
    brandGold,
    brandRed,
    aspectRatio: aspect,
  };
  try {
    const tStart = Date.now();
    const composition = await selectComposition({ serveUrl: bundleLocation, id: "ShopListingCard", inputProps });
    await renderStill({ composition, serveUrl: bundleLocation, output: outPath, inputProps, imageFormat: "png", frame: 40 });
    console.log(`  [${i + 1}/${plan.length}] ${fname}  (${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.warn(`  [${i + 1}/${plan.length}] FAILED ${fname}: ${(err.message || err)?.toString().slice(0, 140)}`);
  }
}

// ── Brand-safe product description (captions.txt, one block per card) ──────
const specLabels = { anti_rad: "blue-light filtering", uv400: "100% UV protection", photochromic: "light-adaptive lenses", polarized: "polarized clarity", anti_glare: "anti-glare coating", anti_scratch: "scratch-resistant coating" };
const specPhrase = specs.map((s) => specLabels[s]).filter(Boolean).join(", ");
const desc =
  `${productName || "New Arrival"} — ${client.label || "Tranzzie Eyeglasses"}\n` +
  (materialLabel ? `${materialLabel}` : "") + (colorLabel ? `${materialLabel ? " · " : ""}${colorLabel}` : "") + "\n" +
  (specPhrase ? `Features: ${specPhrase}.\n` : "") +
  `Lightweight, everyday eyewear. Free 15-day returns.\n` +
  `Shop now on TikTok. #Tranzzie #Eyeglasses #BlueLightGlasses`;
await fs.writeFile(path.join(exportDir, "captions.txt"),
  plan.map((p, i) => `#${i + 1} (${p.cardType})\n${i === 0 ? desc : ""}\n${"-".repeat(40)}\n`).join("\n"));

// ── Contact-sheet gallery ─────────────────────────────────────────────────
const rows = plan.map((p, i) => {
  const fname = `tranzzie-${String(i + 1).padStart(2, "0")}-${slug}_${p.cardType}.png`;
  return `<figure><img src="./${fname}"/><figcaption><b>#${i + 1}</b> ${p.cardType}</figcaption></figure>`;
}).join("\n");
await fs.writeFile(path.join(exportDir, "gallery.html"),
  `<!doctype html><meta charset="utf-8"><title>Tranzzie shop cards ${stamp}</title>` +
  `<style>body{background:#111;color:#eee;font-family:system-ui;margin:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}figure{margin:0;background:#1c1c1c;border-radius:8px;overflow:hidden}img{width:100%;display:block}figcaption{padding:9px 11px;font-size:13px;color:#bbb}</style>` +
  `<h1>Tranzzie — ${plan.length} shop cards — ${stamp}</h1><div class="grid">${rows}</div>`);

console.log(`\n✓ ${plan.length - failed}/${plan.length} card(s)\n  Export : ${exportDir}\n  Review : ${path.join(exportDir, "gallery.html")}`);
if (failed) console.log(`  (${failed} failed — see warnings)`);

// ── Cleanup staged input photos ───────────────────────────────────────────
await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});

process.exit(failed >= plan.length ? 1 : 0);
