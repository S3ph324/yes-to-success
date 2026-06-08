#!/usr/bin/env node
// Multi-client scene-background generator via Vertex AI Gemini Flash Image
// ("Nano Banana"). If the client has a character (e.g. Jurie), her reference
// photos lock her identity as the subject. If the client has no character
// (e.g. Tranzzie), it generates a matching lifestyle/product scene instead.
// John Calub's original generate-backgrounds.mjs is separate and untouched.
//
// Usage:
//   node scripts/generate-backgrounds-jurie.mjs [--client id] <quotes.json>

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyGcpEnv,
  projectRoot,
  resolveClient,
  takeClientArg,
} from "./lib/client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

const { client: clientArg, rest } = takeClientArg(process.argv.slice(2));
const client = await resolveClient(clientArg);

const quotesArg = rest[0];
if (!quotesArg) {
  console.error(
    "Usage: node scripts/generate-backgrounds-jurie.mjs [--client id] <quotes.json>",
  );
  process.exit(1);
}
const quotesPath = path.isAbsolute(quotesArg)
  ? quotesArg
  : path.join(process.cwd(), quotesArg);
const quotes = JSON.parse(await fs.readFile(quotesPath, "utf-8"));

// Eyeglasses-showcase mode (Tranzzie only): the dashboard sets
// DASHBOARD_EYEGLASSES_ID when posterType === "eyeglasses". In that mode the
// reference subject is a PRODUCT (a specific frame) instead of a person —
// swap the character lookup for an eyeglasses-asset lookup and the guidance
// prompt for a product-accurate one further down.
const eyeglassesMode = !!process.env.DASHBOARD_EYEGLASSES_ID;
const wantGlassesId = process.env.DASHBOARD_EYEGLASSES_ID || "";
let eyeglasses = null;
if (eyeglassesMode && wantGlassesId) {
  try {
    const all = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, "config", "eyeglasses.json"),
        "utf-8",
      ),
    );
    eyeglasses = all.find((g) => g.id === wantGlassesId) || null;
  } catch {
    /* none */
  }
}

// Resolve the character. The dashboard can override the client default
// via DASHBOARD_CHARACTER_ID ("" = scene-only, no character). Skipped
// entirely in eyeglasses mode — the product is the subject, not a person.
const envChar = process.env.DASHBOARD_CHARACTER_ID;
const wantCharId =
  envChar !== undefined && envChar !== null ? envChar : client.characterId;
let character = null;
if (!eyeglassesMode && wantCharId && wantCharId !== "none") {
  try {
    const chars = JSON.parse(
      await fs.readFile(
        path.join(projectRoot, "config", "characters.json"),
        "utf-8",
      ),
    );
    character = chars.find((c) => c.id === wantCharId) || null;
  } catch {
    /* none */
  }
}

const mimeFor = (p) => {
  const ext = path.extname(p).toLowerCase().slice(1);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  return "image/png";
};

// Per-run extra references uploaded from the dashboard override the
// character's saved photos for this batch only.
let extraRefs = [];
try {
  if (process.env.DASHBOARD_EXTRA_REFS) {
    const parsed = JSON.parse(process.env.DASHBOARD_EXTRA_REFS);
    if (Array.isArray(parsed)) extraRefs = parsed;
  }
} catch {
  /* malformed env — ignore */
}
const refParts = [];
const subjectPhotos = eyeglassesMode
  ? eyeglasses?.photos || []
  : character?.photos || [];
const refSources =
  extraRefs.length > 0
    ? extraRefs.slice(0, 3).map((p) => ({ abs: true, p }))
    : subjectPhotos.slice(0, 3).map((p) => ({ abs: false, p }));
for (const { abs, p } of refSources) {
  const full = abs ? p : path.join(projectRoot, "public", p);
  try {
    const buf = await fs.readFile(full);
    refParts.push({
      inlineData: { mimeType: mimeFor(p), data: buf.toString("base64") },
    });
  } catch {
    console.warn(`  ref photo missing, skipping: ${p}`);
  }
}
const hasRef = refParts.length > 0;

const stem = path.basename(quotesPath, ".json");
const bgRelDir = path.join("generated-bg", stem);
const bgDir = path.join(projectRoot, "public", bgRelDir);
await fs.mkdir(bgDir, { recursive: true });

const ai = new GoogleGenAI({ vertexai: true, project, location });
const REF_MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

const STYLE =
  "Cinematic candid documentary photograph, natural available light, " +
  "shallow depth of field, realistic, photojournalistic. Subject NOT " +
  "looking at the camera. Vertical 4:5 portrait composition. Keep the top " +
  "~30% and bottom ~35% darker and visually simple (clean negative space " +
  "for a text overlay that is added later). " +
  "ABSOLUTELY NO text anywhere in the image: no letters, words, numbers, " +
  "captions, subtitles, quotes, slogans, signage, store signs, billboards, " +
  "posters, labels, packaging text, screen text, brand names, logos, or " +
  "watermarks. Any signs, screens, papers, or packaging must be blank, " +
  "out of focus, or cropped out. The photo must contain zero readable text.";

