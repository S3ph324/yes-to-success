// AI product-photography generation for the TikTok Shop cards ("Virtual
// Photography Studio").
//
// Takes the seller's uploaded eyeglasses-frame photo(s) as a REFERENCE and uses
// Gemini image (gemini-2.5-flash-image / "Nano Banana") to shoot clean
// product-placement scenes of the SAME EXACT frame. The frame being sold must
// not be altered, so every prompt locks the product to the reference.
//
// Two APIs:
//   generateShopShots({ jobs })   — dynamic: each job = { id, prompt, refParts }
//   generateShopScenes({ ... })   — legacy fixed 4-scene wrapper (old 5-card path)
//
// Prompt builders (buildShotPrompt) cover the studio shot menu: hero, simple,
// closeup, feature, model, group — each with variations cycled by shot index so
// quantities > 1 produce distinct photography, and all carrying the
// professional-photographer persona.
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

const mimeFor = (p) => {
  const e = (path.extname(p) || "").toLowerCase();
  return e === ".png" ? "image/png" : e === ".webp" ? "image/webp" : e === ".heic" || e === ".heif" ? "image/heic" : "image/jpeg";
};

// ── Persona + product-fidelity locks ────────────────────────────────────────
// Prepended to EVERY scene prompt: the AI acts as a commercial eyewear
// photographer, not a generic image generator.
export const PHOTOGRAPHER_PERSONA =
  "You are a world-class, professional commercial eyewear photographer and " +
  "luxury retouching expert. You know exactly which camera bodies, macro " +
  "lenses (e.g., 100mm f/2.8), lighting modifiers (softboxes, rim lights, " +
  "snoots), and angles best highlight frame acetate, metal hinges, and lens " +
  "clarity. Output photorealistic, award-winning commercial imagery. ";

// Product fidelity — applies to every shot type (models included).
const PRODUCT_LOCK =
  " PRODUCT FIDELITY — the eyeglasses are a REAL product being sold. Use the " +
  "reference photo(s) ONLY to identify the exact frame DESIGN — its SHAPE, COLOUR, " +
  "MATERIAL, rim thickness, temple/arm style and hinges — and reproduce that design " +
  "EXACTLY. Do NOT redesign, recolour, restyle, swap or invent a different pair. " +
  // Force a genuine re-shoot: Gemini otherwise anchors to the reference's small,
  // casual, hand-held composition and effectively returns the input photo.
  "But COMPLETELY IGNORE the reference's composition, framing, scale, camera angle, " +
  "background, surface, hands and lighting — this is a BRAND-NEW professional studio " +
  "photograph shot from scratch, NOT a copy, crop, filter or light edit of the " +
  "reference snapshot. Recompose entirely. " +
  // The seller's photos carry a lens DISPLAY STICKER and often an engraved brand
  // name on the temple/arm — temporary packaging / third-party marks, not part of
  // the product being sold. Strip them ALL.
  "CLEAN THE PRODUCT: the lenses must be perfectly clean and clear, and there must " +
  "be ZERO text, letters, numbers, brand names, logos, stickers, retailer labels, " +
  "price tags, holograms or watermarks ANYWHERE in the final image — including any " +
  "printed or ENGRAVED markings on the lenses, temples or arms visible in the " +
  "reference (e.g. a lens sticker, or a brand name etched on the arm). Remove them all. " +
  "Photorealistic, award-winning commercial product photography — ultra-sharp, crisp, " +
  "high detail, correct proportions, 1:1 square.";

// Applied to every shot type EXCEPT model shoots.
const NO_PEOPLE = " No people, no faces, no hands, no mannequins.";

