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
import { buildAspectPlan } from "./lib/aspect-plan.mjs";
import {
  applyGcpEnv,
  projectRoot,
  resolveClient,
  takeClientArg,
} from "./lib/client.mjs";

applyGcpEnv();

// ── Crash guards — ensure any unhandled error is printed before exit ──────────
process.on("unhandledRejection", (reason) => {
  console.error("[bg-gen] unhandledRejection:", reason?.stack || reason?.message || String(reason));
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[bg-gen] uncaughtException:", err?.stack || err?.message || String(err));
  process.exit(1);
});

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
// Portrait mode for the photo-quote styles — generates a clean full-bleed
// portrait of the character (Jurie) instead of a busy scene. "photo" = bright
// confident lifestyle; "mono" = moody, suited to a B&W treatment.
const portraitMode    = process.env.DASHBOARD_PORTRAIT_MODE || "";
const ePosterStyle    = process.env.DASHBOARD_EYEGLASSES_STYLE       || "showcase";
const ePlacement      = process.env.DASHBOARD_EYEGLASSES_PLACEMENT   || "auto";
const eStyleKey       = process.env.DASHBOARD_EYEGLASSES_STYLE_KEY   || "";
const eModelStyle     = process.env.DASHBOARD_EYEGLASSES_MODEL_STYLE || "outdoor_lifestyle";

// ── Light/dark tone from the selected poster style template ─────────────────
// Light templates (cream/white/minimal references) must produce BRIGHT
// high-key photography; the old hard-coded "keep top/bottom darker" line made
// every poster dark regardless of the chosen reference. Keep in sync with
// PRESET_TONE in src/QuoteCard/ProductShowcaseCard.tsx.
const stylePresetKey = (process.env.DASHBOARD_STYLE_PRESET || "").toLowerCase();
const LIGHT_PRESETS = new Set([
  "02-minimal-pedestal", "03-type-overlay", "04-editorial-props",
  "05-glass-panel-spec", "model-01-bold-type-overlay",
  "model-02-elegant-hold", "model-04-clean-fresh",
]);
const refTone = LIGHT_PRESETS.has(stylePresetKey)
  ? "light"
  : /dark|cinematic|earthy|dramatic/.test(stylePresetKey)
    ? "dark"
    : /minimal|clean|pedestal|panel|spec|elegant|fresh|cream|white|overlay/.test(stylePresetKey)
      ? "light"
      : "dark";
// Type-as-graphic presets: their visual identity IS oversized type in the
// image (the references show it), so the blanket "zero readable text" rule
// is replaced with cropped-letterform decoration.
const TYPE_DECOR = new Set(["03-type-overlay", "model-01-bold-type-overlay"]);
const typeDecorNote = TYPE_DECOR.has(stylePresetKey)
  ? ` EXCEPTION — TYPE-AS-GRAPHIC (this style requires it): include OVERSIZED ` +
    `letterform shapes as a graphic backdrop element behind/around the subject, ` +
    `exactly like the style reference — letters cropped by the frame edge or by ` +
    `the subject so NO complete readable word ever forms. The letterforms are ` +
    `abstract background decoration ONLY: do NOT lay out a complete poster ` +
    `title block, headline, slogan, badge, price, percentage tag, discount ` +
    `sticker, or any number anywhere in the image. No small text, no logos, ` +
    `no brand names.`
  : "";
// Negative-space directive appended to every eyeglasses guidance prompt.
// The target aspect is now driven by imageConfig.aspectRatio on the Gemini
// call — NOT by text. Declaring "Tall vertical 9:16 composition" in the prompt
// made the model refuse and return no image (empty 9:16 posters), so the
// aspect wording is deliberately gone from the text.
// Product-anatomy guard — Gemini sometimes draws a third temple arm or
// merged/duplicated hinges. Appended to every eyeglasses guidance prompt.
const ANATOMY_RULE =
  " PRODUCT ANATOMY (critical): the eyeglasses must be physically correct — " +
  "exactly TWO temple arms (one per side), ONE bridge, TWO lenses. Never " +
  "three or more arms, never duplicated, crossed, or merged temples; hinges " +
  "exist only at the two outer corners of the front frame. If any extra arm " +
  "or limb appears the image is WRONG.";

