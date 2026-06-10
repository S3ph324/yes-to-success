#!/usr/bin/env node
// Eyeglasses-showcase content generator — Tranzzie only.
//
// Produces a CLEAN PRODUCT-SHOWCASE shape — productLine/tagline/ctaTag/
// caption/bgPrompt/aspectRatio/variant("showcase")/kind("product")/
// useFlatBg/eyeglassesId/eyeglassesStyle/quote(=productLine for slugs) —
// deliberately DIFFERENT from generate-quotes-jurie.mjs's hook→payoff
// topLines/bottomLines shape. render-batch-jurie.mjs detects `eyeglassesId`
// and renders these through ProductShowcaseCard: a clean product-photography
// poster (no big quote-card text overlay, no per-word color emphasis — the
// photo is the hero, copy stays small and editorial, like a premium
// e-commerce ad). Only the VOICE/copy differs from other clients; the
// rendering treatment is intentionally a different composition entirely.
//
// Usage:
//   node scripts/generate-eyeglasses-tranzzie.mjs [count] [topic...]
// Env:
//   DASHBOARD_EYEGLASSES_ID    - which config/eyeglasses.json entry to feature
//   DASHBOARD_EYEGLASSES_STYLE - "showcase" (only one wired up for now)
//   CLIENT_TOPIC               - optional topic override
//
// Output: out/tranzzie-quotes-YYYY-MM-DDTHH-mm.json (same prefix as the main
// pipeline so batch-eyeglasses-tranzzie.mjs can locate it the same way).

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyGcpEnv,
  projectRoot,
  resolveClient,
  takeClientArg,
} from "./lib/client.mjs";

applyGcpEnv();

// ── Crash guards (surface errors instead of null exits) ──────────────────────
process.on("unhandledRejection", (reason) => {
  console.error(
    "[glasses-gen] unhandledRejection:",
    reason?.stack || reason?.message || String(reason),
  );
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(
    "[glasses-gen] uncaughtException:",
    err?.stack || err?.message || String(err),
  );
  process.exit(1);
});

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

const { client: clientArg, rest } = takeClientArg(process.argv.slice(2));
const client = await resolveClient(clientArg || "tranzzie");

const COUNT = parseInt(rest[0] || "8", 10);
const TOPIC =
  process.env.CLIENT_TOPIC ||
  process.env.JURIE_TOPIC ||
  rest.slice(1).join(" ").trim();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
// When set, the AI generates a short typographic `headline` (2-5 words) for
// each poster so the renderer can display it at large display-type scale
// (72px+). Without this flag, productLine serves as the headline at 54-58px.
const AI_HEADLINE = process.env.DASHBOARD_AI_HEADLINE === "1";

const voiceProfile = await fs.readFile(client.voiceProfilePath, "utf-8");

// Resolve the featured frame (asset preset). May be empty — the dashboard
// only lets the user pick from what exists in config/eyeglasses.json, and
// that file starts empty until frames are added via the Eyeglasses tab.
const eyeglassesId = process.env.DASHBOARD_EYEGLASSES_ID || "";
const showcaseStyle = process.env.DASHBOARD_EYEGLASSES_STYLE || "showcase";

// On Railway the persistent volume is at EXPORT_BASE/_studio-data; locally
// fall back to projectRoot. This mirrors the pattern in generate-backgrounds-jurie.mjs.
const PERSIST_BASE = process.env.EXPORT_BASE
  ? path.join(process.env.EXPORT_BASE, "_studio-data")
  : projectRoot;

let frame = null;
try {
  const all = JSON.parse(
    await fs.readFile(path.join(PERSIST_BASE, "config", "eyeglasses.json"), "utf-8"),
  );
  frame = all.find((g) => g.id === eyeglassesId) || null;
} catch {
  /* config/eyeglasses.json may not exist yet — fine, frame stays null */
}
if (!frame) {
  console.warn(
    `No eyeglasses asset found for "${eyeglassesId || "(none selected)"}" — ` +
      `generating generic showcase copy. Add a frame in the Eyeglasses tab ` +
      `for product-accurate posters.`,
  );
}
const frameLabel = frame?.name || "the featured frame";
const frameNotes = frame?.notes ? `\nFrame notes: ${frame.notes}` : "";

const subjectBlock = `\n\n## SUBJECT — PRODUCT SHOWCASE\n\nEvery poster in this batch is a PRODUCT SHOWCASE for a specific pair of eyeglasses: "${frameLabel}".${frameNotes}\nThe eyeglasses are the hero of the image — copy must spotlight THEM (the look, the fit, the feature, the vibe), not a generic life lesson. Treat the frame like the main character of the post.\n`;