// Person-generating guards — same text as the eyeglasses-showcase pipeline.
// MANDATORY on every model prompt (see the wardrobe incident write-up).
const WARDROBE_RULE =
  " WARDROBE — MANDATORY: the model is FULLY CLOTHED in stylish, well-fitted, " +
  "tasteful everyday or smart-casual clothing suitable for a mainstream, " +
  "family-friendly eyewear advertisement — for example a shirt, blouse, knit, " +
  "sweater, blazer, jacket, or crew-neck tee, with a modest neckline and the " +
  "shoulders, chest and torso COVERED BY CLOTHING at all times. ABSOLUTELY " +
  "NO nudity, no topless, no bare chest, no bare shoulders, no exposed " +
  "underwear, no lingerie, no swimwear, no suggestive or revealing outfits. " +
  "If any of those appear the image is WRONG and unusable.";
const FINISHED_LOOK_RULE =
  " FINISH — this is a FINISHED, fully-retouched, professionally art-directed " +
  "advertising campaign photograph: a final, published magazine / billboard " +
  "image with flawless studio-grade retouching and deliberate composition. " +
  "It is NOT a behind-the-scenes, test, candid, casual, or mid-shoot snapshot, " +
  "and the model is NOT in the act of putting on or fiddling with the glasses — " +
  "the frames are already worn, settled, and perfectly in place.";

// ── Shot-type prompt builders (variations cycle by shot index) ─────────────
// The eyeglasses must dominate the hero — Gemini otherwise renders them small.
const HERO_LEAD =
  "The eyeglasses are the HERO of this image: render them LARGE, prominent and in " +
  "TACK-SHARP focus, filling roughly 65–80% of the frame — never small, distant, " +
  "soft, tilted-away or lost in the scene. ";
const HERO_VARIATIONS = [
  "Premium studio product photograph: the eyeglasses LARGE and centred, filling " +
    "most of the frame, on a deep charcoal / near-black seamless studio backdrop, " +
    "dramatic soft key lighting with subtle reflections and a gentle shadow " +
    "beneath, slight three-quarter angle. Moody, high-end, cinematic catalogue hero shot.",
  "Premium studio product photograph: the eyeglasses FLOATING weightlessly at a " +
    "dynamic angle against a dark graphite backdrop, levitation product shot with " +
    "a soft spotlight, crisp rim light tracing the frame edges, faint soft shadow " +
    "far below. High-end, editorial, gravity-defying hero shot.",
  "Premium product photograph: the eyeglasses resting on a low stone pedestal on " +
    "warm cream marble, soft directional morning window light, long elegant " +
    "shadows, warm luxurious palette. Quiet-luxury catalogue hero shot.",
  "Premium studio product photograph: the eyeglasses centred on a glossy black " +
    "acrylic surface with a mirror reflection beneath, a single focused snoot " +
    "spotlight from above, deep black background. Dramatic spotlight hero shot.",
];
const SIMPLE_PROMPT =
  "Clean e-commerce catalogue HERO product photograph, shot fresh in a studio: " +
  "the eyeglasses FRONT-ON and fully open, standing upright and facing the camera, " +
  "so BOTH lenses and the COMPLETE frame outline are entirely visible, symmetric " +
  "and unobstructed — nothing cropped or cut off, the frame large and filling most " +
  "of the width. " +
  "COMPLETELY REPLACE and DISCARD the background, surface, table, wall, shadow and " +
  "lighting from the reference photo. Render a brand-new PURE WHITE (#FFFFFF) " +
  "seamless studio sweep with bright, soft, even high-key lighting and only a " +
  "subtle soft contact shadow directly under the frame. Do NOT keep any grey, " +
  "beige, wooden or coloured backdrop, table edge or window from the reference — " +
  "the background must be solid clean white, edge to edge. " +
  "This must look like a polished online-store / marketplace MAIN listing image on " +
  "white, NOT a casual snapshot.";
// Get VERY close — these must read as extreme detail crops, not full-product shots.
const CLOSEUP_LEAD =
  "This is an EXTREME MACRO detail crop, NOT a full-product shot. Get extremely " +
  "close — the single detail below must FILL 70–90% of the frame; the rest of the " +
  "eyeglasses is out of frame or in soft bokeh. Shot on a 100mm f/2.8 macro lens at " +
  "near 1:1 magnification, tack-sharp on the detail. ";
