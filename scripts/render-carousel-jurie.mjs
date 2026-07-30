#!/usr/bin/env node
// Instagram carousel renderer for Jurie.
//
// Takes copy the user has ALREADY approved in the dashboard and renders the
// slides through Higgsfield. Copy generation deliberately lives elsewhere
// (lib/carousel-copy.mjs) so no image credits are spent before approval.
//
// Slide system, both halves proven before this script existed:
//   cover     Soul scene (identity-locked) -> nano_banana composes 4:5 with a
//             legible newspaper headline. Soul cannot render text and
//             nano_banana cannot lock her face, so it takes both.
//   teaching  Apple macOS dark-mode frosted panel. A flat repeatable system,
//             which is what keeps six slides looking like one set.
//   cta       same Apple language, centred.
//
// Env:
//   DASHBOARD_CAROUSEL_PLAN  JSON {coverHeadline, slides[], cta, caption,
//                            topic, engine, soulId, masthead}
//   JURIE_EXPORT_DIR         output folder
//
// LOCAL ONLY: this drives the higgsfield CLI, which authenticates from a
// session on this machine. It cannot run on the deployed Railway studio.

import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot, resolveClient } from "./lib/client.mjs";
import { compose, hfBalance, hfDownload, soulScene } from "./lib/higgsfield.mjs";

process.on("unhandledRejection", (r) => { console.error("[carousel] unhandledRejection:", r?.stack || r?.message || String(r)); process.exit(1); });

const client = await resolveClient("jurie");
const plan = (() => { try { return JSON.parse(process.env.DASHBOARD_CAROUSEL_PLAN || "null"); } catch { return null; } })();
if (!plan || !plan.coverHeadline || !Array.isArray(plan.slides) || !plan.slides.length) {
  console.error("No approved carousel copy provided.");
  process.exit(1);
}

const SOUL_ID = plan.soulId || process.env.JURIE_SOUL_ID || "c8e28a05-06bc-4d06-be8c-2abf8650833d";
const MASTHEAD = String(plan.masthead || "THE DAILY BRIEF").slice(0, 28);
const GOLD = "#F4B400";
const total = plan.slides.length + 2; // cover + teaching + cta

applyGcpEnv();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;
const outDir = path.join(EXPORT_DIR, `carousel-${stamp}`);
await fs.mkdir(outDir, { recursive: true });

const before = await hfBalance();
console.log(`Rendering ${total}-slide carousel for Jurie…`);
if (before != null) console.log(`  credits before: ${before.toFixed(2)}`);

// ── Prompt system ─────────────────────────────────────────────────────────
// The identity prompt is load-bearing. Without "long hair visible on both
// shoulders" the backwards cap makes her read as male, and without naming the
// gold rimless frames the Soul falls back to clear plastic ones.
const IDENTITY =
  "a young Filipina woman in her late twenties, clearly feminine, long straight dark hair " +
  "falling well past her shoulders and visible in front of both shoulders, wearing a grey cap " +
  "turned backwards, delicate GOLD RIMLESS eyeglasses with thin gold temples, and a black t-shirt";

const SOUL_SCENE_PROMPT =
  `Portrait of ${IDENTITY}. She is sitting at a table in a warm modern coffee shop beside a ` +
  "large window in the morning, holding an open broadsheet newspaper up in both hands and " +
  "reading it, a latte in a ceramic cup on the table beside her. Candid lifestyle photography, " +
  "warm natural window light, shallow depth of field, cosy cafe interior blurred behind her.";

const coverPrompt = (headline) =>
  "Instagram carousel COVER slide, 4:5 vertical. Keep this exact woman, her face, backwards grey " +
  "cap, long dark hair, black t-shirt, and the whole warm coffee-shop scene with the window light " +
  "and the latte, faithful to the reference image. TWO CHANGES ONLY. First: her eyeglasses must be " +
  "delicate GOLD RIMLESS frames with thin gold temples and no plastic rim. Second: the broadsheet " +
  "newspaper she is holding must have a real, crisp, perfectly legible front page. Its masthead " +
  `reads '${MASTHEAD}' in a classic serif, and beneath it a very large bold black serif headline ` +
  `spanning the full width of the page reads '${headline}'. Below the headline, realistic small ` +
  "newspaper body columns and a small photo. Every letter of the headline must be sharp and " +
  "correctly spelled. Add a small white rounded pill button in the bottom right of the slide " +
  "reading 'Swipe' with three small left chevrons, and a row of small page dots centered at the " +
  "very bottom. Premium editorial lifestyle photography.";

// One shared description of the Apple panel, repeated verbatim so every
// teaching slide lands in the same visual system.
const APPLE_BASE =
  "Instagram carousel slide, 4:5 vertical, designed to look exactly like Apple macOS dark mode UI. " +
  "Background is a smooth deep charcoal to black gradient with a soft blurred colourful aurora glow " +
  "behind it. Centered is a large rounded-rectangle frosted glass panel with heavy translucent blur, " +
  "a thin light 1px border and a soft drop shadow, exactly like a macOS window, filling most of the " +
  "frame with generous but not excessive margins. At the top left inside the panel are three small " +
  "traffic light dots in red, amber and green. Clean premium Apple software aesthetic, Apple SF Pro " +
  "style typography, perfectly legible crisp text, correct spelling.";