// Skip entries flagged useFlatBg=true (those posters render with the flat
// gradient background instead of an AI photo — saves a Nano Banana call
// per skipped poster and gives the batch visual variety).
const targets = quotes
  .map((q, i) => ({ q, i }))
  .filter((x) => x.q.bgPrompt && !x.q.useFlatBg);

console.log(
  `Generating ${targets.length} ${client.label} background(s) via ${REF_MODEL}` +
    (hasRef
      ? ` (${refParts.length} ref photo${refParts.length > 1 ? "s" : ""}` +
        (eyeglassesMode ? `, frame: ${eyeglasses?.name || wantGlassesId}` : "") +
        `)`
      : eyeglassesMode
        ? ` (no reference photos for this frame yet — generic eyeglasses scene)`
        : " (no character — scene only)") +
    ` in ${location}…`,
);

for (const { q, i } of targets) {
  const fname = `bg-${String(i + 1).padStart(2, "0")}.png`;
  const outPath = path.join(bgDir, fname);
  // Eyeglasses-showcase entries carry a `tagline` (the vibe/feeling — e.g.
  // "Your everyday pair, elevated.") which steers the SCENE mood better than
  // `quote` (a clean product-name line meant for on-poster type, not imagery).
  const sceneVibe = eyeglassesMode ? q.tagline || q.quote : q.quote;
  const guidance = eyeglassesMode
    ? hasRef
      ? `Feature the EXACT pair of eyeglasses shown in these reference photos ` +
        `as the hero product — match its frame shape, color, lens tint, and ` +
        `details perfectly; do not redesign or substitute a different pair. ` +
        `Place it in this scene: ${q.bgPrompt}. The product must be clearly ` +
        `visible, in sharp focus, and instantly recognizable as the same ` +
        `pair shown in the references. The scene must clearly visually ` +
        `evoke this feeling: "${sceneVibe}". ${STYLE}`
      : `Create a product-showcase photograph featuring a stylish pair of ` +
        `eyeglasses as the hero subject, in this scene: ${q.bgPrompt}. ` +
        `The eyeglasses must be clearly visible, in sharp focus, and the ` +
        `main focal point of the frame. The scene must clearly visually ` +
        `evoke this feeling: "${sceneVibe}". ${STYLE}`
    : hasRef
      ? `Use the SAME person shown in these reference photos as the subject — ` +
        `keep their face, hair, and identity perfectly consistent and clearly ` +
        `recognizable. Place them in this scene: ${q.bgPrompt}. ` +
        `The scene must clearly visually express this message so a viewer ` +
        `instantly gets it: "${q.quote}". ${STYLE}`
      : `Create a photograph of this scene: ${q.bgPrompt}. ` +
        `It must clearly visually express this message so a viewer instantly ` +
        `gets it: "${q.quote}". ${STYLE}`;
  const t0 = Date.now();
  let buf = null;
  let lastErr = "";
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: REF_MODEL,
        contents: [
          {
            role: "user",
            parts: hasRef
              ? [...refParts, { text: guidance }]
              : [{ text: guidance }],
          },
        ],
      });
      const parts = resp.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          buf = Buffer.from(p.inlineData.data, "base64");
          break;
        }
      }
      if (!buf) {
        lastErr = "no image in response";
        console.warn(
          `  [${i + 1}] attempt ${attempt}/${MAX_TRIES}: ${lastErr}` +
            (attempt < MAX_TRIES ? " — retrying…" : ""),
        );
      }
    } catch (err) {
      lastErr = err?.message ? String(err.message).slice(0, 160) : String(err);
      console.warn(
        `  [${i + 1}] attempt ${attempt}/${MAX_TRIES} failed: ${lastErr}` +
          (attempt < MAX_TRIES ? " — retrying…" : ""),
      );
    }
    if (!buf && attempt < MAX_TRIES) {
      await new Promise((r) => setTimeout(r, 2500 * attempt));
    }
  }
  if (!buf) {
    console.warn(`  [${i + 1}] GAVE UP after ${MAX_TRIES} tries (${lastErr})`);
    continue;
  }
  await fs.writeFile(outPath, buf);
  quotes[i].bgPath = path.join(bgRelDir, fname);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  [${i + 1}/${targets.length}] ${fname} (${dt}s)`);
}

await fs.writeFile(quotesPath, JSON.stringify(quotes, null, 2));
console.log(`\n✓ Backgrounds → ${bgDir}`);
console.log(`✓ Updated ${quotesPath}`);
