#!/usr/bin/env node
// TikTok-Shop product-listing renderer (Tranzzie) — "Virtual Photography
// Studio". Takes the seller's real product photos as AI references and renders
// Tranzzie-branded listing cards. The uploaded photos are reference-only and
// are NEVER shown as a card; every photo card uses a freshly AI-generated
// scene of the SAME exact frame, then Remotion composites the branding
// deterministically (the product is never redrawn by the card layer).
//
// TWO MODES:
//  • Studio (DASHBOARD_SHOP_PLAN set) — dynamic: multiple frame VARIETIES
//    (colorways, each with its own reference photos), per-shot-type
//    QUANTITIES (hero/simple/model/closeup/feature/group/specs), identical
//    sets vs mixed round-robin, multi-variant group shots, and the
//    FeatureInfographicCard for technical overlays.
//  • Legacy (no plan env) — the original fixed 5-card set, unchanged.
//
// Env (set by the dashboard /api/generate handler):
//   DASHBOARD_SHOP_PLAN      JSON {varieties:[{name,photos:[abs..]}], shots:{...},
//                            identicalSets, modelNote}  → studio mode
//   DASHBOARD_SHOP_PHOTOS    JSON array of abs photo paths (legacy mode)
//   DASHBOARD_SHOP_SPECS     JSON array of spec ids (anti_rad/uv400/…)
//   DASHBOARD_SHOP_PRODUCT / _COLOR / _MATERIAL / _ASPECT / _PILLS
//   JURIE_EXPORT_DIR         output folder (per-client export dir)

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot, resolveClient } from "./lib/client.mjs";
import {
  buildGroupRefParts,
  buildRefParts,
  buildShotPrompt,
  generateShopScenes,
  generateShopShots,
} from "./lib/shop-scenes.mjs";

process.on("unhandledRejection", (r) => { console.error("[shop] unhandledRejection:", r?.stack || r?.message || String(r)); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("[shop] uncaughtException:", e?.stack || e?.message || String(e)); process.exit(1); });

const client = await resolveClient("tranzzie");

// ── Inputs ───────────────────────────────────────────────────────────────
const parseJson = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
const VALID_SPECS = ["anti_rad", "uv400", "photochromic", "polarized", "anti_glare", "anti_scratch"];
const specs = parseJson(process.env.DASHBOARD_SHOP_SPECS, []).filter((s) => VALID_SPECS.includes(s));
const productName = (process.env.DASHBOARD_SHOP_PRODUCT || "").trim().slice(0, 40);
const colorLabelLegacy = (process.env.DASHBOARD_SHOP_COLOR || "").trim().slice(0, 30);
const materialLabel = (process.env.DASHBOARD_SHOP_MATERIAL || "").trim().slice(0, 30);
const aspect = ["1:1", "4:5", "9:16"].includes(process.env.DASHBOARD_SHOP_ASPECT) ? process.env.DASHBOARD_SHOP_ASPECT : "1:1";

// Studio plan (new mode). Absent → legacy fixed 5-card path below.
const rawPlan = parseJson(process.env.DASHBOARD_SHOP_PLAN, null);
const SHOT_TYPES = ["hero", "simple", "model", "closeup", "feature", "group", "specs"];
let plan = null;
if (rawPlan && Array.isArray(rawPlan.varieties)) {
  const varieties = rawPlan.varieties
    .map((v) => ({
      name: String(v?.name || "").trim().slice(0, 30),
      photos: (Array.isArray(v?.photos) ? v.photos : []).filter(Boolean).slice(0, 6),
    }))
    .filter((v) => v.name && v.photos.length);
  const shots = {};
  for (const t of SHOT_TYPES) shots[t] = Math.max(0, Math.min(6, parseInt(rawPlan?.shots?.[t], 10) || 0));
  shots.specs = Math.min(1, shots.specs); // the text card renders once per batch
  if (varieties.length < 2) shots.group = 0; // group needs ≥2 colorways
  plan = {
    varieties,
    shots,
    identicalSets: !!rawPlan.identicalSets,
    modelNote: String(rawPlan.modelNote || "").trim().slice(0, 160),
  };
}