const slidePrompt = (s, idx) =>
  `${APPLE_BASE} Inside the panel: a large gold numeral '${String(s.n).padStart(2, "0")}', below it a ` +
  `bold white headline reading '${s.headline}', below that a thin hairline divider, then light grey ` +
  `body text reading '${s.body}'. A small '${idx}/${total}' in the bottom right corner of the slide.`;

const ctaPrompt = (cta) =>
  `${APPLE_BASE} The panel is a closing call to action, centred. Inside it: a small gold kicker line ` +
  `reading '${cta.kicker}', below it a large bold white headline reading '${cta.headline}', below ` +
  `that a thin hairline divider, then light grey body text reading '${cta.body}'. A small ` +
  `'${total}/${total}' in the bottom right corner of the slide.`;

// ── Render ────────────────────────────────────────────────────────────────
const made = [];
const failed = [];

// Cover: two-step so we get her likeness AND readable type.
try {
  console.log("  [1] cover — Soul scene…");
  const scene = await soulScene({ prompt: SOUL_SCENE_PROMPT, soulId: SOUL_ID });
  const scenePath = path.join(outDir, "_cover-scene.png");
  await hfDownload(scene.url, scenePath);

  console.log("  [1] cover — composing headline…");
  const cover = await compose({ prompt: coverPrompt(plan.coverHeadline), refs: [scenePath] });
  const coverPath = path.join(outDir, "slide-01-cover.png");
  await hfDownload(cover.url, coverPath);
  made.push({ n: 1, file: "slide-01-cover.png", label: "Cover" });
  await fs.unlink(scenePath).catch(() => {});
  console.log("      ✓ slide-01-cover.png");
} catch (e) {
  failed.push({ n: 1, why: e.message });
  console.warn(`      ✗ cover failed: ${e.message}`);
}

// Teaching slides. One failure must not abandon the rest of the carousel.
for (let i = 0; i < plan.slides.length; i++) {
  const s = plan.slides[i];
  const idx = i + 2;
  const name = `slide-${String(idx).padStart(2, "0")}-${String(s.headline || "slide").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "slide"}.png`;
  try {
    console.log(`  [${idx}] ${s.headline}…`);
    const r = await compose({ prompt: slidePrompt(s, idx) });
    await hfDownload(r.url, path.join(outDir, name));
    made.push({ n: idx, file: name, label: s.headline });
    console.log(`      ✓ ${name}`);
  } catch (e) {
    failed.push({ n: idx, why: e.message });
    console.warn(`      ✗ slide ${idx} failed: ${e.message}`);
  }
}

// CTA
try {
  console.log(`  [${total}] CTA…`);
  const r = await compose({ prompt: ctaPrompt(plan.cta || {}) });
  const name = `slide-${String(total).padStart(2, "0")}-cta.png`;
  await hfDownload(r.url, path.join(outDir, name));
  made.push({ n: total, file: name, label: "CTA" });
  console.log(`      ✓ ${name}`);
} catch (e) {
  failed.push({ n: total, why: e.message });
  console.warn(`      ✗ CTA failed: ${e.message}`);
}

// ── Caption, gallery, ledger ──────────────────────────────────────────────
made.sort((a, b) => a.n - b.n);
await fs.writeFile(path.join(outDir, "captions.txt"), `${plan.caption || plan.coverHeadline}\n`);
await fs.writeFile(
  path.join(outDir, "gallery.html"),
  `<!doctype html><meta charset="utf-8"><title>Jurie carousel ${stamp}</title>` +
    `<style>body{background:#0b0b0d;color:#eee;font-family:system-ui;margin:24px}` +
    `.row{display:flex;gap:14px;overflow-x:auto;padding-bottom:12px}` +
    `figure{margin:0;flex:none}img{width:300px;border-radius:12px;display:block}` +
    `figcaption{color:#9a9aa2;font-size:12px;margin-top:6px}</style>` +
    `<h1>Jurie — carousel — ${stamp}</h1><p style="color:#9a9aa2">${plan.topic || ""}</p>` +
    `<div class="row">${made.map((m) => `<figure><img src="./${m.file}"><figcaption>${m.n}. ${m.label}</figcaption></figure>`).join("")}</div>` +
    `<pre style="color:#9a9aa2;white-space:pre-wrap;margin-top:20px">${plan.caption || ""}</pre>`,
);

// Topic ledger — this is what stops her repeating herself run after run.
try {
  const PERSIST = process.env.PERSIST_BASE || projectRoot;
  const ledgerPath = path.join(PERSIST, "config", "jurie-topic-ledger.json");
  let ledger = [];
  try { ledger = JSON.parse(await fs.readFile(ledgerPath, "utf-8")); } catch { ledger = []; }
  if (!Array.isArray(ledger)) ledger = [];
  ledger.unshift({ stamp, engine: plan.engine || "framework", topic: plan.topic || plan.coverHeadline, headline: plan.coverHeadline });
  await fs.writeFile(ledgerPath, JSON.stringify(ledger.slice(0, 400), null, 1));
  console.log(`  ledger: ${ledger.length} entries`);
} catch (e) { console.warn(`  could not update topic ledger: ${e?.message || e}`); }

const after = await hfBalance();
if (before != null && after != null) console.log(`  credits used: ${(before - after).toFixed(2)}`);
console.log(`\n${made.length}/${total} slides\n  Export : ${outDir}\n  Review : ${path.join(outDir, "gallery.html")}`);
if (failed.length) console.log(`  failed : ${failed.map((f) => `#${f.n}`).join(", ")}`);
process.exit(made.length ? 0 : 1);
