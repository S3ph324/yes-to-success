#!/usr/bin/env node
// Generate a batch of John Calub-voice quote-card entries via Vertex AI.
//
// Uses Application Default Credentials (ADC). Runs against the $300 trial
// credit pool (Cloud billing) — same path as generate-backgrounds.mjs.
//
// Required env vars:
//   GOOGLE_CLOUD_PROJECT   - your billing-enabled GCP project ID
//   GOOGLE_CLOUD_LOCATION  - region (default us-central1)
//
// Usage:
//   GOOGLE_CLOUD_PROJECT=... node scripts/generate-quotes.mjs [count] [model]
//
// Output: out/quotes-YYYY-MM-DDTHH-mm.json

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
if (!project) {
  console.error(
    "Missing GOOGLE_CLOUD_PROJECT env var.\n" +
      "  export GOOGLE_CLOUD_PROJECT=your-project-id\n" +
      "And run once: gcloud auth application-default login",
  );
  process.exit(1);
}

const COUNT = parseInt(process.argv[2] || "20", 10);
const MODEL = process.argv[3] || process.env.GEMINI_MODEL || "gemini-2.5-flash";

const voiceProfile = await fs.readFile(
  path.join(__dirname, "voice-profile.md"),
  "utf-8",
);

// Pull the active content brief (from the dashboard) if available.
const briefId = process.env.DASHBOARD_BRIEF_ID || "";
let activeBrief = null;
try {
  const briefs = JSON.parse(
    await fs.readFile(path.join(projectRoot, "config", "briefs.json"), "utf-8"),
  );
  activeBrief =
    briefs.find((b) => b.id === briefId) || briefs[0] || null;
} catch {
  // no briefs config yet — fall back to defaults
}

const topics = activeBrief?.topics?.length
  ? activeBrief.topics
  : ["trading", "yes-to-success", "biohacking"];

const briefOverrides = activeBrief
  ? `\n\n## ACTIVE CONTENT BRIEF: ${activeBrief.name}\n\n` +
    `**Topics to rotate across:** ${topics.join(", ")}\n\n` +
    (activeBrief.voiceNotes
      ? `**Voice notes from operator:**\n${activeBrief.voiceNotes}\n\n`
      : "") +
    (activeBrief.bannedPhrases?.length
      ? `**HARD BANNED PHRASES — never generate any of these:**\n` +
        activeBrief.bannedPhrases.map((p) => `  - ${p}`).join("\n") +
        `\n\n`
      : "") +
    (activeBrief.activeCampaigns
      ? `**Active campaigns** (mention occasionally, max 1 in 5 captions):\n${activeBrief.activeCampaigns}\n\n`
      : "")
  : "";