// Wardrobe + content-safety guard for MODEL-WORN shots. Gemini sometimes
// returns bare-shouldered / topless models when no clothing is specified —
// unusable for a mainstream eyewear brand. This makes "fully clothed" a hard,
// non-negotiable constraint on every model image.
const WARDROBE_RULE =
  " WARDROBE — MANDATORY: the model is FULLY CLOTHED in stylish, well-fitted, " +
  "tasteful everyday or smart-casual clothing suitable for a mainstream, " +
  "family-friendly eyewear advertisement — for example a shirt, blouse, knit, " +
  "sweater, blazer, jacket, or crew-neck tee, with a modest neckline and the " +
  "shoulders, chest and torso COVERED BY CLOTHING at all times. ABSOLUTELY " +
  "NO nudity, no topless, no bare chest, no bare shoulders, no exposed " +
  "underwear, no lingerie, no swimwear, no suggestive or revealing outfits. " +
  "If any of those appear the image is WRONG and unusable.";

// Finished-campaign guard. The model wheel used to produce candid "mid-shoot"
// moments (adjusting the temple, holding the frame up) that read like
// behind-the-scenes test shots. This forces a polished, published look.
const FINISHED_LOOK_RULE =
  " FINISH — this is a FINISHED, fully-retouched, professionally art-directed " +
  "advertising campaign photograph: a final, published magazine / billboard " +
  "image with flawless studio-grade retouching and deliberate composition. " +
  "It is NOT a behind-the-scenes, test, candid, casual, or mid-shoot snapshot, " +
  "and the model is NOT in the act of putting on or fiddling with the glasses — " +
  "the frames are already worn, settled, and perfectly in place.";
const NEG_SPACE = (_aspect) => ANATOMY_RULE + " " + (refTone === "light"
  ? `HIGH-KEY and bright: keep the top ` +
    `~30% and bottom ~35% of the frame bright, airy and low-detail (clean ` +
    `seamless backdrop or soft gradient — negative space for a text overlay ` +
    `added later). No heavy vignettes, no moody darkness. The photo must ` +
    `contain zero readable text.`
  : `Keep the top ~30% and bottom ~35% ` +
    `darker and visually simple (clean negative space for a text overlay ` +
    `added later). The photo must contain zero readable text.`) + typeDecorNote;

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

// ── Per-poster variety wheel ──────────────────────────────────────────────────
// Cycles through 8 distinct visual treatments so no two consecutive posters
// look the same, regardless of which style-reference template was chosen.
// The treatment overrides the reference's specific background/lighting — the
// reference only guides brand feel and production quality.
const VARIETY_WHEEL = [
  "warm amber glow, frame resting on a rich warm wooden or terracotta clay surface, soft diffused side light",
  "cool silver-grey palette, frame on polished dark stone or marble, clean top-down studio light from above",
  "dramatic dark scene, frame elevated on a matte geometric block, single sharp spotlight with deep shadows",
  "bright airy high-key, frame on a cream or off-white minimal surface, soft window light, no harsh shadows",
  "deep jewel-toned background — navy or emerald — frame nestled on textured velvet or linen fabric",
  "moody cinematic, dark concrete or brushed metal surface, a subtle coloured rim accent light on one edge",
  "golden-hour warmth, frame on frosted or smoked glass, soft hazy backlight creating a glow behind the product",
  "clean pastel gradient sky-to-floor — muted blush or sky blue — bold defined shadow lines cast below the frame",
];

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
try {
  await fs.mkdir(bgDir, { recursive: true });
} catch (err) {
  console.error(`[bg-gen] Cannot create bgDir ${bgDir}: ${err.message}`);
  process.exit(1);
}

const ai = new GoogleGenAI({ vertexai: true, project, location });
const REF_MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

// Aspect is driven by imageConfig.aspectRatio on the Gemini call, not text
// (see NEG_SPACE note). The _aspect param is kept for call-site compatibility.
const STYLE = (_aspect) =>
  "Cinematic candid documentary photograph, natural available light, " +
  "shallow depth of field, realistic, photojournalistic. Subject NOT " +
  `looking at the camera. Keep the top ` +
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

// Same deterministic aspect plan the renderer will use — backgrounds get
// COMPOSED for the ratio they'll be rendered at, instead of always 4:5 and
// then cropped (which made mixed-ratio batches look accidental).
const ASPECT_PLAN = buildAspectPlan(process.env.DASHBOARD_ASPECT_DIST, quotes.length);

// If the model ever rejects the imageConfig param, disable it for the rest of
// the batch (self-heals to default-square generation) so we don't burn 3
// failed attempts per poster.
let imageConfigOk = true;

