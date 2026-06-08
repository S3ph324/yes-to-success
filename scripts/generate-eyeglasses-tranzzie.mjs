#!/usr/bin/env node
// Eyeglasses-showcase content generator — Tranzzie only.
// Produces the SAME output JSON shape as generate-quotes-jurie.mjs
// (topLines/bottomLines/quote/caption/keyword/ctaComment/bgPrompt/aspectRatio/
// variant/kind/useCta/useFlatBg) so it flows unchanged through the existing
// render-batch-jurie.mjs → JurieQuoteCard pipeline. Only the VOICE differs:
// product-showcase copy that puts a specific pair of eyeglasses front and
// center, instead of the Taglish hook→payoff quote format.
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

const voiceProfile = await fs.readFile(client.voiceProfilePath, "utf-8");

// Resolve the featured frame (asset preset). May be empty — the dashboard
// only lets the user pick from what exists in config/eyeglasses.json, and
// that file starts empty until frames are added via the Eyeglasses tab.
const eyeglassesId = process.env.DASHBOARD_EYEGLASSES_ID || "";
const showcaseStyle = process.env.DASHBOARD_EYEGLASSES_STYLE || "showcase";
let frame = null;
try {
  const all = JSON.parse(
    await fs.readFile(path.join(projectRoot, "config", "eyeglasses.json"), "utf-8"),
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

const topics = TOPIC ? [TOPIC] : [];
const briefBlock = TOPIC
  ? `\n**SINGLE ANGLE — every poster in this batch must spotlight this angle of the product:** "${TOPIC}"\n`
  : `\n**Vary the angle across the batch** — style, comfort, durability, everyday wearability, the "main character energy" the frame gives, etc.\n`;

const styleNote =
  showcaseStyle === "showcase"
    ? `\nFORMAT — PRODUCT SHOWCASE (the only style wired up right now):\n` +
      `- topLines: a punchy product-forward HOOK about the eyeglasses (style, vibe, "you'll want these"), ends with an ellipsis "…" OR a strong product statement.\n` +
      `- bottomLines: the PAYOFF — what makes "${frameLabel}" worth it (the feature, the feeling, the flex), landing on the product/benefit.\n` +
      `- Sounds like a product drop / OOTD caption, not a motivational quote. Confident, stylish, a little hype — but never salesy-desperate.\n`
    : `\nFORMAT — PRODUCT SHOWCASE (fallback; other eyeglasses formats are not enabled yet):\n` +
      `- Same topLines/bottomLines hook→payoff shape, spotlighting "${frameLabel}".\n`;

const systemInstruction = `${voiceProfile}${subjectBlock}${briefBlock}
You are generating product-showcase poster entries for ${client.label}'s
Facebook page, all featuring the same pair of eyeglasses: "${frameLabel}".
Produce exactly ${COUNT} entries.${styleNote}

GRAMMAR & COHERENCE — most important; reject anything that fails:
- Every line must be a natural, grammatically correct Taglish or English
  phrase a real Filipino brand would actually post. Read it back: if it
  sounds broken, off, or like random words strung together, REWRITE it.
- topLines and bottomLines must connect logically — the payoff lands the
  hook's setup. No non-sequiturs, no word-salad.
- Vary openers — no two entries start the same way. No duplicates.

EMPHASIS — choose deliberately, not randomly:
- Exactly ONE "rb" (red bar) per poster: the most charged/attention-grabbing
  word, and it MUST be in the topLines (hook) — never in bottomLines.
- Exactly ONE "g" (gold) phrase: the product/benefit highlight, in the
  bottomLines (payoff), 1–2 words max — ideally evokes the product or the
  feeling of wearing it.
- Optional: at most ONE "r" (red) word for a secondary accent.
- Everything else is "w" (white).
- NEVER color particles/connectors (sa, ng, ang, na, ay, mo, ka, pa, ba,
  o, at, kung, mga, si, ni, kay, ito, iyan) — those stay "w".

bgPrompt — describe a PRODUCT-PHOTOGRAPHY scene that puts "${frameLabel}" in
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
- On-face / lifestyle moment: a person wearing the frame or holding it up to
  camera, cropped tight (shoulders-up or hand-and-frame), natural light,
  confident styled-fashion energy — never a flat posed headshot.
- Textured-surface flat-lay: the frame resting on an evocative natural surface
  (sand, linen, warm stone, brushed fabric) with soft directional shadow and
  generous negative space around it.
Whichever you pick, the frame must stay sharp, well-lit, and instantly
recognizable — the scene serves the product, never competes with it.

Output ONLY a valid JSON array. No commentary, no markdown fences.`;

const userPrompt = TOPIC
  ? `Generate ${COUNT} fresh ${client.label} product-showcase posters for "${frameLabel}", all about: "${TOPIC}". Mix Taglish and English naturally. Vary the angle of each one.`
  : `Generate ${COUNT} fresh ${client.label} product-showcase posters for "${frameLabel}", varying the angle (style, comfort, vibe, everyday flex). Mix Taglish and English naturally.`;

const ai = new GoogleGenAI({ vertexai: true, project, location });

const tokenObj = {
  type: Type.OBJECT,
  properties: {
    t: { type: Type.STRING },
    s: { type: Type.STRING, enum: ["w", "g", "r", "rb"] },
  },
  required: ["t", "s"],
};
const linesArr = {
  type: Type.ARRAY,
  items: { type: Type.ARRAY, items: tokenObj },
};

console.log(
  `Generating ${COUNT} ${client.label} eyeglasses-showcase posters via Vertex AI (${MODEL}) in ${location}` +
    `\n  Frame: "${frameLabel}"` +
    (TOPIC ? `\n  Angle: "${TOPIC}"` : "") +
    "…",
);
const start = Date.now();

const resp = await ai.models.generateContent({
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
          quote: { type: Type.STRING },
          caption: { type: Type.STRING },
          topLines: linesArr,
          bottomLines: linesArr,
          keyword: { type: Type.STRING },
          ctaComment: { type: Type.STRING },
          aspectRatio: { type: Type.STRING, enum: ["4:5"] },
          variant: { type: Type.STRING, enum: ["jurie"] },
          kind: { type: Type.STRING, enum: ["hook"] },
          bgPrompt: { type: Type.STRING },
          theme: { type: Type.STRING },
        },
        required: [
          "quote",
          "caption",
          "topLines",
          "bottomLines",
          "bgPrompt",
        ],
      },
    },
    temperature: 0.65,
  },
});

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

