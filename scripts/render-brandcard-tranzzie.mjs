#!/usr/bin/env node
// Brand-a-Photo renderer (Tranzzie). Takes ONE eyeglasses photo and composites
// Tranzzie branding (a tagline + optional logo) onto it in a chosen layout.
// Unlike the TikTok Shop cards, the image can be the REAL uploaded photo.
//
// Image treatment (3-way):
//   original — use the uploaded photo as-is.
//   cleanup  — light AI retouch: even the lighting, tidy the background, remove
//              lens stickers / arm text — but KEEP the same photo/composition.
//   reshoot  — full dramatic AI studio re-shoot of the exact frame (shop 'hero').
// Text: your own tagline, or one AI-written in Tranzzie's voice.
//
// Env (set by the dashboard /api/generate handler):
//   DASHBOARD_BRANDCARD_PLAN  JSON {photo, treatment, textMode, tagline,
//                             productName, showLogo, layout, aspect}
//   JURIE_EXPORT_DIR          output folder (per-client export dir)

import { GoogleGenAI } from "@google/genai";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot, resolveClient } from "./lib/client.mjs";
import { PHOTOGRAPHER_PERSONA, buildRefParts, buildShotPrompt, generateShopShots } from "./lib/shop-scenes.mjs";

process.on("unhandledRejection", (r) => { console.error("[brandcard] unhandledRejection:", r?.stack || r?.message || String(r)); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("[brandcard] uncaughtException:", e?.stack || e?.message || String(e)); process.exit(1); });

const client = await resolveClient("tranzzie");

// ── Plan ─────────────────────────────────────────────────────────────────
const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const plan = parseJson(process.env.DASHBOARD_BRANDCARD_PLAN, null);
const allPhotos = (Array.isArray(plan?.photos) && plan.photos.length ? plan.photos : [plan?.photo]).filter(Boolean);
if (!plan || !allPhotos.length) { console.error("No brand-card plan / photo provided."); process.exit(1); }
const treatment = ["original", "cleanup", "reshoot"].includes(plan.treatment) ? plan.treatment : "original";
const textMode = plan.textMode === "ai" ? "ai" : "own";
const LAYOUTS = ["minimal", "banner", "editorial", "badge"];
const layout = LAYOUTS.includes(plan.layout) ? plan.layout : "minimal";
const aspect = ["1:1", "4:5", "9:16"].includes(plan.aspect) ? plan.aspect : "4:5";
const showLogo = plan.showLogo !== false;
const productName = String(plan.productName || "").trim().slice(0, 40);
let tagline = String(plan.tagline || "").trim().slice(0, 140);

// ── Brand preset (colours + logo + established tag) ────────────────────────
let preset = null;
try {
  const PERSIST = process.env.PERSIST_BASE || projectRoot;
  const presets = JSON.parse(await fs.readFile(path.join(PERSIST, "config", "brand-presets.json"), "utf-8").catch(() =>
    fs.readFile(path.join(projectRoot, "config", "brand-presets.json"), "utf-8")));
  preset = presets.find((p) => p.id === "preset_tranzzie") || presets.find((p) => p.client === "tranzzie") || null;
} catch { /* component defaults */ }
const brandGold = preset?.brandAccent || "#F4B400";
const establishedTag = (preset?.subtitle || "").trim();

const publicDir = path.join(projectRoot, "public");
const existsRel = async (rel) => { try { await fs.access(path.join(publicDir, rel)); return rel; } catch { return ""; } };
// Light-text logo (gold crest + white lettering) — reads on the dark/photo cards.
const logoSrc = showLogo ? (preset?.logoSrc ? await existsRel(preset.logoSrc) : await existsRel("brand/tranzzie-logo.png")) : "";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const slug = (productName || "brand-photo").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "photo";

applyGcpEnv();
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