// The dashboard's "Optional headline idea" field arrives as TOPIC. When it
// reads like a headline (≤8 words) it IS the headline — placed verbatim on
// every poster (enforced again in the normalization pass below). Longer text
// is treated as a thematic angle like before.
const HEADLINE_IDEA = TOPIC && TOPIC.split(/\s+/).length <= 8 ? TOPIC : "";
const briefBlock = HEADLINE_IDEA
  ? `\n**USER HEADLINE — "${HEADLINE_IDEA}" is the literal headline of EVERY poster ` +
    `in this batch.** It will be placed on the posters verbatim. Do NOT write your ` +
    `own headlines. Write productLine / tagline / caption that SUPPORT this headline ` +
    `— complement it, never restate or contradict it.\n`
  : TOPIC
    ? `\n**SINGLE ANGLE — every poster in this batch must spotlight this angle of the product:** "${TOPIC}"\n`
    : `\n**Vary the angle across the batch** — style, comfort, durability, everyday wearability, the "main character energy" the frame gives, etc.\n`;

const headlineNote = AI_HEADLINE
  ? `\n- headline: A SHORT typographic hook — 2 to 5 words MAX — rendered at\n` +
    `  billboard size. It must have a HOOK: an idea, a twist, a wink — never a\n` +
    `  generic compliment. Rotate these techniques across the batch (one each):\n` +
    `    1. Taglish wordplay on eyes/vision/lakad: "Clear Vision, Clear Lakad",\n` +
    `       "Bagong Mata, Bagong Ikaw"\n` +
    `    2. Confident flex / main-character energy: "Anlakas Maka-Main Character",\n` +
    `       "Suot Mo, Plot Twist Mo"\n` +
    `    3. Contrast twist: "Mukhang Mahal. Hindi Naman.", "Pang-Selfie. Pang-Forever."\n` +
    `    4. Conversational hook: "Your Face Called.", "Na-double Take Ka Na Naman?"\n` +
    `    5. Specific detail of THIS frame (its colour, shape, material) turned\n` +
    `       into attitude: "Pink, Pero Power", "Round Frames, Sharp Moves"\n` +
    `  Each headline must use a DIFFERENT technique than the previous entry.\n` +
    `  This is SEPARATE from productLine — productLine becomes the supporting\n` +
    `  descriptor below the big headline. Make sure they complement each other.\n`
  : ``;

const styleNote =
  showcaseStyle === "showcase"
    ? `\nFORMAT — CLEAN PRODUCT SHOWCASE:\n` +
      `This is a PRODUCT-PHOTOGRAPHY poster, NOT a quote graphic. The photo IS\n` +
      `the hero — copy stays clean and editorial, like a premium eyewear ad.\n` +
      `- productLine: ONE short line about "${frameLabel}" with a concrete\n` +
      `  detail in it — the colour, the shape, the material, the fit, the\n` +
      `  occasion it owns. "Transparent pink acetate, kilig included" beats\n` +
      `  "The Pink Collection". NO hook→payoff, no rhetorical question.\n` +
      `- tagline: an OPTIONAL short payoff (≤8 words) that adds NEW information\n` +
      `  or a wink — a benefit, a use-case, a joke landing. Never a second\n` +
      `  compliment. Use "" when productLine stands alone.\n` +
      `- ctaTag: a SHORT 1-3 word chip in ALL CAPS, e.g. "SHOP NOW",\n` +
      `  "VIEW THE DROP". Use "" on some posters — not every poster needs one.\n` +
      headlineNote
    : `\nFORMAT — CLEAN PRODUCT SHOWCASE (fallback):\n` +
      `- Same productLine/tagline/ctaTag shape, spotlighting "${frameLabel}".\n` +
      headlineNote;

// Dead-phrase ban list — these are the words that make every eyewear ad on
// the internet sound identical. Forcing the model away from them is the
// single highest-leverage copy improvement.
const COPY_RULES = `
COPY CRAFT — the difference between an ad and wallpaper:
- BANNED words/phrases (in any language, any casing): "elevate", "effortless",
  "effortlessly", "timeless", "chic", "statement", "signature look",
  "style that speaks", "stand out", "redefine", "unleash", "discover",
  "experience", "seamless", "seamlessly", "perfect blend", "premium quality",
  "elevate your look", "main character" used as a bare cliché (the Taglish
  flex form "maka-main character" is fine — it has a voice).
- Every line must contain something SPECIFIC: this frame's colour, shape,
  material, price feel, or the exact moment it's worn (first date, big
  presentation, payday selfie, video call). Specificity is personality.
- Write like a sharp Manila creative director, not a template. If a line
  could be pasted onto any other eyewear brand's poster unchanged, it FAILS —
  rewrite it.
- caption: first sentence must hook (a question, a scene, a confession —
  not a description). Then one concrete benefit. Keep the comment-keyword
  CTA mechanic if used.
`;

