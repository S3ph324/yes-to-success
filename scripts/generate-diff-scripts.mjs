#!/usr/bin/env node
// Techsplains step 1/4 — generate "what's the difference" video scripts via
// Vertex AI (Gemini) on the techsplains GCP project.
//
// Usage:
//   node scripts/generate-diff-scripts.mjs [count] [topic...]
//   node scripts/generate-diff-scripts.mjs 3 "video editing basics"
//
// Output: out/techsplains-scripts-<stamp>.json — one entry per video, two
// comparison segments each, ready for the images → audio → render steps.

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient, makeStamp, slugify } from "./lib/diff-config.mjs";
import { buildInstructions } from "./lib/diff-prompt.mjs";

const { client: CLIENT_ID, rest } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
cfg.applyGcpEnv();

const COUNT = parseInt(rest[0] || "3", 10);
const TOPIC = rest.slice(1).join(" ").trim();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const voiceProfile = await fs.readFile(cfg.voiceProfilePath, "utf-8");

const ledgerPath = cfg.ledgerPath;
let ledger = { used: [] };
try { ledger = JSON.parse(await fs.readFile(ledgerPath, "utf-8")); } catch { /* first run */ }

const DYK = parseInt(process.env.DIFF_DYK ?? process.env.TECHSPLAINS_DYK ?? String(Math.round(COUNT * (cfg.contentMix.dykDefault || 0))), 10) || 0;
const GENERAL = parseInt(process.env.DIFF_GENERAL ?? process.env.TECHSPLAINS_GENERAL ?? String(Math.round(COUNT * (cfg.contentMix.generalDefault || 0))), 10) || 0;

const { diffInstruction, dykInstruction, DIFF_COUNT, DYK_COUNT, GENERAL_COUNT } =
  buildInstructions(cfg, voiceProfile, ledger, { count: COUNT, topic: TOPIC, dyk: DYK, general: GENERAL });

const segmentSchema = {
  type: Type.OBJECT,
  properties: {
    aLabel: { type: Type.STRING, description: "Display label for the first thing, e.g. 'Codec'" },
    bLabel: { type: Type.STRING, description: "Display label for the second thing, e.g. 'Container'" },
    introA: { type: Type.STRING, description: "'This is a codec.' style sentence" },
    introB: { type: Type.STRING },
    defA: { type: Type.STRING, description: "One-sentence definition of the first thing, max 20 words" },
    defB: { type: Type.STRING },
    aSearchQuery: { type: Type.STRING, description: "2-4 keyword stock-photo search, e.g. 'mechanical keyboard closeup'" },
    bSearchQuery: { type: Type.STRING },
    aImagePrompt: { type: Type.STRING, description: "AI-image fallback prompt if the stock search misses" },
    bImagePrompt: { type: Type.STRING },
  },
  required: ["aLabel", "bLabel", "introA", "introB", "defA", "defB", "aSearchQuery", "bSearchQuery", "aImagePrompt", "bImagePrompt"],
};

// DYK videos carry a small SLIDESHOW instead of one static image — the model
// supplies several distinct visual beats. mediaPrompts is optional (the images
// step falls back to aImagePrompt if it's missing).
const dykSegmentSchema = {
  type: Type.OBJECT,
  properties: {
    ...segmentSchema.properties,
    mediaPrompts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3 DISTINCT image prompts, each a DIFFERENT visual beat/scene of this fact (vary the subject, setting, or angle) for a slideshow — not three near-duplicates.",
    },
  },
  required: segmentSchema.required,
};

const ai = new GoogleGenAI({
  vertexai: true,
  project: cfg.gcp.project,
  location: cfg.gcp.location,
});

console.log(
  `Generating ${COUNT} ${cfg.brandName} script(s) via Vertex AI (${MODEL})` +
    ` — ${DIFF_COUNT} difference / ${DYK_COUNT} didyouknow` +
    (GENERAL_COUNT ? ` (${GENERAL_COUNT} general)` : "") +
    (TOPIC ? `\n  Topic: "${TOPIC}"` : "") + "…",
);
const start = Date.now();

// One call per variant. Splitting means the DYK "one segment" instruction
// can't bleed into the difference videos, and minItems/maxItems on the
// segments array makes the shape a hard constraint instead of a request —
// mixed single-call batches kept returning 1-segment difference videos.
const videoSchema = (segCount, segSchema = segmentSchema) => ({
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "e.g. 'Codec vs Container'" },
      category: { type: Type.STRING, enum: ["editing", "creation", "tech", "general"] },
      variant: { type: Type.STRING, enum: ["difference", "didyouknow"] },
      hook: { type: Type.STRING, description: "A SCROLL-STOPPING opening hook, max 9 words — follow the HOOK framework in the profile EXACTLY (specific + punchy: costly mistake, curiosity gap, stinging question, or contrarian claim). This line alone decides whether viewers keep watching; never generic." },
      outro: { type: Type.STRING, description: `Engagement question + '${cfg.outro}'` },
      caption: { type: Type.STRING, description: "Facebook caption per the profile" },
      segments: {
        type: Type.ARRAY,
        items: segSchema,
        minItems: String(segCount),
        maxItems: String(segCount),
      },
    },
    required: ["title", "category", "variant", "hook", "outro", "caption", "segments"],
  },
});