const CLOSEUP_VARIATIONS = [
  "Detail: the HINGE and its screw where the temple meets the front, showing the " +
    "metalwork and articulation, on a dark charcoal backdrop with moody directional " +
    "rim lighting and subtle reflections. Jewel-like premium detail shot.",
  "Detail: the NOSE PADS and bridge, showing the pad arms and the material of the " +
    "bridge, dark studio backdrop, precise jewel-like lighting, the rest melting " +
    "into creamy bokeh.",
  "Detail: the TEMPLE ARM tip and its material finish/texture, showing the " +
    "craftsmanship and any subtle sheen, shallow depth of field, dark premium " +
    "backdrop with a warm accent rim light.",
  "Detail: the LENS EDGE and frame rim, light refracting cleanly through the lens " +
    "bevel, deep dark background, cool precise studio lighting. Optical-precision detail shot.",
];
const FEATURE_PROMPT =
  "A clean, ANGLED studio macro of the eyeglasses with the LENSES catching a soft " +
  "sweep of light, shot on a 100mm macro lens. COMPOSITION IS CRITICAL: place the " +
  "eyeglasses so that ONE lens is the clear focal point, positioned in the " +
  "LEFT-CENTRE of the frame — its centre roughly 38% from the left edge and 42% " +
  "down from the top — angled at a dynamic three-quarter view, the lens surface " +
  "clean and fully unobstructed. Keep the ENTIRE RIGHT HALF of the frame as clean, " +
  "empty NEGATIVE SPACE: a smooth subtle gradient (soft cool grey or gentle warm " +
  "tone), evenly lit and uncluttered — technical infographic graphics will be " +
  "overlaid there later, so nothing else may sit in the right half. Premium " +
  "optical-technology advertising style.";
const MODEL_LOOKS = [
  "a stylish Filipina woman in her late 20s with a warm, confident expression",
  "a stylish Filipino man in his early 30s with a relaxed, self-assured look",
  "a fresh-faced Filipina university student with a bright, natural smile",
  "a distinguished Filipino professional in his 40s with a composed, approachable air",
];
const MODEL_SETTINGS = [
  "a sunlit modern coffee shop by the window",
  "a clean minimalist studio with a soft neutral backdrop",
  "a bright contemporary office lounge",
  "a golden-hour city street with soft bokeh lights",
];