if (plan && !plan.varieties.length) { console.error("No varieties with photos provided."); process.exit(1); }
const legacyPhotos = parseJson(process.env.DASHBOARD_SHOP_PHOTOS, []).filter(Boolean);
if (!plan && !legacyPhotos.length) { console.error("No product photos provided — upload at least one."); process.exit(1); }

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
const establishedTag = (preset?.subtitle || "").trim();
let shopPills = [];
try { shopPills = JSON.parse(process.env.DASHBOARD_SHOP_PILLS || "[]"); } catch { shopPills = []; }
if (!Array.isArray(shopPills) || !shopPills.length) shopPills = ["Premium Build", "Fashion Forward", "Everyday Comfort"];
shopPills = shopPills.map((p) => String(p).slice(0, 24)).slice(0, 3);

const publicDir = path.join(projectRoot, "public");
const existsRel = async (rel) => { try { await fs.access(path.join(publicDir, rel)); return rel; } catch { return ""; } };
const logoSrc = preset?.logoSrc ? await existsRel(preset.logoSrc) : await existsRel("brand/tranzzie-logo.png");
const logoDarkSrc = await existsRel("brand/tranzzie-logo-dark.png");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const sceneRelDir = path.posix.join("generated-shop", stamp);
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "x";
const slug = slugify(productName || "product");
const featureLine = materialLabel ? `${materialLabel} build for everyday wear.` : "Built for everyday wear.";

applyGcpEnv();
const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;
const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

// ─────────────────────────────────────────────────────────────────────────
// Card plan builders — each entry: { cardType, composition, photoKey|null,
// variety (or null), fname }
// ─────────────────────────────────────────────────────────────────────────
const CARD_FOR_TYPE = { hero: "hero", simple: "front", closeup: "detail", model: "model", group: "group" };

let cardPlan = [];       // render order
let aiJobs = [];         // [{ id, type, varietyIdx, prompt, refParts }]
let varietiesForRun = []; // studio mode varieties

if (plan) {
  // ── Studio mode ─────────────────────────────────────────────────────────
  varietiesForRun = plan.varieties;
  const refPartsCache = [];
  for (const v of varietiesForRun) refPartsCache.push(await buildRefParts(v.photos, 3));

  // Expand quantities into concrete shots.
  const shotList = []; // { type, varietyIdx, typeIdx }
  const singleTypes = ["hero", "simple", "model", "closeup", "feature"];
  if (plan.identicalSets) {
    for (let vi = 0; vi < varietiesForRun.length; vi++)
      for (const t of singleTypes)
        for (let i = 0; i < plan.shots[t]; i++) shotList.push({ type: t, varietyIdx: vi, typeIdx: i });
  } else {
    let rr = 0; // global round-robin over varieties → mixed colorways in one set
    for (const t of singleTypes)
      for (let i = 0; i < plan.shots[t]; i++) shotList.push({ type: t, varietyIdx: rr++ % varietiesForRun.length, typeIdx: i });
  }
  for (let i = 0; i < plan.shots.group; i++) shotList.push({ type: "group", varietyIdx: -1, typeIdx: i });

  // Defensive cap (the route clamps too): stay inside the 12-min job timeout.
  const MAX_AI = 12;
  if (shotList.length > MAX_AI) {
    console.log(`⚠ ${shotList.length} AI shots requested — capping at ${MAX_AI} to stay inside the job window.`);
    shotList.length = MAX_AI;
  }

  const groupParts = plan.shots.group > 0 ? await buildGroupRefParts(varietiesForRun) : [];
  aiJobs = shotList.map((s) => {
    const vName = s.varietyIdx >= 0 ? varietiesForRun[s.varietyIdx].name : "all";
    const id = `${s.type}-${s.typeIdx}-${slugify(vName)}`;
    const prompt = buildShotPrompt(s.type, s.typeIdx, {
      modelNote: plan.modelNote,
      varietyNames: varietiesForRun.map((v) => v.name),
    });
    const refParts = s.type === "group" ? groupParts : refPartsCache[s.varietyIdx];
    return { id, type: s.type, varietyIdx: s.varietyIdx, typeIdx: s.typeIdx, prompt, refParts };
  });

  console.log(
    `▶ Studio plan: ${varietiesForRun.length} variet${varietiesForRun.length === 1 ? "y" : "ies"} · ` +
    `${aiJobs.length} AI shot(s) [${aiJobs.map((j) => j.id).join(", ")}]` +
    `${plan.shots.specs ? " + specs card" : ""} · ${plan.identicalSets ? "identical sets" : "mixed set"}`,
  );
} else {
  console.log(`▶ Legacy 5-card set for "${productName || "product"}" · ${legacyPhotos.length} photo(s)`);
}