const systemInstruction = `${voiceProfile}${subjectBlock}${briefBlock}
You are generating CLEAN PRODUCT-SHOWCASE poster entries for ${client.label}'s
Facebook page, all featuring the same pair of eyeglasses: "${frameLabel}".
Produce exactly ${COUNT} entries.${styleNote}
${COPY_RULES}
CRITICAL — this is NOT a Taglish hook→payoff quote poster (that's a different
poster type entirely, used elsewhere). Do not write a rhetorical setup +
emotional payoff, and do not invent colored word-emphasis — none of that
renders here. Write the way a sharp eyewear brand with a sense of humour
captions a product photo: brief, confident, specific. The image does the
talking — the copy does the flirting.

GRAMMAR & COHERENCE — most important; reject anything that fails:
- Every line must be a natural, grammatically correct Taglish or English
  phrase a real Filipino eyewear brand would actually post. Read it back: if
  it sounds broken, off, or like a forced slogan, REWRITE it.
- Vary structure and openers across the batch — no two entries should read
  alike, no duplicates, no template-filling feel.

${showcaseStyle === "model"
  ? `bgPrompt — describe a MODEL-WORN fashion-campaign scene: a real person
WEARING "${frameLabel}" (or holding it up to camera). NEVER a product-only
still life — no pedestals, no flat-lays, no empty-set product staging in
this batch. Rotate these campaign archetypes across the batch:
- Studio beauty portrait: clean seamless backdrop, soft directional key
  light, the frames front and center on the model's face.
- Lifestyle moment: golden-hour street, café window, or rooftop — candid
  confident energy, frames catching the light.
- Editorial gesture: the model holding the frame toward camera or adjusting
  it at the temple, fashion-magazine posing.
- Character moment: laughing, mid-glance-back, head tilt — natural movement,
  never a stiff passport-photo pose.
Describe the model only generically (age range, vibe, styling) — never name
or describe a real person's identity. The eyeglasses must stay sharp and
instantly recognizable on the face.`
  : `bgPrompt — describe a PRODUCT-PHOTOGRAPHY scene that puts "${frameLabel}" in
frame as the unmistakable hero, written for an AI image generator that will
receive the product's reference photos alongside this prompt. Pull from these
real eyewear-ad archetypes — rotate through them across the batch so the set
reads as a varied campaign, not the same shot four times:
- Color-blocked still life: the frame staged on/against a bold solid-color set
  (mustard, terracotta, burgundy, cream) with dramatic raking light and a long
  graphic shadow — sculptural, punchy, almost editorial.
- Minimalist styled set: the frame angled atop a small arrangement of clean
  geometric props (a pedestal, a sphere, a tilted slab, a stepped block) on a
  quiet two-tone backdrop — premium, considered, gallery-like.
- Textured-surface flat-lay: the frame resting on an evocative natural surface
  (sand, linen, warm stone, brushed fabric) with soft directional shadow and
  generous negative space around it.
Whichever you pick, the frame must stay sharp, well-lit, and instantly
recognizable — the scene serves the product, never competes with it.`}
Leave clean negative space in the lower third of the frame for a small caption
overlay (the renderer adds that — do not describe any text in the bgPrompt).

Output ONLY a valid JSON array. No commentary, no markdown fences.`;

const userPrompt = TOPIC
  ? `Generate ${COUNT} fresh ${client.label} clean product-showcase posters for "${frameLabel}", all about: "${TOPIC}". Mix Taglish and English naturally. Vary the structure, length, and chip usage across the set.`
  : `Generate ${COUNT} fresh ${client.label} clean product-showcase posters for "${frameLabel}", varying the angle (style, comfort, vibe, everyday flex) and copy structure. Mix Taglish and English naturally.`;

const ai = new GoogleGenAI({ vertexai: true, project, location });

console.log(
  `Generating ${COUNT} ${client.label} eyeglasses-showcase posters via Vertex AI (${MODEL}) in ${location}` +
    `\n  Frame: "${frameLabel}"` +
    (TOPIC ? `\n  Angle: "${TOPIC}"` : "") +
    "…",
);
const start = Date.now();