// Build the full prompt for one shot. `index` cycles the variations; `opts`:
//   modelNote  — free-text override of the model description (model shots)
//   varietyNames — array of colorway names (group shots)
export function buildShotPrompt(type, index = 0, opts = {}) {
  const i = Math.max(0, index);
  if (type === "hero")
    return PHOTOGRAPHER_PERSONA + HERO_LEAD + HERO_VARIATIONS[i % HERO_VARIATIONS.length] + PRODUCT_LOCK + NO_PEOPLE;
  if (type === "simple")
    return PHOTOGRAPHER_PERSONA + SIMPLE_PROMPT + PRODUCT_LOCK + NO_PEOPLE;
  if (type === "closeup")
    return PHOTOGRAPHER_PERSONA + CLOSEUP_LEAD + CLOSEUP_VARIATIONS[i % CLOSEUP_VARIATIONS.length] + PRODUCT_LOCK + NO_PEOPLE;
  if (type === "feature")
    return PHOTOGRAPHER_PERSONA + FEATURE_PROMPT + PRODUCT_LOCK + NO_PEOPLE;
  if (type === "model") {
    const look = (opts.modelNote || "").trim() || MODEL_LOOKS[i % MODEL_LOOKS.length];
    const setting = MODEL_SETTINGS[i % MODEL_SETTINGS.length];
    return (
      PHOTOGRAPHER_PERSONA +
      `Shot on an 85mm portrait lens: ${look}, wearing the exact eyeglasses from ` +
      `the reference photos, in ${setting}. Cinematic lifestyle lighting, shallow ` +
      "depth of field, the face and glasses in the UPPER-MIDDLE of the frame with " +
      "clean space in the lower third. The eyeglasses are the clear focal " +
      "accessory of the image — worn naturally, perfectly in place." +
      WARDROBE_RULE +
      FINISHED_LOOK_RULE +
      PRODUCT_LOCK
    );
  }
  if (type === "group") {
    const names = (opts.varietyNames || []).filter(Boolean);
    const n = Math.max(2, names.length);
    return (
      PHOTOGRAPHER_PERSONA +
      `A creative premium flat-lay / staggered studio composition showing ${n} ` +
      `COLORWAYS of the SAME eyeglasses frame model together in one shot` +
      (names.length ? ` (${names.join(", ")})` : "") +
      ". Arrange them elegantly — staggered heights, overlapping diagonals or a " +
      "clean grid — on a premium dark or neutral studio surface with soft " +
      "directional lighting. EVERY pair must have the IDENTICAL frame shape and " +
      "design; ONLY the colour/material differs, and each colorway must match its " +
      "labelled reference photos exactly. All pairs fully visible, none cropped." +
      PRODUCT_LOCK +
      NO_PEOPLE
    );
  }
  throw new Error(`unknown shot type "${type}"`);
}

// Read reference photos into Gemini inline parts (max N, unreadable skipped).
export async function buildRefParts(paths, max = 3) {
  const parts = [];
  for (const p of (paths || []).slice(0, max)) {
    try {
      const buf = await fs.readFile(p);
      parts.push({ inlineData: { mimeType: mimeFor(p), data: buf.toString("base64") } });
    } catch { /* skip unreadable ref */ }
  }
  return parts;
}

// Interleave labelled variety references for a GROUP shot, so the model binds
// each colorway name to its photos:
//   [ {text:"VARIETY 1 — 'Champagne'…"}, img, img, {text:"VARIETY 2 — …"}, img, … ]
export async function buildGroupRefParts(varieties, perVariety = 2, maxVarieties = 4) {
  const parts = [];
  for (let i = 0; i < Math.min(varieties.length, maxVarieties); i++) {
    const v = varieties[i];
    const imgs = await buildRefParts(v.photos || [], perVariety);
    if (!imgs.length) continue;
    parts.push({ text: `VARIETY ${i + 1} — "${v.name}". Reference photos of this colorway:` });
    parts.push(...imgs);
  }
  return parts;
}

// Vision: find the CENTRE of the most prominent eyeglass lens in a generated
// feature image, as fractions {x,y} (0–1, top-left origin). The infographic
// overlay anchors its rings + leader lines here so they land ON the real lens
// regardless of where the image model actually placed the glasses. One cheap
// gemini-2.5-flash call; falls back to a sensible left-centre default on any
// failure so it never blocks a render.
export async function detectLensFocus({ imagePath, project, location }) {
  const fallback = { x: 0.4, y: 0.42 };
  try {
    const buf = await fs.readFile(imagePath);
    const ai = new GoogleGenAI({ vertexai: true, project, location });
    const resp = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType: mimeFor(imagePath), data: buf.toString("base64") } },
          { text: "This image shows a pair of eyeglasses. Give the position of the CENTRE of the single most prominent, clearest lens as fractions of the image dimensions (x = fraction from the left edge, y = fraction from the top; both 0 to 1)." },
        ],
      }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: { x: { type: Type.NUMBER }, y: { type: Type.NUMBER } },
          required: ["x", "y"],
        },
        temperature: 0,
      },
    });
    const j = JSON.parse(resp.text);
    let x = Number(j.x), y = Number(j.y);
    if (!isFinite(x) || !isFinite(y)) return fallback;
    // Clamp into a safe band so rings/leader-lines never run off the canvas.
    x = Math.max(0.14, Math.min(0.62, x));
    y = Math.max(0.2, Math.min(0.7, y));
    return { x, y };
  } catch {
    return fallback;
  }
}

