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
// Output: <export>/<stamp>/  — 5 cards (hero, front, studio, detail, specs)
//   + gallery.html + captions.txt (brand-safe product description).

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot, resolveClient } from "./lib/client.mjs";
import { generateShopScenes } from "./lib/shop-scenes.mjs";

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

// ── AI product-placement scenes ───────────────────────────────────────────
// Generate clean studio / lifestyle / dark close-up shots of the SAME frame
// from the uploaded reference photo(s), then the cards composite over those.
// Uploads are reference-only (never shown). If a scene hits the rate limit we
// reuse another GENERATED scene for that card; only a total failure aborts.
// Disable AI entirely with DASHBOARD_SHOP_NO_AI=1.
const sceneRelDir = path.posix.join("generated-shop", stamp);
// Each photo card maps to ONE generated scene. The uploaded photos are
// reference-only and are NEVER shown as a card — if a scene can't be generated
// the batch fails loudly (below) instead of falling back to the raw upload.
const CARD_SCENE = { hero: "clean", front: "front", studio: "life", detail: "dark" };
const sceneKeys = ["clean", "life", "dark", "front"];
const aiOn = process.env.DASHBOARD_SHOP_NO_AI !== "1";
let sceneRel = {};
if (aiOn) {
  applyGcpEnv();
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) { console.error("✗ No GOOGLE_CLOUD_PROJECT configured — cannot generate product scenes."); process.exit(1); }
  const outDir = path.join(publicDir, sceneRelDir);
  console.log(`Generating product-placement scenes of the frame (Gemini) in ${location}…`);

  const made = {};
  let lastErrors = [];
  // Two passes: an initial run, then a retry of just the scenes that failed
  // (handles transient image-model rate limits / blips without redoing the
  // ones that already succeeded).
  for (let pass = 1; pass <= 2; pass++) {
    const want = sceneKeys.filter((k) => !made[k]);
    if (!want.length) break;
    if (pass === 2) {
      console.log(`  rate limit hit — pausing, then retrying ${want.length} scene(s): ${want.join(", ")}…`);
      await new Promise((r) => setTimeout(r, 6000)); // let the rate limiter recover before pass 2
    }
    const { scenes, errors } = await generateShopScenes({
      refPaths: photos, project, location, outDir, keys: want, log: (m) => console.log(m),
    });
    Object.assign(made, scenes);
    lastErrors = errors;
  }

  const relOf = (k) => (made[k] ? path.posix.join(sceneRelDir, `${k}.png`) : "");

  // Every photo card needs a GENERATED scene — uploads are reference-only and
  // are never shown as a card. But don't waste a mostly-successful batch: if a
  // scene hit the rate limit, BORROW another generated scene for that card
  // (tone-aware: dark cards reuse a dark scene; the white front card prefers the
  // front scene). Only abort if NOTHING generated at all.
  const darkKeys = ["clean", "life", "dark"].filter((k) => made[k]); // dark-themed pool
  const anyKeys = sceneKeys.filter((k) => made[k]);                  // everything generated
  if (!anyKeys.length) {
    const reason = lastErrors?.[0]?.message || "the image model returned no image";
    console.error(
      `\n✗ AI product scenes could not be generated at all.\n` +
      `  Reason: ${String(reason).slice(0, 200)}\n` +
      `  Your uploaded photos are reference-only and were NOT used or posted.\n` +
      `  This is usually a temporary image-model rate limit / quota — wait a bit and try again.`,
    );
    process.exit(1);
  }
  let di = 0;
  const borrowDark = () =>
    relOf(darkKeys.length ? darkKeys[di++ % darkKeys.length] : anyKeys[di++ % anyKeys.length]);
  sceneRel = {
    hero:   made.clean ? relOf("clean") : borrowDark(),
    studio: made.life  ? relOf("life")  : borrowDark(),
    detail: made.dark  ? relOf("dark")  : borrowDark(),
    // white-bg card: prefer the front scene; only as a last resort reuse another.
    front:  made.front ? relOf("front") : relOf(anyKeys[0]),
  };
  const gen = anyKeys.length;
  console.log(gen < sceneKeys.length
    ? `✓ ${gen}/${sceneKeys.length} scene(s) generated — reused a generated scene for the ${sceneKeys.length - gen} that hit the rate limit (no raw photo used)`
    : `✓ ${gen}/${sceneKeys.length} scene(s) generated`);
}

// ── Card plan ─────────────────────────────────────────────────────────────
// Photo cards use their generated scene. When AI is explicitly disabled
// (DASHBOARD_SHOP_NO_AI=1) only then do we fall back to the uploaded photo.
const photoAt = (i) => staged[i % staged.length];
const photoFor = (card, i) => (aiOn ? sceneRel[card] : (sceneRel[card] || photoAt(i)));
const plan = [
  { cardType: "hero",   photoSrc: photoFor("hero", 0) },
  { cardType: "front",  photoSrc: photoFor("front", 1) },
  { cardType: "studio", photoSrc: photoFor("studio", 2) },
  { cardType: "detail", photoSrc: photoFor("detail", 3) },
  { cardType: "specs",  photoSrc: "" },
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

// ── Cleanup staged input photos + generated scenes (baked into the cards) ──
await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
await fs.rm(path.join(publicDir, sceneRelDir), { recursive: true, force: true }).catch(() => {});

process.exit(failed >= plan.length ? 1 : 0);