const systemInstruction = `${voiceProfile}${briefOverrides}

You are generating quote-card entries for John Calub's Facebook page
(JohnCalubTraining). The content pillars to rotate across this batch are:
${topics.map((t) => `  - **${t}**`).join("\n")}

Each entry must include:
  - quote: the actual Taglish/English quote text (1-3 sentences) that will
    be rendered ON THE CARD IMAGE.
  - caption: the Facebook post copy that appears ABOVE the image in the FB
    feed — distinct from the quote, short (1-3 sentences), adds context
    or invites engagement. ALWAYS ends with:
      \\n\\n— John Calub, Philippines' #1 Success Coach
    NO hashtags, NO emojis. See the FB caption style rules in the voice profile.
  - theme: one of (trading | yes-to-success | biohacking | money | mindset | manifestation | sales | breakthrough)
  - variant: one of (classic | image | bold)
      • classic = traditional poster layout (~40% of batch)
      • image = full-bleed background image with quote overlay (~40%)
      • bold = one-keyword huge with surrounding text smaller (~20%)
  - aspectRatio: one of ("1:1" | "4:5" | "9:16")
      • "4:5" = portrait, FB feed optimal, highest engagement (~60% of batch)
      • "1:1" = square, FB feed universal (~30%)
      • "9:16" = vertical, Stories/Reels (~10%)
      Pick aspect ratio to fit the quote: short punchy quotes work great
      at 1:1; longer story-style quotes benefit from 4:5 or 9:16.
  - bgPrompt: ONLY if variant === "image". A 1-2 sentence visual brief for an
    AI image generator. Describe a CINEMATIC PHOTOGRAPHIC scene that
    visualizes the quote's metaphor — wealth, abundance, mindset, manifestation.
    Examples: "Stacks of US dollar bills on a luxury mahogany desk, golden
    hour light", "A lone figure standing on a Manila high-rise rooftop at
    sunrise, arms open wide", "Close-up of hands cradling glowing golden
    orbs of light in a dim room". NO text, NO logos, NO people facing camera.
    Vertical 4:5 composition with negative space for text overlay.
  - keyword: ONLY if variant === "bold". The single most powerful word from
    the quote, in uppercase. Usually a noun or verb. Examples: "MINDSET",
    "ABUNDANCE", "MAGNET", "BREAKTHROUGH", "YUMAMAN". Pick a word that's
    actually in the quote.

Distribute variants across the batch: roughly 40% classic, 40% image, 20% bold.
Distribute aspect ratios: roughly 60% "4:5", 30% "1:1", 10% "9:16".
Output ONLY a valid JSON array. No commentary, no markdown fences.`;

const userPrompt = `Generate ${COUNT} fresh quote-card entries for today's
batch. Vary themes — rotate trading, yes-to-success, biohacking, and the
classic mindset/money/manifestation themes. Mix Taglish and English. Each
quote 1-3 sentences. Vary variants per the distribution (40/40/20).

Do not repeat openers. No duplicates. Empathetic tone — validate the
audience's effort, never insult their current work.`;

const ai = new GoogleGenAI({
  vertexai: true,
  project,
  location,
});

console.log(
  `Generating ${COUNT} quotes via Vertex AI (${MODEL}) in ${location}…`,
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
          theme: {
            type: Type.STRING,
            enum: [
              "trading",
              "yes-to-success",
              "biohacking",
              "money",
              "mindset",
              "manifestation",
              "sales",
              "breakthrough",
            ],
          },
          variant: {
            type: Type.STRING,
            enum: ["classic", "image", "bold"],
          },
          aspectRatio: {
            type: Type.STRING,
            enum: ["1:1", "4:5", "9:16"],
          },
          bgPrompt: { type: Type.STRING },
          keyword: { type: Type.STRING },
        },
        required: ["quote", "caption", "theme", "variant", "aspectRatio"],
      },
    },
    temperature: 0.95,
  },
});

const text = resp.text;
let quotes;
try {
  quotes = JSON.parse(text);
} catch (err) {
  console.error("Gemini response was not valid JSON:");
  console.error(text);
  process.exit(1);
}

if (!Array.isArray(quotes) || quotes.length === 0) {
  console.error("Got empty or non-array response:", quotes);
  process.exit(1);
}

const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outPath = path.join(outDir, `quotes-${stamp}.json`);
await fs.writeFile(outPath, JSON.stringify(quotes, null, 2));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  `\n✓ ${quotes.length} quotes generated in ${elapsed}s\n  → ${outPath}\n`,
);

const variantCounts = quotes.reduce((acc, q) => {
  acc[q.variant] = (acc[q.variant] || 0) + 1;
  return acc;
}, {});
const aspectCounts = quotes.reduce((acc, q) => {
  acc[q.aspectRatio] = (acc[q.aspectRatio] || 0) + 1;
  return acc;
}, {});
console.log("Variant distribution:", variantCounts);
console.log("Aspect distribution:", aspectCounts);
console.log("\nPreview:");
for (const q of quotes.slice(0, 6)) {
  console.log(
    `  [${q.variant.padEnd(7)} ${q.aspectRatio.padEnd(4)} | ${q.theme.padEnd(15)}] ${q.quote}`,
  );
}
if (quotes.length > 6) console.log(`  …and ${quotes.length - 6} more`);