// ── Generic shot runner ─────────────────────────────────────────────────────
// jobs: [{ id, prompt, refParts }] → writes <outDir>/<id>.png per success.
// Returns { made: {id: absPath}, errors: [{id, message}] }.
// Keeps the proven anti-429 behavior: 3 attempts with exponential backoff
// (4s, 8s) per job + 2.5s spacing between jobs.
export async function generateShopShots({ jobs, project, location, outDir, log = () => {} }) {
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const model = process.env.REF_MODEL || "gemini-2.5-flash-image";
  await fs.mkdir(outDir, { recursive: true });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const made = {};
  const errors = [];
  for (const job of jobs) {
    if (!job.refParts?.length) {
      errors.push({ id: job.id, message: "no readable reference photos" });
      continue;
    }
    let buf = null;
    let lastErr = "";
    const MAX = 3;
    for (let attempt = 1; attempt <= MAX && !buf; attempt++) {
      try {
        const t0 = Date.now();
        const resp = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [...job.refParts, { text: job.prompt }] }],
          config: { imageConfig: { aspectRatio: "1:1" } },
        });
        const parts = resp.candidates?.[0]?.content?.parts || [];
        for (const pt of parts) if (pt.inlineData?.data) { buf = Buffer.from(pt.inlineData.data, "base64"); break; }
        if (!buf) throw new Error("no image in response");
        log(`  ✓ shot '${job.id}' (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (e) {
        lastErr = String(e?.message || e);
        log(`  shot '${job.id}' attempt ${attempt}/${MAX}: ${lastErr.slice(0, 160)}`);
        // Exponential backoff gives a hot rate limiter time to cool off.
        if (attempt < MAX) await delay(4000 * attempt);
      }
    }
    if (buf) {
      const fp = path.join(outDir, `${job.id}.png`);
      await fs.writeFile(fp, buf);
      made[job.id] = fp;
    } else {
      errors.push({ id: job.id, message: lastErr || "unknown" });
    }
    // Space jobs out so a burst of calls doesn't trip the per-minute limit.
    await delay(2500);
  }
  return { made, errors };
}

// ── Legacy fixed 4-scene API (old 5-card pipeline; behavior unchanged) ─────
export const SHOP_SCENES = {
  clean: HERO_VARIATIONS[0] + PRODUCT_LOCK + NO_PEOPLE,
  life:
    "Premium lifestyle flat-lay product photograph: the eyeglasses resting at a " +
    "natural angle on a dark slate or dark wood surface beside a minimal eyewear " +
    "case, low-key moody lighting, deep soft shadows, elegant dark palette." +
    PRODUCT_LOCK + NO_PEOPLE,
  dark: CLOSEUP_VARIATIONS[0] + PRODUCT_LOCK + NO_PEOPLE,
  front: SIMPLE_PROMPT + PRODUCT_LOCK + NO_PEOPLE,
};

export async function generateShopScenes({
  refPaths, project, location, outDir, keys = ["clean", "life", "dark"], log = () => {},
}) {
  const refParts = await buildRefParts(refPaths, 3);
  if (!refParts.length) throw new Error("no readable reference photos");
  const jobs = keys
    .filter((k) => SHOP_SCENES[k])
    .map((k) => ({ id: k, prompt: SHOP_SCENES[k], refParts }));
  const { made, errors } = await generateShopShots({ jobs, project, location, outDir, log });
  // Old shape: scenes keyed by scene name, errors [{key, message}].
  return {
    scenes: made,
    errors: errors.map((e) => ({ key: e.id, message: e.message })),
  };
}