// ─────────────────────────────────────────────────────────────────────────
// AI generation — two passes (initial + one retry of failures after a
// cool-down), then salvage-borrowing. Raw uploads are NEVER used as cards.
// ─────────────────────────────────────────────────────────────────────────
const outDirAbs = path.join(publicDir, sceneRelDir);
const relOf = (id) => path.posix.join(sceneRelDir, `${id}.png`);
let made = {};   // id → abs path

if (plan) {
  if (!gcpProject) { console.error("✗ No GOOGLE_CLOUD_PROJECT configured — cannot generate product scenes."); process.exit(1); }
  console.log(`Generating ${aiJobs.length} product shot(s) (Gemini) in ${gcpLocation}…`);
  let lastErrors = [];
  for (let pass = 1; pass <= 2; pass++) {
    const want = aiJobs.filter((j) => !made[j.id]);
    if (!want.length) break;
    if (pass === 2) {
      console.log(`  rate limit / blip — pausing, then retrying ${want.length} shot(s): ${want.map((j) => j.id).join(", ")}…`);
      await new Promise((r) => setTimeout(r, 6000));
    }
    const res = await generateShopShots({ jobs: want, project: gcpProject, location: gcpLocation, outDir: outDirAbs, log: (m) => console.log(m) });
    Object.assign(made, res.made);
    lastErrors = res.errors;
  }
  if (!Object.keys(made).length && aiJobs.length) {
    const reason = lastErrors?.[0]?.message || "the image model returned no image";
    console.error(
      `\n✗ AI product shots could not be generated at all.\n` +
      `  Reason: ${String(reason).slice(0, 200)}\n` +
      `  Your uploaded photos are reference-only and were NOT used or posted.\n` +
      `  This is usually a temporary image-model rate limit / quota — wait a bit and try again.`,
    );
    process.exit(1);
  }

  // Salvage-borrowing for shots that still failed. Order: same type + same
  // variety → same type → same variety → anything. `feature` cards need clean
  // negative space, so they only borrow from feature/closeup shots.
  const okJobs = aiJobs.filter((j) => made[j.id]);
  const borrowFor = (job) => {
    const pools = [
      okJobs.filter((j) => j.type === job.type && j.varietyIdx === job.varietyIdx),
      okJobs.filter((j) => j.type === job.type),
      ...(job.type === "feature"
        ? [okJobs.filter((j) => j.type === "closeup")]
        : [okJobs.filter((j) => j.varietyIdx === job.varietyIdx), okJobs]),
    ];
    for (const p of pools) if (p.length) return p[0].id;
    return null;
  };
  let borrowed = 0;
  for (const job of aiJobs) {
    if (made[job.id]) continue;
    const b = borrowFor(job);
    if (b) { made[job.id] = made[b]; borrowed += 1; }
  }
  const genCount = okJobs.length;
  console.log(borrowed
    ? `✓ ${genCount}/${aiJobs.length} shot(s) generated — reused a generated shot for the ${borrowed} that hit the rate limit (no raw photo used)`
    : `✓ ${genCount}/${aiJobs.length} shot(s) generated`);

  // Cards that STILL have no scene (nothing borrowable of an acceptable kind)
  // are dropped rather than rendered blank / with a raw upload.
  const renderable = aiJobs.filter((j) => made[j.id]);
  const dropped = aiJobs.length - renderable.length;
  if (dropped) console.log(`⚠ ${dropped} card(s) skipped — no acceptable scene available.`);

  // Build the render plan.
  cardPlan = renderable.map((j) => {
    const isGroup = j.type === "group";
    const vName = isGroup
      ? varietiesForRun.map((v) => v.name).join(" · ")
      : varietiesForRun[j.varietyIdx].name;
    return {
      composition: j.type === "feature" ? "FeatureInfographicCard" : "ShopListingCard",
      cardType: CARD_FOR_TYPE[j.type] || "hero",
      // Borrowed shots point at the DONOR's scene file — derive the rel path
      // from the actual absolute path, never from this job's id.
      photoRel: path.posix.join(sceneRelDir, path.basename(made[j.id])),
      colorLabel: vName,
      fname: "", // final numbering below
      type: j.type,
    };
  });
  if (plan.shots.specs) {
    cardPlan.push({ composition: "ShopListingCard", cardType: "specs", photoRel: "", photoAbs: "", colorLabel: "", fname: "", type: "specs" });
  }
  // Final filenames with stable numbering.
  cardPlan = cardPlan.map((c, i) => ({
    ...c,
    fname: `tranzzie-${String(i + 1).padStart(2, "0")}-${slug}_${
      c.type === "specs" || c.type === "group" ? c.type : `${slugify(c.colorLabel.split(" · ")[0] || "x")}_${c.type}`
    }.png`.replace(/__+/g, "_"),
  }));
} else {
  // ── Legacy mode (unchanged behavior): stage uploads, 4 fixed scenes,
  //    tone-aware borrowing, 5 fixed cards. ───────────────────────────────
  const stageRel = path.posix.join("_shop-input", stamp);
  const stageDir = path.join(publicDir, stageRel);
  await fs.mkdir(stageDir, { recursive: true });
  const staged = [];
  for (let i = 0; i < legacyPhotos.length; i++) {
    const ext = (path.extname(legacyPhotos[i]) || ".png").toLowerCase();
    const rel = path.posix.join(stageRel, `photo-${String(i + 1).padStart(2, "0")}${ext}`);
    try { await fs.copyFile(legacyPhotos[i], path.join(publicDir, rel)); staged.push(rel); }
    catch (e) { console.warn(`  skip photo ${i + 1}: ${e.message}`); }
  }
  if (!staged.length) { console.error("Could not stage any uploaded photos."); process.exit(1); }

  const CARD_SCENE = { hero: "clean", front: "front", studio: "life", detail: "dark" };
  const sceneKeys = ["clean", "life", "dark", "front"];
  const aiOn = process.env.DASHBOARD_SHOP_NO_AI !== "1";
  let sceneRel = {};
  if (aiOn) {
    if (!gcpProject) { console.error("✗ No GOOGLE_CLOUD_PROJECT configured — cannot generate product scenes."); process.exit(1); }
    console.log(`Generating product-placement scenes of the frame (Gemini) in ${gcpLocation}…`);
    const madeScenes = {};
    let lastErrors = [];
    for (let pass = 1; pass <= 2; pass++) {
      const want = sceneKeys.filter((k) => !madeScenes[k]);
      if (!want.length) break;
      if (pass === 2) {
        console.log(`  rate limit hit — pausing, then retrying ${want.length} scene(s): ${want.join(", ")}…`);
        await new Promise((r) => setTimeout(r, 6000));
      }
      const { scenes, errors } = await generateShopScenes({ refPaths: legacyPhotos, project: gcpProject, location: gcpLocation, outDir: outDirAbs, keys: want, log: (m) => console.log(m) });
      Object.assign(madeScenes, scenes);
      lastErrors = errors;
    }
    const relOfScene = (k) => (madeScenes[k] ? path.posix.join(sceneRelDir, `${k}.png`) : "");
    const darkKeys = ["clean", "life", "dark"].filter((k) => madeScenes[k]);
    const anyKeys = sceneKeys.filter((k) => madeScenes[k]);
    if (!anyKeys.length) {
      const reason = lastErrors?.[0]?.message || "the image model returned no image";
      console.error(
        `\n✗ AI product scenes could not be generated at all.\n  Reason: ${String(reason).slice(0, 200)}\n` +
        `  Your uploaded photos are reference-only and were NOT used or posted.\n` +
        `  This is usually a temporary image-model rate limit / quota — wait a bit and try again.`,
      );
      process.exit(1);
    }
    let di = 0;
    const borrowDark = () => relOfScene(darkKeys.length ? darkKeys[di++ % darkKeys.length] : anyKeys[di++ % anyKeys.length]);
    sceneRel = {
      hero: madeScenes.clean ? relOfScene("clean") : borrowDark(),
      studio: madeScenes.life ? relOfScene("life") : borrowDark(),
      detail: madeScenes.dark ? relOfScene("dark") : borrowDark(),
      front: madeScenes.front ? relOfScene("front") : relOfScene(anyKeys[0]),
    };
    const gen = anyKeys.length;
    console.log(gen < sceneKeys.length
      ? `✓ ${gen}/${sceneKeys.length} scene(s) generated — reused a generated scene for the ${sceneKeys.length - gen} that hit the rate limit (no raw photo used)`
      : `✓ ${gen}/${sceneKeys.length} scene(s) generated`);
  }
  const photoAt = (i) => staged[i % staged.length];
  const photoFor = (card, i) => (aiOn ? sceneRel[card] : (sceneRel[card] || photoAt(i)));
  cardPlan = [
    { composition: "ShopListingCard", cardType: "hero", photoRel: photoFor("hero", 0), colorLabel: colorLabelLegacy, type: "hero" },
    { composition: "ShopListingCard", cardType: "front", photoRel: photoFor("front", 1), colorLabel: colorLabelLegacy, type: "front" },
    { composition: "ShopListingCard", cardType: "studio", photoRel: photoFor("studio", 2), colorLabel: colorLabelLegacy, type: "studio" },
    { composition: "ShopListingCard", cardType: "detail", photoRel: photoFor("detail", 3), colorLabel: colorLabelLegacy, type: "detail" },
    { composition: "ShopListingCard", cardType: "specs", photoRel: "", colorLabel: colorLabelLegacy, type: "specs" },
  ].map((c, i) => ({ ...c, fname: `tranzzie-${String(i + 1).padStart(2, "0")}-${slug}_${c.cardType}.png` }));
  // remember the stage dir for cleanup
  cardPlan._legacyStageDir = stageDir;
}