// ── Stage / generate the image ─────────────────────────────────────────────
const inputRel = path.posix.join("_brandcard-input", stamp);
const inputDir = path.join(publicDir, inputRel);
await fs.mkdir(inputDir, { recursive: true });
const ext = (path.extname(allPhotos[0]) || ".png").toLowerCase();
const stagedRel = path.posix.join(inputRel, `photo${ext}`);
try { await fs.copyFile(allPhotos[0], path.join(publicDir, stagedRel)); }
catch (e) { console.error(`Could not read the uploaded photo: ${e.message}`); process.exit(1); }
// Stage any EXTRA reference photos too (used only by the AI re-shoot, as
// additional angles for a more accurate frame model).
const extraStagedAbs = [];
for (let i = 1; i < allPhotos.length; i++) {
  const eext = (path.extname(allPhotos[i]) || ".png").toLowerCase();
  const dest = path.join(inputDir, `photo-${i}${eext}`);
  try { await fs.copyFile(allPhotos[i], dest); extraStagedAbs.push(dest); } catch { /* skip unreadable ref */ }
}

const genRel = path.posix.join("generated-brandcard", stamp);
let photoRel = stagedRel; // default: the original

const CLEANUP_PROMPT =
  PHOTOGRAPHER_PERSONA +
  "Lightly RETOUCH and clean up this exact product photo of eyeglasses for a " +
  "marketplace listing. KEEP THE SAME PHOTO — the same eyeglasses, the same " +
  "composition, framing, angle and pose. Do NOT re-shoot, re-pose, move, zoom, " +
  "or replace the glasses; this is a gentle clean-up of the existing shot, not a " +
  "new photograph. Only: even out and brighten the lighting, gently tidy the " +
  "background (remove clutter and distractions, or replace a messy backdrop with " +
  "a clean, neutral, softly-lit surface that matches the original tone), make the " +
  "lenses clean and clear, and REMOVE any lens display stickers, price tags, or " +
  "brand-name / model text printed or engraved on the lenses or temple arms. The " +
  "result must clearly read as the SAME photo, just professionally cleaned up. " +
  "Photorealistic and natural. No added text, logos or watermarks.";

if (treatment !== "original") {
  if (!gcpProject) { console.error("✗ No GOOGLE_CLOUD_PROJECT — cannot run AI image treatment."); process.exit(1); }
  // Cleanup keeps ONE photo (it must preserve that exact composition). Reshoot
  // uses every reference photo given — multiple angles help Gemini model the
  // frame's true shape/material more accurately than a single snapshot.
  const refPaths = treatment === "reshoot"
    ? [path.join(publicDir, stagedRel), ...extraStagedAbs]
    : [path.join(publicDir, stagedRel)];
  const refParts = await buildRefParts(refPaths, 6);
  const prompt = treatment === "cleanup" ? CLEANUP_PROMPT : buildShotPrompt("hero", 0);
  if (refPaths.length > 1) console.log(`Using ${refPaths.length} reference photos for a more accurate re-shoot…`);
  console.log(`Running '${treatment}' AI image treatment (Gemini) in ${gcpLocation}…`);
  const { made, errors } = await generateShopShots({
    jobs: [{ id: "img", prompt, refParts }],
    project: gcpProject, location: gcpLocation, outDir: path.join(publicDir, genRel), log: (m) => console.log(m),
  });
  if (made.img) { photoRel = path.posix.join(genRel, "img.png"); console.log(`✓ ${treatment} image ready`); }
  else {
    // Unlike Shop, Brand-a-Photo is allowed to show the real photo — so an AI
    // failure gracefully falls back to the original instead of aborting.
    console.warn(`⚠ AI ${treatment} failed (${errors?.[0]?.message?.slice(0, 120) || "unknown"}) — using the original photo instead.`);
  }
}

