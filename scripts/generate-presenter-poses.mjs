#!/usr/bin/env node
// ONE-TIME presenter pose-set generator. Produces the photoreal Jurie poses the
// video render composites per phase (like the Techsplains mascot, but real).
// Idempotent: skips any pose file that already exists.
//
//   node scripts/generate-presenter-poses.mjs --client tranzzie
//   node scripts/generate-presenter-poses.mjs --client tranzzie --force

import fs from "node:fs/promises";
import { accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { posesToGenerate, posePrompt } from "./lib/presenter-poses.mjs";

const { client: CLIENT_ID, rest } = takeClientArg(process.argv.slice(2));
const FORCE = rest.includes("--force");
const cfg = await resolveDiffClient(CLIENT_ID || "tranzzie");
cfg.applyGcpEnv();

const presenter = { ...cfg.presenter, _brandName: cfg.brandName };
if (!presenter.characterId) {
  console.error(`Client "${cfg.id}" has no presenter.characterId (static mascot). Nothing to generate.`);
  process.exit(0);
}

// Resolve the character's reference photos from characters.json.
const chars = JSON.parse(await fs.readFile(path.join(projectRoot, "config", "characters.json"), "utf-8"));
const character = chars.find((c) => c.id === presenter.characterId);
if (!character?.photos?.length) {
  console.error(`Character "${presenter.characterId}" not found or has no photos.`);
  process.exit(1);
}

const mimeFor = (p) => {
  const ext = path.extname(p).toLowerCase().slice(1);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  return "image/png";
};

const refParts = [];
for (const rel of character.photos.slice(0, 3)) {
  try {
    const buf = await fs.readFile(path.join(projectRoot, "public", rel));
    refParts.push({ inlineData: { mimeType: mimeFor(rel), data: buf.toString("base64") } });
  } catch { console.warn(`  ref photo missing, skipping: ${rel}`); }
}
if (!refParts.length) { console.error("No usable reference photos — aborting."); process.exit(1); }

const outDir = path.join(projectRoot, "public", presenter.poseDir);
await fs.mkdir(outDir, { recursive: true });

const poseExists = (rel) => {
  const abs = rel.startsWith(presenter.poseDir) ? path.join(projectRoot, "public", rel) : path.join(outDir, rel);
  try { accessSync(abs); return true; } catch { return false; }
};
// FORCE regenerates every distinct pose file; otherwise skip existing.
const jobs = FORCE
  ? posesToGenerate(presenter, () => false)
  : posesToGenerate(presenter, poseExists);

if (!jobs.length) { console.log("All presenter poses already exist. Use --force to regenerate."); process.exit(0); }

const ai = new GoogleGenAI({ vertexai: true, project: cfg.gcp.project, location: cfg.gcp.imageLocation });
const MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

// BOTH styles (flat-vector cartoon AND photoreal) are generated on a chroma-green
// screen and keyed to a TRANSPARENT PNG here, so the mascot composites onto the
// card with NO visible rectangle — this is what lets the same (mask-free)
// composition serve a cartoon-Jurie video and a photoreal-Jurie video.
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const CUTOUT = hasFfmpeg;
if (!hasFfmpeg) {
  console.warn("  ⚠ ffmpeg not found — poses will keep their green background (install ffmpeg to key it out).");
}
// Key #00FF00 → alpha, soften the edge a touch, drop residual green spill.
// Reads the green tmp file next to `absPath`, writes the transparent result.
const keyGreen = (absPath) => {
  const tmp = `${absPath}.green.png`;
  const r = spawnSync("ffmpeg", [
    "-y", "-i", tmp,
    "-vf", "chromakey=0x00FF00:0.30:0.12,despill=type=green,format=rgba",
    absPath,
  ], { stdio: "ignore" });
  return r.status === 0;
};

// Generate the "base" pose FIRST, then feed it back as a reference for every
// other pose so the character (face, glasses, cap, hair, T-shirt, art style)
// stays IDENTICAL and only the gesture changes — otherwise each independent
// gen drifts (different outfit/frames/proportions).
jobs.sort((a, b) => (b.file.includes("base") ? 1 : 0) - (a.file.includes("base") ? 1 : 0));

console.log(`Generating ${jobs.length} presenter pose(s) for ${cfg.brandName} from ${refParts.length} ref photo(s)…`);
let ok = 0;
let anchor = null; // {inlineData} of the first cartoon pose — the consistency lock
for (const job of jobs) {
  const basePrompt = job.prompt || posePrompt(job.file, cfg.brandName, cfg.presenter.style);
  const prompt = anchor
    ? basePrompt +
      " CRITICAL CONSISTENCY: this is the EXACT SAME cartoon mascot shown in the LAST reference image — " +
      "keep her face, glasses, cap, hair, skin tone, the grey T-shirt and the exact flat-vector art style " +
      "100% IDENTICAL to that reference; change ONLY the hand gesture and expression."
    : basePrompt;
  const parts = anchor ? [...refParts, anchor, { text: prompt }] : [...refParts, { text: prompt }];
  let buf = null;
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }] });
      const rp = resp.candidates?.[0]?.content?.parts || [];
      for (const p of rp) if (p.inlineData?.data) { buf = Buffer.from(p.inlineData.data, "base64"); break; }
      if (!buf) console.warn(`  ${job.file}: no image (attempt ${attempt}/3)`);
    } catch (err) {
      console.warn(`  ${job.file}: ${String(err.message || err).slice(0, 100)} (attempt ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  if (!buf) { console.error(`  ✗ FAILED ${job.file}`); continue; }
  // First successful pose (base) becomes the appearance anchor for the rest.
  if (!anchor) anchor = { inlineData: { mimeType: "image/png", data: buf.toString("base64") } };
  const absOut = path.join(outDir, job.file);
  if (CUTOUT && hasFfmpeg) {
    // Write the raw green frame to a tmp, key it to a transparent PNG, clean up.
    const tmp = `${absOut}.green.png`;
    await fs.writeFile(tmp, buf);
    const keyed = keyGreen(absOut);
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (!keyed) { await fs.writeFile(absOut, buf); console.warn(`  ⚠ ${job.file}: green-key failed, kept raw`); }
  } else {
    await fs.writeFile(absOut, buf);
  }
  ok++;
  console.log(`  ✓ ${presenter.poseDir}/${job.file}${CUTOUT && hasFfmpeg ? " (transparent)" : ""}`);
}
console.log(`\n✓ ${ok}/${jobs.length} presenter pose(s) written to public/${presenter.poseDir}/`);
console.log(`Review them, then regenerate any that drift with --force after deleting the file.`);
process.exit(ok === 0 ? 1 : 0);