// ─────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────
const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;
const exportDir = path.join(EXPORT_DIR, stamp);
await fs.mkdir(exportDir, { recursive: true });

console.log(`Rendering ${cardPlan.length} Tranzzie shop card(s) for "${productName || "product"}"…`);
console.log("Bundling Remotion project (one-time)…");
const t0 = Date.now();
const bundleLocation = await bundle({ entryPoint: path.join(projectRoot, "src", "index.ts"), webpackOverride: (c) => c });
console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

let failed = 0;
for (let i = 0; i < cardPlan.length; i++) {
  const p = cardPlan[i];
  const outPath = path.join(exportDir, p.fname);
  const inputProps = p.composition === "FeatureInfographicCard"
    ? {
        photoSrc: p.photoRel,
        specs,
        productName,
        claimLine: "",
        brandName: client.label || "Tranzzie Eyeglasses",
        logoSrc,
        brandGold,
        focusX: 0.46,
        focusY: 0.4,
        aspectRatio: aspect,
      }
    : {
        photoSrc: p.photoRel,
        cardType: p.cardType,
        specs,
        productName,
        colorLabel: p.colorLabel || "",
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
    const composition = await selectComposition({ serveUrl: bundleLocation, id: p.composition, inputProps });
    await renderStill({ composition, serveUrl: bundleLocation, output: outPath, inputProps, imageFormat: "png", frame: 40 });
    console.log(`  [${i + 1}/${cardPlan.length}] ${p.fname}  (${((Date.now() - tStart) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed += 1;
    console.warn(`  [${i + 1}/${cardPlan.length}] FAILED ${p.fname}: ${(err.message || err)?.toString().slice(0, 140)}`);
  }
}

// ── Brand-safe product description (captions.txt) ──────────────────────────
const specLabels = { anti_rad: "blue-light filtering", uv400: "100% UV protection", photochromic: "light-adaptive lenses", polarized: "polarized clarity", anti_glare: "anti-glare coating", anti_scratch: "scratch-resistant coating" };
const specPhrase = specs.map((s) => specLabels[s]).filter(Boolean).join(", ");
const colorways = plan ? varietiesForRun.map((v) => v.name).join(" · ") : colorLabelLegacy;
const desc =
  `${productName || "New Arrival"} — ${client.label || "Tranzzie Eyeglasses"}\n` +
  (materialLabel ? `${materialLabel}` : "") + (colorways ? `${materialLabel ? " · " : ""}${colorways}` : "") + "\n" +
  (plan && varietiesForRun.length > 1 ? `Available in ${varietiesForRun.length} colorways: ${colorways}.\n` : "") +
  (specPhrase ? `Features: ${specPhrase}.\n` : "") +
  `Lightweight, everyday eyewear. Free 15-day returns.\n` +
  `Shop now on TikTok. #Tranzzie #Eyeglasses #BlueLightGlasses`;
await fs.writeFile(path.join(exportDir, "captions.txt"),
  cardPlan.map((p, i) => `#${i + 1} (${p.type}${p.colorLabel ? ` · ${p.colorLabel}` : ""})\n${i === 0 ? desc : ""}\n${"-".repeat(40)}\n`).join("\n"));

// ── Contact-sheet gallery ─────────────────────────────────────────────────
const rows = cardPlan.map((p, i) =>
  `<figure><img src="./${p.fname}"/><figcaption><b>#${i + 1}</b> ${p.type}${p.colorLabel ? ` · ${p.colorLabel}` : ""}</figcaption></figure>`,
).join("\n");
await fs.writeFile(path.join(exportDir, "gallery.html"),
  `<!doctype html><meta charset="utf-8"><title>Tranzzie shop cards ${stamp}</title>` +
  `<style>body{background:#111;color:#eee;font-family:system-ui;margin:24px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px}figure{margin:0;background:#1c1c1c;border-radius:8px;overflow:hidden}img{width:100%;display:block}figcaption{padding:9px 11px;font-size:13px;color:#bbb}</style>` +
  `<h1>Tranzzie — ${cardPlan.length} shop cards — ${stamp}</h1><div class="grid">${rows}</div>`);

console.log(`\n✓ ${cardPlan.length - failed}/${cardPlan.length} card(s)\n  Export : ${exportDir}\n  Review : ${path.join(exportDir, "gallery.html")}`);
if (failed) console.log(`  (${failed} failed — see warnings)`);

// ── Cleanup staged inputs + generated scenes (baked into the cards) ──────
if (cardPlan._legacyStageDir) await fs.rm(cardPlan._legacyStageDir, { recursive: true, force: true }).catch(() => {});
await fs.rm(outDirAbs, { recursive: true, force: true }).catch(() => {});

process.exit(failed >= cardPlan.length && cardPlan.length ? 1 : 0);
