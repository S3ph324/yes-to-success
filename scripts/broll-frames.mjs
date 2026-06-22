#!/usr/bin/env node
// Generate the FIRST-FRAME image for every b-roll shot with Nano Banana
// (gemini-2.5-flash-image). Shots flagged usesCharacter get the character's
// reference photos attached so the person stays consistent.
//
// Usage: node scripts/broll-frames.mjs out/broll-<stamp>.json

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const REF_MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/broll-frames.mjs <broll.json>");
  process.exit(1);
}
const jsonPath = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
const shots = data.shots || [];

// Character refs — a SESSION character generated for THIS set (from uploaded
// reference photos) takes precedence; otherwise a saved character selected at
// analyze time.
let refParts = [];
const sessionChar = data.meta?.sessionCharacter || [];
for (const rel of sessionChar.slice(0, 3)) {
  try {
    const buf = await fs.readFile(path.join(projectRoot, "public", rel));
    const ext = path.extname(rel).toLowerCase().slice(1);
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    refParts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
  } catch {
    /* skip missing session character */
  }
}
const charId = data.meta?.characterId || "";
if (!refParts.length && charId) {
  try {
    const chars = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, "config", "characters.json"),
        "utf-8",
      ),
    );
    const ch = chars.find((c) => c.id === charId);
    for (const rel of (ch?.photos || []).slice(0, 3)) {
      const full = path.join(projectRoot, "public", rel);
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
  } catch {
    /* no characters config */
  }
}

const stem = path.basename(jsonPath, ".json");
const relDir = path.join("broll-frames", stem);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const ai = new GoogleGenAI({ vertexai: true, project, location });

console.log(
  `Generating ${shots.length} first frame(s) via ${REF_MODEL}` +
    (refParts.length ? ` (character: ${refParts.length} ref)` : "") +
    ` in ${location}…`,
);

for (const s of shots) {
  const fname = `shot-${String(s.n).padStart(2, "0")}.png`;
  const outPath = path.join(absDir, fname);
  const useChar = s.usesCharacter && refParts.length > 0;
  const text = useChar
    ? `${s.imagePrompt}\n\nUse the provided reference image for the character — preserve their face, hair, wardrobe and proportions exactly. Do not invent any character features.`
    : s.imagePrompt;
  const parts = useChar ? [...refParts, { text }] : [{ text }];
  let buf = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: REF_MODEL,
        contents: [{ role: "user", parts }],
        // Lock the API-level aspect ratio. The SDK falls back to the
        // model's default (usually 1:1) if this isn't passed — that's why
        // the "Vertical 9:16 composition" in the prompt text was being
        // ignored. Pulled from the JSON meta so script/video aspect wins.
        config: {
          imageConfig: { aspectRatio: data.meta?.aspect || "9:16" },
        },
      });
      for (const p of resp.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) {
          buf = Buffer.from(p.inlineData.data, "base64");
          break;
        }
      }
      if (!buf) {
        lastErr = "no image in response";
        if (attempt < 3) console.warn(`  [${s.n}] retry (${lastErr})…`);
      }
    } catch (err) {
      lastErr = err?.message ? String(err.message).slice(0, 150) : String(err);
      if (attempt < 3) console.warn(`  [${s.n}] retry (${lastErr})…`);
    }
    if (!buf && attempt < 3)
      await new Promise((r) => setTimeout(r, 2500 * attempt));
  }
  if (!buf) {
    console.warn(`  [${s.n}] FAILED: ${lastErr}`);
    continue;
  }
  await fs.writeFile(outPath, buf);
  s.framePath = path.join(relDir, fname);
  console.log(`  [${s.n}/${shots.length}] ${fname}`);
}

await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));
console.log(`\n✓ Frames → ${absDir}\n✓ Updated ${jsonPath}`);