// ── Tagline (AI-written, Tranzzie voice) ───────────────────────────────────
if (textMode === "ai") {
  if (!gcpProject) { console.warn("⚠ No GCP project for AI tagline — using your text / a default."); }
  else {
    try {
      const voice = await fs.readFile(path.join(projectRoot, "scripts", "voice-profile-tranzzie.md"), "utf-8").catch(() => "");
      const ai = new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation });
      const hint = tagline ? `\nThe user gave this hint / topic to build on: "${tagline}".` : "";
      const resp = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text:
          "Write ONE short marketing tagline (a caption) for a Tranzzie Eyeglasses " +
          "product poster — max ~10 words, punchy, warm, benefit-led. Eyewear / " +
          "eye-comfort themed. Brand-safe: describe FEATURES and comfort, never a " +
          "medical cure or guarantee. No hashtags, no emojis, no quotation marks, " +
          "no brand name. Return ONLY the tagline text." + hint }] }],
        config: { systemInstruction: voice || "You write for a friendly Filipino optical clinic, Tranzzie Eyeglasses.", temperature: 0.9 },
      });
      const out = String(resp.text || "").trim().replace(/^["']|["']$/g, "").split("\n")[0].slice(0, 140);
      if (out) { tagline = out; console.log(`✓ AI tagline: ${tagline}`); }
    } catch (e) { console.warn(`⚠ AI tagline failed (${e?.message || e}) — using your text / a default.`); }
  }
}
if (!tagline) tagline = "See clearly. Live boldly.";

// ── Render ─────────────────────────────────────────────────────────────────
const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;
const exportDir = path.join(EXPORT_DIR, stamp);
await fs.mkdir(exportDir, { recursive: true });

console.log(`Rendering brand card (${layout}, ${aspect}, ${treatment}) for "${productName || "photo"}"…`);
const t0 = Date.now();
const bundleLocation = await bundle({ entryPoint: path.join(projectRoot, "src", "index.ts"), webpackOverride: (c) => c });
console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const fname = `tranzzie-brandcard-${slug}_${layout}.png`;
const inputProps = {
  photoSrc: photoRel, tagline, productName, logoSrc, showLogo, layout,
  brandGold, brandName: client.label || "Tranzzie Eyeglasses", establishedTag, aspectRatio: aspect,
};
let ok = false;
try {
  const composition = await selectComposition({ serveUrl: bundleLocation, id: "BrandCard", inputProps });
  await renderStill({ composition, serveUrl: bundleLocation, output: path.join(exportDir, fname), inputProps, imageFormat: "png", frame: 40 });
  ok = true;
  console.log(`  ✓ ${fname}`);
} catch (err) {
  console.warn(`  FAILED ${fname}: ${(err.message || err)?.toString().slice(0, 160)}`);
}

// ── Caption + gallery ──────────────────────────────────────────────────────
try {
  await fs.writeFile(path.join(exportDir, "captions.txt"),
    `${productName ? productName + " — " : ""}${client.label || "Tranzzie Eyeglasses"}\n${tagline}\n\nShop now on TikTok. #Tranzzie #Eyeglasses\n`);
  await fs.writeFile(path.join(exportDir, "gallery.html"),
    `<!doctype html><meta charset="utf-8"><title>Tranzzie brand card ${stamp}</title>` +
    `<style>body{background:#111;color:#eee;font-family:system-ui;margin:24px}img{max-width:420px;border-radius:10px;display:block}</style>` +
    `<h1>Tranzzie — brand card — ${stamp}</h1>${ok ? `<img src="./${fname}">` : "<p>Render failed.</p>"}<p>${tagline}</p>`);
} catch (e) { console.warn(`  could not write caption/gallery: ${e?.message || e}`); }

console.log(`\n${ok ? "✓ 1/1 card" : "✗ 0/1 card"}\n  Export : ${exportDir}\n  Review : ${path.join(exportDir, "gallery.html")}`);

// ── Cleanup staged input + generated image (baked into the card) ──────────
await fs.rm(inputDir, { recursive: true, force: true }).catch(() => {});
await fs.rm(path.join(publicDir, genRel), { recursive: true, force: true }).catch(() => {});

process.exit(ok ? 0 : 1);