// Vertex AI text call — retry up to 3× with backoff for 429 quota errors.
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isQuota = (msg) => /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(String(msg));
const QUOTA_WAITS_MS = [15_000, 45_000]; // wait before attempt 2 and 3
let resp;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    resp = await ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              productLine: { type: Type.STRING },
              tagline: { type: Type.STRING },
              ctaTag: { type: Type.STRING },
              caption: { type: Type.STRING },
              aspectRatio: { type: Type.STRING, enum: ["4:5"] },
              variant: { type: Type.STRING, enum: ["showcase"] },
              kind: { type: Type.STRING, enum: ["product"] },
              bgPrompt: { type: Type.STRING },
              theme: { type: Type.STRING },
              ...(AI_HEADLINE ? { headline: { type: Type.STRING } } : {}),
            },
            required: AI_HEADLINE
              ? ["productLine", "caption", "bgPrompt", "headline"]
              : ["productLine", "caption", "bgPrompt"],
          },
        },
        // Higher than the quote pipeline — showcase copy needs creative range
        // (wordplay, twists); the COPY_RULES ban-list keeps it on brand.
        temperature: 0.9,
      },
    });
    break; // success
  } catch (err) {
    const msg = err?.message || String(err);
    if (attempt < 3 && isQuota(msg)) {
      const wait = QUOTA_WAITS_MS[attempt - 1];
      console.warn(`[glasses-gen] attempt ${attempt} hit quota (429). Waiting ${wait / 1000}s…`);
      await delay(wait);
    } else {
      console.error(`[glasses-gen] Vertex AI error (attempt ${attempt}): ${msg}`);
      process.exit(1);
    }
  }
}
if (!resp) { console.error("[glasses-gen] No response after retries."); process.exit(1); }

let posters;
try {
  posters = JSON.parse(resp.text);
} catch {
  console.error("Gemini response was not valid JSON:\n", resp.text);
  process.exit(1);
}
if (!Array.isArray(posters) || posters.length === 0) {
  console.error("Got empty or non-array response:", posters);
  process.exit(1);
}

// Layout rotation — distribute "bottom", "top", "center" evenly across the
// batch. Rotating in order ensures a varied set (random would cluster).
const LAYOUTS = ["bottom", "top", "center"];

// Normalization pass.
const clean = [];
for (const q of posters) {
  if (
    !q ||
    typeof q.productLine !== "string" ||
    !q.productLine.trim() ||
    typeof q.bgPrompt !== "string" ||
    !q.bgPrompt.trim() ||
    typeof q.caption !== "string" ||
    !q.caption.trim()
  )
    continue;
  q.variant = "showcase";
  q.aspectRatio = "4:5";
  q.kind = "product";
  q.productLine = q.productLine.trim();
  q.tagline = (q.tagline || "").trim();
  q.ctaTag = process.env.DASHBOARD_NO_CTA === "1"
    ? ""
    : (q.ctaTag || "").toUpperCase().trim();
  q.caption = q.caption.trim();
  // Assign layout in rotation so every three posters in the batch cycle through
  // all three visual treatments (bottom / top / center).
  q.layout = LAYOUTS[clean.length % LAYOUTS.length];
  // headline — user-supplied idea wins VERBATIM (the whole point of the
  // dashboard field); else the AI's, cleaned up; else empty so the renderer
  // falls back to productLine as the headline.
  if (HEADLINE_IDEA) {
    q.headline = HEADLINE_IDEA;
  } else if (AI_HEADLINE && typeof q.headline === "string" && q.headline.trim()) {
    q.headline = q.headline.trim();
    // Trim to 5 words max — anything longer defeats the big-type treatment.
    const words = q.headline.split(/\s+/);
    if (words.length > 6) q.headline = words.slice(0, 5).join(" ");
  } else {
    q.headline = "";
  }
  // Keep a `quote` fallback — the renderer's slugify() and generic gallery/
  // listing code key off `quote` for filenames/labels.
  q.quote = q.productLine;
  // A product showcase must ALWAYS show the product — never the flat-gradient
  // treatment (that produced text-only posters with no eyeglasses in them).
  q.useFlatBg = false;
  q.eyeglassesId = eyeglassesId;
  q.eyeglassesStyle = showcaseStyle;
  // Which poster style template the user picked — the renderer maps this to
  // a matching overlay type voice so the on-poster text matches the visual
  // style of the reference (e.g. type-overlay → heavy gold echo type).
  q.stylePreset = process.env.DASHBOARD_STYLE_PRESET || "";
  clean.push(q);
}
if (!clean.length) {
  console.error("All generated entries failed validation (missing productLine/caption/bgPrompt).");
  process.exit(1);
}
posters = clean;

const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outPath = path.join(outDir, `${client.quotePrefix}-${stamp}.json`);
await fs.writeFile(outPath, JSON.stringify(posters, null, 2));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  `\n✓ ${posters.length} ${client.label} eyeglasses-showcase poster(s) in ${elapsed}s\n  → ${outPath}\n`,
);
for (const q of posters.slice(0, 6)) console.log(`  • ${q.quote}`);
if (posters.length > 6) console.log(`  …and ${posters.length - 6} more`);
