#!/usr/bin/env node
// Multi-client quote-poster generator via Vertex AI (Gemini).
// Client-aware (Jurie / Tranzzie / …) via config/clients.json. John Calub's
// original generate-quotes.mjs is separate and untouched.
//
// Usage:
//   node scripts/generate-quotes-jurie.mjs [--client jurie|tranzzie] [count] [topic...]
//   CLIENT=tranzzie node scripts/generate-quotes-jurie.mjs 8 "photochromic lenses"
//
// Output: out/<client>-quotes-YYYY-MM-DDTHH-mm.json

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
const client = await resolveClient(clientArg);

const COUNT = parseInt(rest[0] || "8", 10);
const TOPIC =
  process.env.CLIENT_TOPIC ||
  process.env.JURIE_TOPIC ||
  rest.slice(1).join(" ").trim();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const voiceProfile = await fs.readFile(client.voiceProfilePath, "utf-8");

// Pull the client's content brief.
const briefId = process.env.DASHBOARD_BRIEF_ID || client.briefId;
let activeBrief = null;
try {
  const briefs = JSON.parse(
    await fs.readFile(path.join(projectRoot, "config", "briefs.json"), "utf-8"),
  );
  activeBrief =
    briefs.find((b) => b.id === briefId) ||
    briefs.find((b) => b.client === client.id) ||
    null;
} catch {
  /* fall back to defaults below */
}

const topics = TOPIC
  ? [TOPIC]
  : activeBrief?.topics?.length
    ? activeBrief.topics
    : ["general"];

const briefBlock =
  `\n\n## ACTIVE BRIEF: ${activeBrief?.name || client.label}\n\n` +
  (TOPIC
    ? `**SINGLE TOPIC — every poster in this batch must be about:** "${TOPIC}"\n\n`
    : `**Topics to rotate across the batch:** ${topics.join(", ")}\n\n`) +
  (activeBrief?.voiceNotes
    ? `**Voice notes:**\n${activeBrief.voiceNotes}\n\n`
    : "") +
  (activeBrief?.bannedPhrases?.length
    ? `**HARD BANNED PHRASES — never generate any of these:**\n` +
      activeBrief.bannedPhrases.map((p) => `  - ${p}`).join("\n") +
      `\n\n`
    : "");

const systemInstruction = `${voiceProfile}${briefBlock}

You are generating quote-poster entries for ${client.label}'s Facebook page.
Produce exactly ${COUNT} entries. ${
  TOPIC
    ? `EVERY entry must clearly be about: "${TOPIC}".`
    : `Rotate across the brief topics.`
}

Poster structure EXACTLY:
- HOOK (top): a relatable problem/feeling, ends with an ellipsis "…".
- PAYOFF (bottom): directly RESOLVES the same idea the hook raised.

GRAMMAR & COHERENCE — most important; reject anything that fails:
- Every hook and payoff must be a natural, grammatically correct Taglish
  phrase a real Filipino would actually say out loud. Read it back: if it
  sounds broken, off, or like random words strung together, REWRITE it
  before you output it.
- Hook and payoff must connect logically — the payoff answers the hook.
  No non-sequiturs, no word-salad, no missing/!wrong particles.
- Do NOT sacrifice grammar to be short. Clear and correct beats clever.
- Vary openers — no two hooks start the same way. No duplicates. Never
  shame the audience.

EMPHASIS — choose deliberately, not randomly:
- Exactly ONE "rb" (red bar) per poster: the single most charged
  problem/pain word, and it MUST be in the HOOK — never in the payoff.
- Exactly ONE "g" (gold) phrase: the solution/benefit, in the PAYOFF
  (e.g. the product or the win), 1–2 words max.
- Optional: at most ONE "r" (red) word for a secondary jab.
- Everything else is "w" (white).
- NEVER color particles/connectors (sa, ng, ang, na, ay, mo, ka, pa, ba,
  o, at, kung, mga, si, ni, kay, ito, iyan) — those stay "w".
This is the visual hierarchy: gold payoff = biggest, white = body,
the one red bar = the hook's punch.

Output ONLY a valid JSON array. No commentary, no markdown fences.`;

const userPrompt = TOPIC
  ? `Generate ${COUNT} fresh ${client.label} quote posters, all about: "${TOPIC}". Mix Taglish and English naturally. Vary the angle of each one.`
  : `Generate ${COUNT} fresh ${client.label} quote posters for today's batch, rotating the brief topics. Mix Taglish and English naturally.`;

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
  `Generating ${COUNT} ${client.label} quotes via Vertex AI (${MODEL}) in ${location}` +
    (TOPIC ? `\n  Topic: "${TOPIC}"` : "") +
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
    temperature: 0.6,
  },
});

let quotes;
try {
  quotes = JSON.parse(resp.text);
} catch {
  console.error("Gemini response was not valid JSON:\n", resp.text);
  process.exit(1);
}
if (!Array.isArray(quotes) || quotes.length === 0) {
  console.error("Got empty or non-array response:", quotes);
  process.exit(1);
}

// Normalize + enforce the emphasis rules deterministically (so hierarchy is
// consistent regardless of model variance): drop broken entries, never color
// particles, exactly ONE red-bar (in the hook), at most TWO gold (prefer the
// payoff). ctaComment/ctaTail are filled from the brand preset at render time.
const PARTICLES = new Set([
  "sa", "ng", "ang", "na", "ay", "mo", "ka", "pa", "ba", "o", "at", "kung",
  "mga", "si", "ni", "kay", "ito", "iyan", "yan", "nang", "din", "rin", "po",
]);
const bare = (w) =>
  String(w || "").toLowerCase().replace(/[^a-zñ0-9]/gi, "");
const hasTok = (L) =>
  Array.isArray(L) && L.some((ln) => Array.isArray(ln) && ln.length);

const clean = [];
for (const q of quotes) {
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
  q.ctaComment = (q.ctaComment || "").toUpperCase();
  q.ctaTail = q.ctaTail || "";
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
quotes = clean;

const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outPath = path.join(outDir, `${client.quotePrefix}-${stamp}.json`);
await fs.writeFile(outPath, JSON.stringify(quotes, null, 2));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  `\n✓ ${quotes.length} ${client.label} quotes in ${elapsed}s\n  → ${outPath}\n`,
);
for (const q of quotes.slice(0, 6)) console.log(`  • ${q.quote}`);
if (quotes.length > 6) console.log(`  …and ${quotes.length - 6} more`);
