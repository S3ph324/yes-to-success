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

// ── Persistent-volume awareness ───────────────────────────────────────────────
// On Railway the user's runtime data lives in the persistent volume mounted at
// EXPORT_BASE (e.g. /app/exports), NOT in the Docker-image root (/app).
// Child processes inherit EXPORT_BASE from the dashboard server, so we can use
// it to locate eyeglasses.json and the uploaded reference photos.
// The generated-bg images (intermediate render inputs) stay at projectRoot/public/
// — they're ephemeral, recreated each run, and Remotion reads from there.
const PERSIST_BASE = process.env.EXPORT_BASE
  ? path.join(process.env.EXPORT_BASE, "_studio-data")
  : projectRoot;
const persistConfig = path.join(PERSIST_BASE, "config");
const persistPublic = path.join(PERSIST_BASE, "public");
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
const eyeglassesMode  = !!process.env.DASHBOARD_EYEGLASSES_ID;
const wantGlassesId   = process.env.DASHBOARD_EYEGLASSES_ID || "";
const ePosterStyle    = process.env.DASHBOARD_EYEGLASSES_STYLE       || "showcase";
const ePlacement      = process.env.DASHBOARD_EYEGLASSES_PLACEMENT   || "auto";
const eStyleKey       = process.env.DASHBOARD_EYEGLASSES_STYLE_KEY   || "";
const eModelStyle     = process.env.DASHBOARD_EYEGLASSES_MODEL_STYLE || "outdoor_lifestyle";

// ── Placement directives ──────────────────────────────────────────────────────
const PLACEMENT_DIRECTIVE = {
  standing:
    "The eyeglasses must be positioned upright and standing tall, front-facing " +
    "so both lenses and the full frame outline are clearly visible. " +
    "The temples rest on the surface below the frame.",
  flat:
    "The eyeglasses must be lying flat — a flat-lay composition photographed " +
    "from above or a low angle, with the full frame and lens surface clearly visible.",
  floating:
    "The eyeglasses must appear to float mid-air with no surface contact — " +
    "suspended in space, creating a dramatic levitation effect.",
  auto: "",   // Gemini chooses the best placement for the scene
};

// ── Visual style-key directives ───────────────────────────────────────────────
const STYLE_KEY_DIRECTIVE = {
  // — standing —
  minimalist_white:
    "Pure white or near-white seamless backdrop. " +
    "Razor-sharp drop shadows beneath the frame, even frontal studio lighting.",
  dark_luxury:
    "Deep black or charcoal seamless background. " +
    "Dramatic single side-key light that rakes across the frame revealing texture.",
  soft_gradient:
    "Background is a soft pastel or warm-toned gradient wash — no hard edges. " +
    "Gentle diffused lighting, airy and clean.",
  editorial_flat:
    "Clean overhead editorial shot on a subtle surface texture (matte paper or linen). " +
    "Natural side light, slight depth.",
  // — flat —
  overhead_marble:
    "Flat-lay on a marble or polished stone surface. " +
    "Top-down camera angle, natural light from the side, cool premium feel.",
  fabric_texture:
    "Flat-lay on a linen, velvet, or soft woven fabric. " +
    "Soft diffused light, warm and tactile — texture visible but not distracting.",
  dark_matte:
    "Flat-lay on a matte black or very dark surface. " +
    "Subtle product reflection below the frame, moody low-key lighting.",
  styled_props:
    "Flat-lay with a few minimal brand-style props around the frame " +
    "(e.g. sprig of greenery, small fabric swatch, geometric shape). " +
    "Props are secondary — the frame is the clear hero.",
  // — floating —
  clean_float:
    "Frame floats against a pure white or off-white seamless void. " +
    "Soft even studio light, no background elements — pure product hero.",
  neon_glow:
    "Dark dramatic scene. A colored neon rim light (blue, purple, or amber) " +
    "glows around the frame edges. High contrast, editorial.",
  misty_depth:
    "Moody atmospheric fog or haze fills the frame. " +
    "Dramatic light source partially cutting through the mist.",
  gradient_float:
    "Vivid or pastel gradient sky behind the frame. " +
    "The frame floats centrally, slightly angled, bold and graphic.",
};

