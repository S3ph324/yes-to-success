#!/usr/bin/env node
// Generate background images for image-variant quote cards via Vertex AI.
//
// Two paths:
//   - DEFAULT: Imagen 4 Fast (text-to-image, no character refs)
//   - IF DASHBOARD_USE_CHARACTERS=1 and characters configured:
//     Gemini Flash Image (multimodal, accepts ref photos) → keeps the same
//     character across all image-variant cards in the batch.
//
// Uses Application Default Credentials (ADC). Runs against the $300 trial
// credit pool (Cloud billing).
//
// Required env vars:
//   GOOGLE_CLOUD_PROJECT   - billing-enabled GCP project ID
//   GOOGLE_CLOUD_LOCATION  - region (default us-central1)
// Optional:
//   DASHBOARD_USE_CHARACTERS=1   - switch to ref-image gen
//   IMAGE_MODEL                  - override default Imagen model
//   REF_MODEL                    - override default Gemini Flash Image model
//
// Usage:
//   GOOGLE_CLOUD_PROJECT=... node scripts/generate-backgrounds.mjs <quotes.json>

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
if (!project) {
  console.error("Missing GOOGLE_CLOUD_PROJECT");
  process.exit(1);
}

const quotesArg = process.argv[2];
if (!quotesArg) {
  console.error("Usage: node scripts/generate-backgrounds.mjs <quotes.json>");
  process.exit(1);
}
const quotesPath = path.isAbsolute(quotesArg)
  ? quotesArg
  : path.join(process.cwd(), quotesArg);
const quotes = JSON.parse(await fs.readFile(quotesPath, "utf-8"));

const imageQuotes = quotes
  .map((q, idx) => ({ ...q, _idx: idx }))
  .filter((q) => q.variant === "image" && q.bgPrompt);

if (imageQuotes.length === 0) {
  console.log("No image-variant quotes to generate backgrounds for.");
  process.exit(0);
}

// Check for character refs
const useCharacters = process.env.DASHBOARD_USE_CHARACTERS === "1";
let activeCharacter = null;
if (useCharacters) {
  try {
    const charsAll = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, "config", "characters.json"),
        "utf-8",
      ),
    );
    const enabled = charsAll.filter(
      (c) => c.enabled && c.photos?.length > 0,
    );
    if (enabled.length > 0) {
      activeCharacter = enabled[0];
      console.log(
        `Using character reference: "${activeCharacter.name}" (${activeCharacter.photos.length} photo${activeCharacter.photos.length !== 1 ? "s" : ""})`,
      );
    } else {
      console.log(
        "DASHBOARD_USE_CHARACTERS set but no enabled characters with photos — falling back to text-to-image.",
      );
    }
  } catch {
    console.log("No characters config — using text-to-image.");
  }
}

const stem = path.basename(quotesPath, ".json");
const bgRelDir = path.join("generated-bg", stem);
const bgDir = path.join(projectRoot, "public", bgRelDir);
await fs.mkdir(bgDir, { recursive: true });

const ai = new GoogleGenAI({ vertexai: true, project, location });

const IMAGEN_MODEL = process.env.IMAGE_MODEL || "imagen-4.0-fast-generate-001";
const REF_MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image-preview";

const universalSuffix =
  ", cinematic, professional photography, warm gold and deep red color " +
  "palette, dramatic lighting, shallow depth of field, no text, no logos, " +
  "negative space for overlay text, atmospheric, high contrast";

const aspectToImagen = (a) => {
  if (a === "1:1") return "1:1";
  if (a === "9:16") return "9:16";
  return "3:4";
};
const aspectToPromptHint = (a) => {
  if (a === "1:1") return ", square 1:1 composition";
  if (a === "9:16") return ", vertical 9:16 composition";
  return ", vertical 4:5 portrait composition";
};

// Read a character photo as inlineData for the multimodal call.
const loadCharacterPart = async (char) => {
  const photoRel = char.photos[0]; // primary photo
  const fullPath = path.join(projectRoot, "public", photoRel);
  const buf = await fs.readFile(fullPath);
  const ext = path.extname(photoRel).toLowerCase().slice(1);
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : "image/png";
  return {
    inlineData: { mimeType: mime, data: buf.toString("base64") },
  };
};

const generateImagen = async (prompt, aspectRatio) => {
  const resp = await ai.models.generateImages({
    model: IMAGEN_MODEL,
    prompt,
    config: {
      numberOfImages: 1,
      aspectRatio,
      personGeneration: "allow_adult",
    },
  });
  const img = resp.generatedImages?.[0]?.image;
  return img?.imageBytes ? Buffer.from(img.imageBytes, "base64") : null;
};

const generateRefImage = async (prompt, character) => {
  const refPart = await loadCharacterPart(character);
  const guidance =
    `Use the person shown in this reference photo as the subject of a new ` +
    `cinematic scene. Keep their face, appearance, and identity consistent. ` +
    `Scene description: ${prompt}. Render as a high-quality photograph.`;
  const resp = await ai.models.generateContent({
    model: REF_MODEL,
    contents: [
      {
        role: "user",
        parts: [refPart, { text: guidance }],
      },
    ],
  });
  const parts = resp.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return Buffer.from(part.inlineData.data, "base64");
    }
  }
  return null;
};

const mode = activeCharacter ? "ref-image" : "text-to-image";
const modelName = activeCharacter ? REF_MODEL : IMAGEN_MODEL;
console.log(
  `Generating ${imageQuotes.length} background(s) via Vertex AI` +
    ` (${modelName}, ${mode}) in ${location}…`,
);

for (const q of imageQuotes) {
  const fname = `bg-${String(q._idx + 1).padStart(2, "0")}.png`;
  const outPath = path.join(bgDir, fname);
  const aspectRatio = aspectToImagen(q.aspectRatio || "4:5");
  const fullPrompt = `${q.bgPrompt}${universalSuffix}${aspectToPromptHint(q.aspectRatio || "4:5")}`;

  try {
    const tStart = Date.now();
    const buf = activeCharacter
      ? await generateRefImage(fullPrompt, activeCharacter)
      : await generateImagen(fullPrompt, aspectRatio);
    if (!buf) {
      console.warn(`  [${q._idx + 1}] no image returned, skipping`);
      continue;
    }
    await fs.writeFile(outPath, buf);
    quotes[q._idx].bgPath = path.join(bgRelDir, fname);
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(
      `  [${q._idx + 1}/${imageQuotes.length}] ${fname} ${aspectRatio} (${dt}s)`,
    );
  } catch (err) {
    const msg = err?.message ? String(err.message).slice(0, 200) : String(err);
    console.warn(`  [${q._idx + 1}] failed: ${msg}`);
  }
}

await fs.writeFile(quotesPath, JSON.stringify(quotes, null, 2));
console.log(`\n✓ Backgrounds saved to ${bgDir}`);
console.log(`✓ Updated ${quotesPath}`);
