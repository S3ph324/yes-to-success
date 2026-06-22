#!/usr/bin/env node
// Generate ONE consistent CHARACTER REFERENCE image for a B-Roll set from the
// user's uploaded reference photos (Nano Banana / gemini-2.5-flash-image), so
// every scene that needs a person can stay on-model. Writes the image to
// public/broll-characters/<stamp>/character.png and records it in the set's JSON
// as meta.sessionCharacter (which broll-frames.mjs then uses as the reference).
//
// The dashboard stages the uploaded refs into public/broll-characters/<stamp>/refs/
// first, then runs:  node scripts/broll-character.mjs --stamp <stamp> --aspect 9:16
// Re-running overwrites character.png (regenerate).

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const REF_MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

const flag = (n, d = "") => {
  const i = process.argv.indexOf(n);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const stamp = flag("--stamp", "");
const aspect = flag("--aspect", "9:16") === "16:9" ? "16:9" : "9:16";
if (!stamp) {
  console.error("--stamp <stamp> required");
  process.exit(1);
}

const mimeFor = (p) => {
  const e = path.extname(p).toLowerCase().slice(1);
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "webp") return "image/webp";
  if (e === "heic") return "image/heic";
  if (e === "heif") return "image/heif";
  return "image/png";
};

const charDir = path.join(projectRoot, "public", "broll-characters", stamp);
const refsDir = path.join(charDir, "refs");
let refFiles = [];
try {
  refFiles = (await fs.readdir(refsDir)).filter((f) => /\.(png|jpe?g|webp|heic|heif)$/i.test(f)).sort();
} catch {
  /* none */
}
if (!refFiles.length) {
  console.error(`No reference photos in ${refsDir} — upload at least one.`);
  process.exit(1);
}
const refParts = [];
for (const f of refFiles.slice(0, 4)) {
  try {
    const buf = await fs.readFile(path.join(refsDir, f));
    refParts.push({ inlineData: { mimeType: mimeFor(f), data: buf.toString("base64") } });
  } catch {
    /* skip unreadable */
  }
}
if (!refParts.length) {
  console.error("Could not read any reference photos.");
  process.exit(1);
}

const prompt =
  "Create ONE clean, consistent CHARACTER REFERENCE portrait of the SAME person " +
  "shown in the provided photo(s). Preserve their face, hair, skin tone and " +
  "identity EXACTLY — it must obviously be the same person. Front-facing, " +
  "head-and-shoulders to upper body, calm natural expression, looking toward the " +
  "camera. Plain neutral soft-grey studio backdrop, soft even lighting, " +
  "photorealistic, sharp focus on the face. The person is fully and tastefully " +
  "clothed. No text, logos, or watermarks anywhere. This is a clean reference " +
  "image used to keep the character consistent across later b-roll scenes.";

const ai = new GoogleGenAI({ vertexai: true, project, location });
await fs.mkdir(charDir, { recursive: true });
console.log(`Generating character from ${refParts.length} reference(s), ${aspect}, in ${location}…`);

let buf = null;
let lastErr = "";
for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
  try {
    const resp = await ai.models.generateContent({
      model: REF_MODEL,
      contents: [{ role: "user", parts: [...refParts, { text: prompt }] }],
      config: { imageConfig: { aspectRatio: aspect } },
    });
    for (const p of resp.candidates?.[0]?.content?.parts || []) {
      if (p.inlineData?.data) {
        buf = Buffer.from(p.inlineData.data, "base64");
        break;
      }
    }
    if (!buf) throw new Error("no image in response");
  } catch (e) {
    lastErr = String(e?.message || e).slice(0, 160);
    if (attempt < 3) {
      console.warn(`  retry (${lastErr})…`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}
if (!buf) {
  console.error(`✗ Character generation failed: ${lastErr}`);
  process.exit(1);
}

const rel = path.posix.join("broll-characters", stamp, "character.png");
await fs.writeFile(path.join(projectRoot, "public", rel), buf);

// Record it in the set's working JSON so broll-frames uses it as the reference.
const jsonPath = path.join(projectRoot, "out", `broll-${stamp}.json`);
try {
  const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
  data.meta = data.meta || {};
  data.meta.sessionCharacter = [rel];
  await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));
} catch (e) {
  console.warn(`  could not update set JSON: ${e?.message || e}`);
}

console.log(`✓ Character → ${rel}`);
