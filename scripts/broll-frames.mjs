#!/usr/bin/env node
// Generate the FIRST-FRAME image for b-roll shots with Nano Banana
// (gemini-2.5-flash-image). Shots flagged usesCharacter get the character's
// reference photos attached so the person stays consistent.
//
// Exports per-shot and batch helpers consumed by the dashboard API. Still
// runnable as a CLI for direct testing.
//
// CLI:
//   node scripts/broll-frames.mjs <broll.json>              # all shots (skip done)
//   node scripts/broll-frames.mjs <broll.json> --shot 3     # just shot n=3
//   node scripts/broll-frames.mjs <broll.json> --force      # regenerate all

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

applyGcpEnv();

const REF_MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

const aiClient = () =>
  new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
  });

// Resolve the frames output directory (abs + relative-as-URL-prefix).
// John Calub server passes its volume path here; CLI defaults match studio.
const resolveFrameDirs = (jsonPath, options = {}) => {
  const stem = path.basename(jsonPath, ".json");
  const relDir =
    options.framesOutDirRel != null
      ? path.join(options.framesOutDirRel, stem)
      : path.join("broll-frames", stem);
  const absDir =
    options.framesOutDirAbs != null
      ? path.join(options.framesOutDirAbs, stem)
      : path.join(projectRoot, "public", "broll-frames", stem);
  return { relDir, absDir, stem };
};

// Load up to 3 character reference image parts (for the optional
// reference-image character mode). Returns inlineData parts ready for
// generateContent. Empty array when no character is set or none load.
export async function loadCharacterRefs(data, options = {}) {
  const refParts = [];
  const charId = data?.meta?.characterId || "";
  if (!charId) return refParts;
  const charactersPath =
    options.charactersPath ||
    path.join(projectRoot, "config", "characters.json");
  let chars = [];
  try {
    chars = JSON.parse(await fs.readFile(charactersPath, "utf-8"));
  } catch {
    return refParts;
  }
  const ch = chars.find((c) => c.id === charId);
  const photoRootAbs =
    options.photoRootAbs || path.join(projectRoot, "public");
  for (const rel of (ch?.photos || []).slice(0, 3)) {
    const full = path.isAbsolute(rel) ? rel : path.join(photoRootAbs, rel);
    try {
      const buf = await fs.readFile(full);
      const ext = path.extname(rel).toLowerCase().slice(1);
      const mime =
        ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : "image/png";
      refParts.push({
        inlineData: { mimeType: mime, data: buf.toString("base64") },
      });
    } catch {
      /* skip missing */
    }
  }
  return refParts;
}

// Generate ONE shot's first-frame image and write shot-NN.png to absDir.
// Sets shot.framePath on the shot object (caller persists the JSON).
// Returns: { ok: true, framePath } | { ok: false, error }.
export async function generateOneShot({
  shot,
  refParts,
  ai,
  absDir,
  relDir,
}) {
  const fname = `shot-${String(shot.n).padStart(2, "0")}.png`;
  const outPath = path.join(absDir, fname);
  const useChar = shot.usesCharacter && refParts.length > 0;
  const text = useChar
    ? `${shot.imagePrompt}\n\nUse the provided reference image for the character — preserve their face, hair, wardrobe and proportions exactly. Do not invent any character features.`
    : shot.imagePrompt;
  const parts = useChar ? [...refParts, { text }] : [{ text }];

  let buf = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: REF_MODEL,
        contents: [{ role: "user", parts }],
      });
      for (const p of resp.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) {
          buf = Buffer.from(p.inlineData.data, "base64");
          break;
        }
      }
      if (!buf) lastErr = "no image in response";
    } catch (err) {
      lastErr = err?.message ? String(err.message).slice(0, 200) : String(err);
    }
    if (!buf && attempt < 3)
      await new Promise((r) => setTimeout(r, 2500 * attempt));
  }
  if (!buf) return { ok: false, error: lastErr || "image generation failed" };

  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(outPath, buf);
  shot.framePath = path.join(relDir, fname);
  return { ok: true, framePath: shot.framePath };
}

// Generate ONE shot by its 1-based `n`. Loads the broll JSON, generates the
// image, persists the JSON. Used by POST /api/broll/:stamp/shots/:n/generate-image.
export async function generateShotImage(jsonPath, n, options = {}) {
  const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
  const shot = (data.shots || []).find((s) => s.n === Number(n));
  if (!shot) throw new Error(`Shot n=${n} not found in ${jsonPath}`);
  const refParts = await loadCharacterRefs(data, options);
  const { relDir, absDir } = resolveFrameDirs(jsonPath, options);
  await fs.mkdir(absDir, { recursive: true });
  const ai = aiClient();
  const result = await generateOneShot({ shot, refParts, ai, absDir, relDir });
  await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));
  return result;
}

// Generate every shot's image. With onlyMissing=true (default), shots that
// already have a framePath are skipped — so re-runs are safe and cheap.
// Used by POST /api/broll/:stamp/generate-all-images.
export async function generateAllShotImages(jsonPath, options = {}) {
  const onlyMissing = options.onlyMissing !== false;
  const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
  const shots = data.shots || [];
  const refParts = await loadCharacterRefs(data, options);
  const { relDir, absDir } = resolveFrameDirs(jsonPath, options);
  await fs.mkdir(absDir, { recursive: true });
  const ai = aiClient();
  const results = [];
  let generated = 0;
  let failed = 0;
  let skipped = 0;
  for (const shot of shots) {
    if (onlyMissing && shot.framePath) {
      results.push({ n: shot.n, skipped: true, framePath: shot.framePath });
      skipped++;
      continue;
    }
    const r = await generateOneShot({
      shot,
      refParts,
      ai,
      absDir,
      relDir,
    });
    results.push({ n: shot.n, ...r });
    if (r.ok) generated++;
    else failed++;
    // Persist incrementally so we don't lose work on a mid-batch crash.
    await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));
  }
  return { results, generated, failed, skipped, total: shots.length };
}

// CLI wrapper — only runs when this file is the entrypoint, not when imported.
const isMain =
  process.argv[1] &&
  url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const jsonArg = args.find((a) => !a.startsWith("--"));
  if (!jsonArg) {
    console.error(
      "Usage: node scripts/broll-frames.mjs <broll.json> [--shot <n>] [--force]",
    );
    process.exit(1);
  }
  const jsonPath = path.isAbsolute(jsonArg)
    ? jsonArg
    : path.join(process.cwd(), jsonArg);
  const shotIdx = args.indexOf("--shot");
  const force = args.includes("--force");
  try {
    if (shotIdx !== -1 && args[shotIdx + 1]) {
      const n = parseInt(args[shotIdx + 1], 10);
      const r = await generateShotImage(jsonPath, n);
      if (r.ok) console.log(`✓ shot ${n} → ${r.framePath}`);
      else {
        console.error(`✗ shot ${n}: ${r.error}`);
        process.exit(1);
      }
    } else {
      const r = await generateAllShotImages(jsonPath, {
        onlyMissing: !force,
      });
      console.log(
        `✓ ${r.generated} generated, ${r.skipped} skipped, ${r.failed} failed (total ${r.total})`,
      );
      if (r.failed > 0) process.exit(1);
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
}