// ── Model shoot-style directives ──────────────────────────────────────────────
const MODEL_STYLE_DIRECTIVE = {
  outdoor_lifestyle:
    "The model is photographed outdoors — a park, beach, city street, or café " +
    "terrace. Candid, natural sunlight or golden hour light. Relaxed expression.",
  indoor_studio:
    "Clean professional studio environment. Seamless backdrop (white, grey, or " +
    "warm neutral). Even studio lighting. The model looks confident and composed.",
  active_sporty:
    "Dynamic environment suggesting movement and energy — urban jogging path, " +
    "rooftop, or sports court. Action-frozen moment, slight motion blur is fine.",
  fashion_editorial:
    "High-fashion editorial style. Bold directional lighting. " +
    "Magazine-quality staging. The model's pose is intentional and editorial.",
  street_style:
    "Urban street or alleyway, candid-style photography. " +
    "Natural ambient light, authentic street-fashion energy.",
};

let eyeglasses = null;
if (eyeglassesMode && wantGlassesId) {
  try {
    const all = JSON.parse(
      await fs.readFile(
        path.join(persistConfig, "eyeglasses.json"),
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
  // iPhone photos default to HEIC/HEIF — Gemini 2.5 Flash supports both
  // natively, but mislabeling the bytes as image/png makes the model unable
  // to parse the reference at all (it silently falls back to a generic
  // subject — exactly the "didn't follow the reference" symptom).
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
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

// User-supplied style reference (one image): used as a visual style guide
// for the background scene — the subject lock (character/product) still
// comes from refParts; this is purely compositional/mood inspiration.
const styleRefPath = process.env.DASHBOARD_STYLE_REF_PATH || "";
let styleRefPart = null;
if (styleRefPath) {
  try {
    const buf = await fs.readFile(styleRefPath);
    styleRefPart = {
      inlineData: { mimeType: mimeFor(styleRefPath), data: buf.toString("base64") },
    };
    console.log(`  Using user style reference: ${path.basename(styleRefPath)}`);
  } catch {
    console.warn(`  Style reference file not found, ignoring: ${styleRefPath}`);
  }
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
  const full = abs ? p : path.join(persistPublic, p);
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
        ? ` (no reference photos for this frame yet — generic scene)`
        : " (no character — scene only)") +
    (eyeglassesMode
      ? ` · style:${ePosterStyle}` +
        (ePosterStyle === "showcase" && ePlacement !== "auto" ? ` · placement:${ePlacement}` : "") +
        (ePosterStyle === "showcase" && eStyleKey ? ` · key:${eStyleKey}` : "") +
        (ePosterStyle === "model" ? ` · shoot:${eModelStyle}` : "")
      : "") +
    ` in ${location}…`,
);

for (const { q, i } of targets) {
  const fname = `bg-${String(i + 1).padStart(2, "0")}.png`;
  const outPath = path.join(bgDir, fname);
  // Eyeglasses-showcase entries carry a `tagline` (the vibe/feeling — e.g.
  // "Your everyday pair, elevated.") which steers the SCENE mood better than
  // `quote` (a clean product-name line meant for on-poster type, not imagery).
  const sceneVibe = eyeglassesMode ? q.tagline || q.quote : q.quote;

  // Build the eyeglasses placement + style modifier strings from the
  // dashboard-selected options. Fall back gracefully when not set.
  const placementNote = PLACEMENT_DIRECTIVE[ePlacement] || "";
  const styleKeyNote  = STYLE_KEY_DIRECTIVE[eStyleKey]  || "";
  const modelNote     = MODEL_STYLE_DIRECTIVE[eModelStyle] || "";
  // Combine placement + style key into a single modifier block (for showcase).
  const showcaseModifiers =
    [placementNote, styleKeyNote].filter(Boolean).join(" ") ||
    "Choose the most impactful product placement for this scene.";

  let guidance;
  if (eyeglassesMode && ePosterStyle === "model") {
    // ── Product + Model ────────────────────────────────────────────────────
    // AI-generated model wearing the frame. No product-only placement needed.
    const frameDesc = hasRef
      ? "the EXACT pair of eyeglasses shown in these reference photos " +
        "(match frame shape, color, lens tint, and details perfectly — " +
        "do not redesign or substitute)"
      : "a stylish pair of eyeglasses";
    guidance =
      `Photograph of a model wearing ${frameDesc}. ` +
      `${modelNote} ` +
      `The eyeglasses must be clearly visible on the model's face and be ` +
      `the focal accessory of the image. ` +
      `Scene context: ${q.bgPrompt}. ` +
      `The overall mood must clearly evoke: "${sceneVibe}". ` +
      `The model should look natural and aspirational — NOT staged or stiff. ` +
      `No text, logos, or watermarks anywhere in the image. ` +
      `Vertical 4:5 portrait composition. Keep the top ~30% and bottom ~35% ` +
      `darker and visually simple (clean negative space for a text overlay ` +
      `added later). The photo must contain zero readable text.`;
  } else if (eyeglassesMode) {
    // ── Product Showcase ───────────────────────────────────────────────────
    // HARD CONSTRAINT printed first so the model reads it before anything else.
    const nopeopleLine =
      "ABSOLUTE RULE — PRODUCT ONLY: This image must contain ZERO people, " +
      "ZERO faces, ZERO hands, ZERO skin, and ZERO human body parts of any kind. " +
      "If a person or any body part appears anywhere in the frame the output is " +
      "WRONG. Only the eyeglasses product and its background are allowed. ";
    if (hasRef) {
      guidance =
        nopeopleLine +
        `Feature the EXACT pair of eyeglasses shown in these reference photos ` +
        `as the hero product — match its frame shape, color, lens tint, and ` +
        `all design details perfectly; do not redesign or substitute a different pair. ` +
        `${showcaseModifiers} ` +
        `Scene context: ${q.bgPrompt}. ` +
        `The product must be clearly visible, in sharp focus, and instantly ` +
        `recognizable as the same pair shown in the references. ` +
        `The scene must clearly visually evoke this feeling: "${sceneVibe}". ` +
        `No props that obscure the frame. ` +
        `No text, logos, or watermarks anywhere in the image. ` +
        `Vertical 4:5 portrait composition. Keep the top ~30% and bottom ~35% ` +
        `darker and visually simple (clean negative space for a text overlay ` +
        `added later). The photo must contain zero readable text.`;
    } else {
      guidance =
        nopeopleLine +
        `Create a product-showcase photograph featuring a stylish pair of ` +
        `eyeglasses as the hero subject. ` +
        `${showcaseModifiers} ` +
        `Scene context: ${q.bgPrompt}. ` +
        `The eyeglasses must be clearly visible, in sharp focus, and the ` +
        `main focal point. ` +
        `The scene must clearly visually evoke this feeling: "${sceneVibe}". ` +
        `No text, logos, or watermarks anywhere in the image. ` +
        `Vertical 4:5 portrait composition. Keep the top ~30% and bottom ~35% ` +
        `darker and visually simple (clean negative space for a text overlay ` +
        `added later). The photo must contain zero readable text.`;
    }
  } else if (hasRef) {
    // ── Character (Jurie / other) with reference photos ────────────────────
    guidance =
      `Use the SAME person shown in these reference photos as the subject — ` +
      `keep their face, hair, and identity perfectly consistent and clearly ` +
      `recognizable. Place them in this scene: ${q.bgPrompt}. ` +
      `The scene must clearly visually express this message so a viewer ` +
      `instantly gets it: "${q.quote}". ${STYLE}`;
  } else {
    // ── Scene-only (no character, no eyeglasses) ───────────────────────────
    guidance =
      `Create a photograph of this scene: ${q.bgPrompt}. ` +
      `It must clearly visually express this message so a viewer instantly ` +
      `gets it: "${q.quote}". ${STYLE}`;
  }
  const t0 = Date.now();
  let buf = null;
  let lastErr = "";
  const MAX_TRIES = 3;
  for (let attempt = 1; attempt <= MAX_TRIES && !buf; attempt++) {
    try {
      // Build the parts list: subject refs first, optional style ref, then guidance.
      // styleRefPart is included when the dashboard sends a style reference —
      // either a selected poster template preset or a user-uploaded override.
      // In both cases it is a VISUAL STYLE GUIDE only, not a subject reference.
      const styleNote = styleRefPart
        ? " The last image is a POSTER STYLE REFERENCE — an example eyeglasses " +
          "advertisement that defines the visual language you should match: its " +
          "composition layout, background treatment, lighting mood, color palette, " +
          "and overall aesthetic. Treat it as a style template to emulate, NOT as " +
          "a source for products, people, logos, or text. The eyeglasses featured " +
          "in THIS scene must come only from the product reference images above."
        : "";
      const allParts = [
        ...(hasRef ? refParts : []),
        ...(styleRefPart ? [styleRefPart] : []),
        { text: guidance + styleNote },
      ];
      const resp = await ai.models.generateContent({
        model: REF_MODEL,
        contents: [{ role: "user", parts: allParts }],
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
