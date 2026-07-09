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
import { projectRoot, resolveClient } from "./lib/client.mjs";
import {
  applyTechsplainsGcpEnv,
  TS_GCP,
  TS_OUTRO,
  makeStamp,
  slugify,
} from "./lib/techsplains.mjs";

applyTechsplainsGcpEnv();

const COUNT = parseInt(process.argv[2] || "3", 10);
const TOPIC = process.argv.slice(3).join(" ").trim();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const client = await resolveClient("techsplains");
const voiceProfile = await fs.readFile(client.voiceProfilePath, "utf-8");

let brief = null;
try {
  const briefs = JSON.parse(
    await fs.readFile(path.join(projectRoot, "config", "briefs.json"), "utf-8"),
  );
  brief = briefs.find((b) => b.id === client.briefId) || null;
} catch { /* profile alone is enough */ }

const briefBlock = brief
  ? `\n\n## TOPIC POOLS (rotate across the batch, ~60% editing/creation, ~30% tech):\n` +
    brief.topics.map((t) => `- ${t}`).join("\n") +
    (brief.voiceNotes ? `\n\nVoice notes: ${brief.voiceNotes}` : "")
  : "";

// Topic ledger — every comparison/fact ever shipped. Without it each batch
// independently rediscovers the same crowd-pleasers (codec vs container came
// up in three consecutive batches).
const ledgerPath = path.join(projectRoot, "config", "techsplains-topic-ledger.json");
let ledger = { used: [] };
try {
  ledger = JSON.parse(await fs.readFile(ledgerPath, "utf-8"));
} catch { /* first run */ }
const ledgerBlock = ledger.used.length
  ? `\n\n## ALREADY PUBLISHED — never generate any of these again, and avoid near-duplicates:\n` +
    ledger.used.map((t) => `- ${t}`).join("\n")
  : "";

// How many of the batch should be "did you know" single-fact videos.
const DYK_COUNT = Math.min(
  COUNT,
  parseInt(process.env.TECHSPLAINS_DYK ?? String(Math.round(COUNT / 4)), 10) || 0,
);

const systemInstruction = `${voiceProfile}${briefBlock}${ledgerBlock}

You are generating ${COUNT} Techsplains video script(s): ${COUNT - DYK_COUNT} "difference" video(s) and ${DYK_COUNT} "didyouknow" video(s).
${TOPIC ? `EVERY video in this batch must be about: "${TOPIC}".` : "Rotate across the topic pools."}

DIFFERENCE videos (variant="difference"): exactly TWO related segments. Follow
the script formula from the profile EXACTLY — the renderer depends on the
sentence structure. In the intro sentences use natural articles ("This is a
codec." but "This is RAM.").

DIDYOUKNOW videos (variant="didyouknow"): ONE segment, one genuinely
surprising true fact from the same topic pools.
- hook: MUST literally start with the words "Did you know" — e.g. "Did you
  know your phone camera is lying to you?" Max 11 words total.
- The segment's introA = the FACT itself, one punchy sentence, max 16 words.
- The segment's defA = WHY/how it works, one sentence, max 16 words.
- aLabel = short display label for the subject; aSearchQuery + aImagePrompt
  for its single image. Leave bLabel, introB, defB, bSearchQuery,
  bImagePrompt as empty strings.
- outro: engagement question + "Follow Techsplains for more!"

VARIETY RULES:
- Every video in the batch comes from a DIFFERENT topic pool line.
- Vary the hook style across the batch (callout / question / bold claim).
- No two videos in the batch may share a comparison or fact.

Output ONLY valid JSON.`;

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

const ai = new GoogleGenAI({
  vertexai: true,
  project: TS_GCP.project,
  location: TS_GCP.location,
});

console.log(
  `Generating ${COUNT} Techsplains script(s) via Vertex AI (${MODEL})` +
    (TOPIC ? `\n  Topic: "${TOPIC}"` : "") + "…",
);
const start = Date.now();

const resp = await ai.models.generateContent({
  model: MODEL,
  contents: TOPIC
    ? `Generate ${COUNT} Techsplains video script(s) about: "${TOPIC}".`
    : `Generate ${COUNT} Techsplains video script(s) for today's batch — maximize variety.`,
  config: {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "e.g. 'Codec vs Container'" },
          category: { type: Type.STRING, enum: ["editing", "creation", "tech"] },
          variant: { type: Type.STRING, enum: ["difference", "didyouknow"] },
          hook: { type: Type.STRING, description: "Opening hook line, max 9 words, per the profile" },
          outro: { type: Type.STRING, description: "Engagement question + 'Follow Techsplains for more!'" },
          caption: { type: Type.STRING, description: "Facebook caption per the profile" },
          segments: { type: Type.ARRAY, items: segmentSchema },
        },
        required: ["title", "category", "variant", "hook", "outro", "caption", "segments"],
      },
    },
    temperature: 0.8,
  },
});

let videos;
try {
  videos = JSON.parse(resp.text);
} catch {
  console.error("Gemini response was not valid JSON:\n", resp.text);
  process.exit(1);
}

// Validate hard requirements; drop broken entries rather than shipping them.
const clean = [];
for (const v of videos) {
  if (!v || !Array.isArray(v.segments) || !v.hook) continue;
  const isDyk = v.variant === "didyouknow";
  if (isDyk) {
    if (v.segments.length !== 1) continue;
    const s = v.segments[0];
    if (!(s.aLabel && s.introA && s.defA && s.aSearchQuery && s.aImagePrompt)) continue;
    // The brand rule: every DYK video literally opens with "Did you know".
    if (!/^did you know/i.test(v.hook.trim())) {
      v.hook = `Did you know ${v.hook.trim().replace(/^[A-Z]/, (c) => c.toLowerCase())}`;
    }
    if (s.introA.split(/\s+/).length > 22 || s.defA.split(/\s+/).length > 22) continue;
    // The renderer treats an empty bLabel as "single image, centered".
    s.bLabel = ""; s.introB = ""; s.defB = ""; s.bSearchQuery = ""; s.bImagePrompt = "";
  } else {
    if (v.segments.length !== 2) continue;
    const segsOk = v.segments.every(
      (s) =>
        s.aLabel && s.bLabel && s.introA && s.introB && s.defA && s.defB &&
        s.aImagePrompt && s.bImagePrompt &&
        s.defA.split(/\s+/).length <= 26 && s.defB.split(/\s+/).length <= 26,
    );
    if (!segsOk) continue;
    v.variant = "difference";
  }
  v.id = slugify(v.title);
  v.outro = v.outro || TS_OUTRO;
  clean.push(v);
}
if (!clean.length) {
  console.error("All generated scripts failed validation.");
  process.exit(1);
}

const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const stamp = makeStamp();
const outPath = path.join(outDir, `techsplains-scripts-${stamp}.json`);
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