const generateVariant = async (n, systemInstruction, segCount, label, segSchema = segmentSchema) => {
  if (n <= 0) return [];
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: TOPIC
      ? `Generate ${n} ${cfg.brandName} ${label} video script(s) about: "${TOPIC}".`
      : `Generate ${n} ${cfg.brandName} ${label} video script(s) for today's batch — maximize variety.`,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: videoSchema(segCount, segSchema),
      temperature: 0.8,
    },
  });
  try {
    return JSON.parse(resp.text);
  } catch {
    console.error(`Gemini ${label} response was not valid JSON:\n`, resp.text);
    return [];
  }
};

const [diffVideos, dykVideos] = await Promise.all([
  generateVariant(DIFF_COUNT, diffInstruction, 2, "difference"),
  generateVariant(DYK_COUNT, dykInstruction, 1, "didyouknow", dykSegmentSchema),
]);
for (const v of diffVideos) v.variant = "difference";
for (const v of dykVideos) v.variant = "didyouknow";
const videos = [...diffVideos, ...dykVideos];
if (!videos.length) {
  console.error("Both generation calls returned nothing.");
  process.exit(1);
}

// Validate hard requirements; drop broken entries rather than shipping them.
const dykRe = new RegExp("^" + cfg.dykOpener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const clean = [];
for (const v of videos) {
  if (!v || !Array.isArray(v.segments) || !v.hook) continue;
  const isDyk = v.variant === "didyouknow";
  if (isDyk) {
    if (v.segments.length !== 1) continue;
    const s = v.segments[0];
    if (!(s.aLabel && s.introA && s.defA && s.aSearchQuery && s.aImagePrompt)) continue;
    // The brand rule: every DYK video literally opens with cfg.dykOpener.
    if (!dykRe.test(v.hook.trim())) {
      v.hook = `${cfg.dykOpener} ${v.hook.trim().replace(/^[A-Z]/, (c) => c.toLowerCase())}`;
    }
    if (s.introA.split(/\s+/).length > 22 || s.defA.split(/\s+/).length > 22) continue;
    // The renderer treats an empty bLabel as "single image, centered".
    s.bLabel = ""; s.introB = ""; s.defB = ""; s.bSearchQuery = ""; s.bImagePrompt = "";
    // Keep 2-4 distinct slideshow prompts (the images step builds s.media).
    s.mediaPrompts = Array.isArray(s.mediaPrompts)
      ? s.mediaPrompts.filter((p) => typeof p === "string" && p.trim()).slice(0, 4)
      : [];
  } else {
    if (v.segments.length !== 2) continue;
    const segsOk = v.segments.every(
      (s) =>
        s.aLabel && s.bLabel && s.introA && s.introB && s.defA && s.defB &&
        s.aImagePrompt && s.bImagePrompt &&
        s.defA.split(/\s+/).length <= 26 && s.defB.split(/\s+/).length <= 26,
    );
    if (!segsOk) continue;
    for (const s of v.segments) delete s.mediaPrompts; // difference videos don't use it
    v.variant = "difference";
  }
  v.id = slugify(v.title);
  v.outro = v.outro || cfg.outro;
  clean.push(v);
}
if (!clean.length) {
  console.error("All generated scripts failed validation.");
  process.exit(1);
}

const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const stamp = makeStamp();
const outPath = path.join(outDir, `${cfg.id}-scripts-${stamp}.json`);
await fs.writeFile(outPath, JSON.stringify(clean, null, 2));

// Record what we used so future batches can't repeat it.
for (const v of clean) {
  for (const s of v.segments) {
    ledger.used.push(
      s.bLabel ? `${s.aLabel} vs ${s.bLabel}`.toLowerCase() : `fact: ${s.introA}`.toLowerCase(),
    );
  }
}
ledger.used = [...new Set(ledger.used)].slice(-300);
await fs.writeFile(ledgerPath, JSON.stringify(ledger, null, 2));

console.log(
  `\n✓ ${clean.length} script(s) in ${((Date.now() - start) / 1000).toFixed(1)}s\n  → ${outPath}\n`,
);
for (const v of clean)
  console.log(
    `  • [${v.variant}] ${v.title}  [${v.category}]  (${v.segments
      .map((s) => (s.bLabel ? `${s.aLabel}/${s.bLabel}` : s.aLabel))
      .join(" + ")})`,
  );