for (const { q, i } of targets) {
  const fname = `bg-${String(i + 1).padStart(2, "0")}.png`;
  const outPath = path.join(bgDir, fname);
  const targetAspect = ASPECT_PLAN ? ASPECT_PLAN[i] : (q.aspectRatio || "4:5");
  // Eyeglasses-showcase entries carry a `tagline` (the vibe/feeling — e.g.
  // "Your everyday pair, elevated.") which steers the SCENE mood better than
  // `quote` (a clean product-name line meant for on-poster type, not imagery).
  const sceneVibe = eyeglassesMode ? q.tagline || q.quote : q.quote;

  // Build the eyeglasses placement + style modifier strings from the
  // dashboard-selected options. Fall back gracefully when not set.
  // When a style reference image is present it OWNS the visual style — the
  // style-key and model-shoot directives are dropped so the prompt doesn't
  // fight the reference. Placement (standing/flat/floating) stays: it's about
  // product orientation, not look.
  const placementNote = PLACEMENT_DIRECTIVE[ePlacement] || "";
  const styleKeyNote  = styleRefPart ? "" : (STYLE_KEY_DIRECTIVE[eStyleKey] || "");
  const modelNote     = styleRefPart ? "" : (MODEL_STYLE_DIRECTIVE[eModelStyle] || "");
  // Combine placement + style key into a single modifier block (for showcase).
  const showcaseModifiers =
    [placementNote, styleKeyNote].filter(Boolean).join(" ") ||
    (styleRefPart ? "" : "Choose the most impactful product placement for this scene.");

  let guidance;
  if (eyeglassesMode && ePosterStyle === "model") {
    // ── Product + Model ────────────────────────────────────────────────────
    // AI-generated model wearing the frame. A person MUST be present — the
    // copy generator's scene prompts used to leak still-life staging in here,
    // which produced product-only pedestal shots in "model" batches.
    const MODEL_SHOT_WHEEL = [
      "polished head-and-shoulders beauty portrait, model facing camera with a calm confident expression, the frames already worn and perfectly centered",
      "refined close beauty crop: the eyes and frames are the clear hero, generous clean headroom above, flawless skin retouching",
      "elegant three-quarter portrait, the model's gaze just off-camera, soft editorial key light catching the temple of the frames",
      "composed waist-up campaign stance, the model still and self-assured, premium magazine energy",
      "editorial studio portrait, a subtle genuine smile, shoulders squared to a clean seamless backdrop",
      "graceful side-lit three-quarter angle, chin level, the frame outline crisp against soft negative space",
      "warm aspirational lifestyle portrait, the model seated or leaning relaxed, beautifully art-directed",
      "high-end fashion portrait, an intentional editorial pose, polished and aspirational",
    ];
    const frameDesc = hasRef
      ? "the EXACT pair of eyeglasses shown in these reference photos " +
        "(match frame shape, color, lens tint, and details perfectly — " +
        "do not redesign or substitute)"
      : "a stylish pair of eyeglasses";
    guidance =
      `ABSOLUTE RULE — MODEL-WORN: a real person wearing the eyeglasses MUST ` +
      `be present in this image. NEVER a product-only still life — no ` +
      `pedestals, no flat-lays, no empty-set product staging. If the scene ` +
      `context below implies a still life, IGNORE that part and stage the ` +
      `scene around the person instead. ` +
      `SHOT FOR THIS POSTER (poster ${i + 1}): ` +
      MODEL_SHOT_WHEEL[i % MODEL_SHOT_WHEEL.length] + `. ` +
      `Photograph of a model wearing ${frameDesc}. ` +
      `${modelNote} ` +
      WARDROBE_RULE + " " +
      FINISHED_LOOK_RULE + " " +
      `The eyeglasses must be clearly visible and the focal accessory of the ` +
      `image. ` +
      `Scene context: ${q.bgPrompt}. ` +
      `The overall mood must clearly evoke: "${sceneVibe}". ` +
      `The model should look natural and aspirational — NOT staged or stiff. ` +
      `FRAMING FOR TEXT: frame the model's face and the glasses in the UPPER-TO-` +
      `MIDDLE band of the image, and keep the LOWER ~38% (around the chest / ` +
      `shoulders / below) calm, simple and low-detail — clean negative space ` +
      `for a text overlay added later. The face must NOT sit in that lower band. ` +
      `No text, logos, or watermarks anywhere in the image. ` +
      NEG_SPACE(targetAspect);
  } else if (eyeglassesMode) {
    // ── Product Showcase ───────────────────────────────────────────────────
    // Hard constraints + per-poster variety directive printed first.
    const nopeopleLine =
      "ABSOLUTE RULE — PRODUCT ONLY: This image must contain ZERO people, " +
      "ZERO faces, ZERO hands, ZERO skin, and ZERO human body parts of any kind. " +
      "If a person or any body part appears anywhere in the frame the output is " +
      "WRONG. Only the eyeglasses product and its background are allowed. ";
    // With a style reference the reference defines the look — variety comes
    // from shot framing, rotated through a concrete wheel so consecutive
    // posters get genuinely different compositions (not all centered hero
    // shots). Without a reference, rotate the generic treatment wheel.
    const SHOT_WHEEL = [
      "hero composition: product centered at a three-quarter angle, medium distance",
      "extreme macro close-up: crop tight into the lens and frame-front detail so the product fills the frame edge to edge",
      "rule-of-thirds: product anchored in the lower-left third of the frame, generous atmospheric negative space across the upper right",
      "dramatic low camera angle looking slightly up at the product, deep perspective, long raking shadows",
      "rule-of-thirds: product anchored in the lower-right third, the rest of the frame open and atmospheric",
      "pulled-back wide shot: the product small but pin-sharp inside a vast, moody environment — monumental negative space",
      "top-down flat-lay angle looking straight down at the product on the scene's surface",
      "dynamic diagonal: the product tilted along a strong diagonal axis cutting through the frame",
    ];
    const varietyLine = styleRefPart
      ? `SHOT VARIATION FOR THIS POSTER (poster ${i + 1}) — ` +
        SHOT_WHEEL[i % SHOT_WHEEL.length] +
        `. Keep the exact visual style of the style reference, but this framing ` +
        `is mandatory — it must read as a different shot from the same campaign ` +
        `as the other posters in this batch. `
      : `VISUAL TREATMENT FOR THIS SPECIFIC POSTER (poster ${i + 1}): ` +
        VARIETY_WHEEL[i % VARIETY_WHEEL.length] +
        ". Apply this treatment — it must look different from the other posters in this batch. ";
    if (hasRef) {
      guidance =
        nopeopleLine +
        varietyLine +
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
        NEG_SPACE(targetAspect);
    } else {
      guidance =
        nopeopleLine +
        varietyLine +
        `Create a product-showcase photograph featuring a stylish pair of ` +
        `eyeglasses as the hero subject. ` +
        `${showcaseModifiers} ` +
        `Scene context: ${q.bgPrompt}. ` +
        `The eyeglasses must be clearly visible, in sharp focus, and the ` +
        `main focal point. ` +
        `The scene must clearly visually evoke this feeling: "${sceneVibe}". ` +
        `No text, logos, or watermarks anywhere in the image. ` +
        NEG_SPACE(targetAspect);
    }
  } else if (hasRef && portraitMode) {
    // ── Character PORTRAIT (photo-quote / mono-quote styles) ───────────────
    const moodNote = portraitMode === "mono"
      ? "Calm, thoughtful, grounded expression, looking toward the camera. " +
        "Dramatic soft directional light with rich contrast and deep shadows, " +
        "composed to look striking as a black-and-white image"
      : "Confident, warm and approachable with a subtle genuine smile. A clean, " +
        "modern setting — a bright office, a glass-walled lobby, or a minimal " +
        "studio — with soft natural daylight, premium lifestyle-editorial feel";
    guidance =
      `A polished, professional PORTRAIT photograph of the SAME person shown in ` +
      `these reference photos — keep their face, hair, and identity perfectly ` +
      `consistent and clearly recognizable. ${moodNote}. ` +
      `Framing: a head-and-shoulders to waist-up portrait with the person in the ` +
      `UPPER-CENTRAL part of the frame; keep the LOWER ~40% calm and simple ` +
      `(soft background / clean negative space) for a text overlay added later. ` +
      `Photorealistic, editorial, shallow depth of field, sharp on the face. ` +
      `The person is fully and tastefully clothed. No text, logos, or watermarks ` +
      `anywhere in the image. ${STYLE(targetAspect)}`;
  } else if (hasRef) {
    // ── Character (Jurie / other) with reference photos ────────────────────
    guidance =
      `Use the SAME person shown in these reference photos as the subject — ` +
      `keep their face, hair, and identity perfectly consistent and clearly ` +
      `recognizable. Place them in this scene: ${q.bgPrompt}. ` +
      `The scene must clearly visually express this message so a viewer ` +
      `instantly gets it: "${q.quote}". ${STYLE(targetAspect)}`;
  } else {
    // ── Scene-only (no character, no eyeglasses) ───────────────────────────
    guidance =
      `Create a photograph of this scene: ${q.bgPrompt}. ` +
      `It must clearly visually express this message so a viewer instantly ` +
      `gets it: "${q.quote}". ${STYLE(targetAspect)}`;
  }
  const t0 = Date.now();
  let buf = null;
  let lastErr = "";
  const MAX_TRIES = 3;
  // Build the parts list once (it doesn't change per attempt): subject refs
  // first, optional style ref, then guidance.
  // Eyeglasses mode: the user explicitly chose this reference as the look they
  // want, so the model must MATCH it — replicate its visual language.
  const styleNote = styleRefPart
    ? eyeglassesMode
      ? " The LAST image is the STYLE REFERENCE — a finished eyeglasses " +
        "advertisement whose look this poster must MATCH. Replicate its visual " +
        "identity faithfully: background treatment, colour palette, lighting " +
        "style, prop and staging approach, level of drama, and overall mood. " +
        "The finished image should look like another poster from the SAME " +
        "campaign as the reference. Three exceptions: " +
        "(1) COMPOSITION — the SHOT VARIATION directive above dictates the " +
        "camera angle, distance, and product position for THIS poster and " +
        "OVERRIDES the reference's framing; do NOT default to the reference's " +
        "centered composition. " +
        "(2) do NOT copy any text, lettering, or logos from the reference — " +
        "this image must contain zero readable text. " +
        "(3) do NOT copy the eyeglasses shown in the reference — the product " +
        "must come ONLY from the product reference photos above. " +
        "FINALLY: if the scene context above describes a DIFFERENT setting, " +
        "backdrop, or palette than the reference, the REFERENCE WINS — " +
        "restage the scene inside the reference's world."
      : " The last image is a BRAND AESTHETIC REFERENCE. Use it for general " +
        "brand feel: production quality, premium/editorial/minimal tone, and " +
        "compositional style. The subject must come only from the reference " +
        "images above, not from this style reference."
    : "";
  const allParts = [
    ...(hasRef ? refParts : []),
    ...(styleRefPart ? [styleRefPart] : []),
    { text: guidance + styleNote },
  ];
  // One attempt against the model. withAspect=true asks Gemini to compose at
  // the target ratio via imageConfig (the proper mechanism). The previous code
  // only put "9:16" in the TEXT, which the model would refuse — returning no
  // image and leaving the poster with an empty background.
  const tryGen = async (withAspect) => {
    const useConfig = withAspect && imageConfigOk;
    try {
      const resp = await ai.models.generateContent({
        model: REF_MODEL,
        contents: [{ role: "user", parts: allParts }],
        ...(useConfig ? { config: { imageConfig: { aspectRatio: targetAspect } } } : {}),
      });
      const parts = resp.candidates?.[0]?.content?.parts || [];
      for (const p of parts) if (p.inlineData?.data) return Buffer.from(p.inlineData.data, "base64");
      return null;
    } catch (err) {
      // Model rejected imageConfig → stop using it batch-wide (default square
      // still produces a usable image; the renderer crops to the target ratio).
      if (useConfig && /imageconfig|aspect|invalid|unsupported|unknown|argument|400/i.test(String(err?.message || ""))) {
        imageConfigOk = false;
        console.warn("  imageConfig unsupported on this model — falling back to default aspect for the batch.");
      }
      throw err;
    }
  };
  for (let attempt = 1; attempt <= MAX_TRIES && !buf; attempt++) {
    try {
      buf = await tryGen(true);
      if (!buf) {
        lastErr = "no image in response";
        console.warn(`  [${i + 1}] attempt ${attempt}/${MAX_TRIES}: ${lastErr}` + (attempt < MAX_TRIES ? " — retrying…" : ""));
      }
    } catch (err) {
      lastErr = err?.message ? String(err.message).slice(0, 160) : String(err);
      console.warn(`  [${i + 1}] attempt ${attempt}/${MAX_TRIES} failed: ${lastErr}` + (attempt < MAX_TRIES ? " — retrying…" : ""));
    }
    if (!buf && attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, 2500 * attempt));
  }
  // Fallback: if the aspect-constrained attempts all failed, generate WITHOUT
  // the aspect config (default square). A cropped square beats an empty poster.
  if (!buf) {
    try {
      buf = await tryGen(false);
      if (buf) console.warn(`  [${i + 1}] recovered via no-aspect fallback (${targetAspect} would not generate)`);
    } catch (err) { lastErr = err?.message ? String(err.message).slice(0, 160) : String(err); }
  }
  if (!buf) {
    console.warn(`  [${i + 1}] GAVE UP after ${MAX_TRIES} tries + fallback (${lastErr})`);
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