// Same deterministic normalization pass as generate-quotes-jurie.mjs, so the
// downstream renderer sees an identical shape regardless of which content
// generator produced the batch.
const PARTICLES = new Set([
  "sa", "ng", "ang", "na", "ay", "mo", "ka", "pa", "ba", "o", "at", "kung",
  "mga", "si", "ni", "kay", "ito", "iyan", "yan", "nang", "din", "rin", "po",
]);
const bare = (w) =>
  String(w || "").toLowerCase().replace(/[^a-zñ0-9]/gi, "");
const hasTok = (L) =>
  Array.isArray(L) && L.some((ln) => Array.isArray(ln) && ln.length);

const clean = [];
for (const q of posters) {
  if (
    !q ||
    typeof q.quote !== "string" ||
    q.quote.trim().split(/\s+/).length < 3 ||
    !hasTok(q.topLines) ||
    !hasTok(q.bottomLines)
  )
    continue;
  q.variant = "jurie";
  q.aspectRatio = "4:5";
  q.kind = "hook";
  q.ctaComment = (q.ctaComment || "").toUpperCase();
  q.ctaTail = q.ctaTail || "";
  // Showcase posters carry a CTA more often than regular quotes (it's a
  // product post — driving to "shop now"/"learn more" makes sense), and
  // skip the AI flat-bg roll less often (the product needs a real scene).
  q.useCta = Math.random() < 0.7;
  q.useFlatBg = Math.random() < 0.1;
  q.eyeglassesId = eyeglassesId;
  q.eyeglassesStyle = showcaseStyle;
  q.topLines = (q.topLines || []).map((l) => l.filter((t) => t && t.t));
  q.bottomLines = (q.bottomLines || []).map((l) => l.filter((t) => t && t.t));
  const decolor = (lines) =>
    lines.forEach((ln) =>
      ln.forEach((tk) => {
        if (tk.s && tk.s !== "w" && PARTICLES.has(bare(tk.t))) tk.s = "w";
      }),
    );
  decolor(q.topLines);
  decolor(q.bottomLines);
  let rbKept = false;
  const capRb = (lines, allow) =>
    lines.forEach((ln) =>
      ln.forEach((tk) => {
        if (tk.s === "rb") {
          if (allow && !rbKept) rbKept = true;
          else tk.s = "w";
        }
      }),
    );
  capRb(q.topLines, true);
  capRb(q.bottomLines, false);
  let gold = 0;
  const capG = (lines) =>
    lines.forEach((ln) =>
      ln.forEach((tk) => {
        if (tk.s === "g") {
          if (gold < 2) gold++;
          else tk.s = "w";
        }
      }),
    );
  capG(q.bottomLines);
  capG(q.topLines);
  clean.push(q);
}
if (!clean.length) {
  console.error("All generated entries failed coherence/emphasis checks.");
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
