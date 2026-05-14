#!/usr/bin/env node
// Re-generate JUST the caption field for specified entries in a quotes JSON.
// Leaves quote text + images untouched.
//
// Usage:
//   GOOGLE_CLOUD_PROJECT=... node scripts/regenerate-captions.mjs <quotes.json> <idx1,idx2,...>
//
// Example:
//   node scripts/regenerate-captions.mjs out/quotes-2026-05-11T11-02.json 0,2,4

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
if (!project) {
  console.error("Missing GOOGLE_CLOUD_PROJECT env var");
  process.exit(1);
}

const quotesArg = process.argv[2];
const idxArg = process.argv[3];
if (!quotesArg || !idxArg) {
  console.error(
    "Usage: node scripts/regenerate-captions.mjs <quotes.json> <idx1,idx2,...>",
  );
  process.exit(1);
}

const quotesPath = path.isAbsolute(quotesArg)
  ? quotesArg
  : path.join(process.cwd(), quotesArg);
const quotes = JSON.parse(await fs.readFile(quotesPath, "utf-8"));
const indices = idxArg.split(",").map((n) => parseInt(n.trim(), 10));

const voiceProfile = await fs.readFile(
  path.join(__dirname, "voice-profile.md"),
  "utf-8",
);

// Pull active brief for the campaign / brand context
const briefId = process.env.DASHBOARD_BRIEF_ID || "";
let activeBrief = null;
try {
  const briefs = JSON.parse(
    await fs.readFile(path.join(projectRoot, "config", "briefs.json"), "utf-8"),
  );
  activeBrief = briefs.find((b) => b.id === briefId) || briefs[0] || null;
} catch {
  /* ignore */
}

const briefOverrides = activeBrief
  ? `\nActive brief: ${activeBrief.name}\n` +
    (activeBrief.voiceNotes
      ? `Voice notes: ${activeBrief.voiceNotes}\n`
      : "") +
    (activeBrief.activeCampaigns
      ? `Active campaigns: ${activeBrief.activeCampaigns}\n`
      : "")
  : "";

const systemInstruction = `${voiceProfile}${briefOverrides}

You are regenerating ONLY the Facebook caption for a batch of John Calub
quote-card posts. The quotes (rendered on the images) are already set.

For each entry, write a fresh, *better* caption following the FB caption
style rules above. **VARY length, opening style, and engagement type across
the batch** — this is the most important rule. Do not produce uniform
captions; mix short/medium/long and rotate opener types.

End every caption on its own line with:

— John Calub, Philippines' #1 Success Coach

Output ONLY a JSON array. Each element is an object with one field: { "caption": "..." }
in the same order as the input quotes.`;

const items = indices
  .filter((i) => quotes[i])
  .map((i) => ({
    quote: quotes[i].quote,
    theme: quotes[i].theme || "mindset",
    variant: quotes[i].variant || "classic",
  }));

const userPrompt = `Regenerate captions for these ${items.length} quote-card entries.
Vary length, opening, and engagement type. No duplicates.

${items
  .map(
    (q, i) =>
      `${i + 1}. [${q.theme} / ${q.variant}]\n   Quote on image: "${q.quote}"`,
  )
  .join("\n\n")}

Output a JSON array of ${items.length} caption objects in order.`;

const ai = new GoogleGenAI({ vertexai: true, project, location });
console.log(`Regenerating ${items.length} caption(s) via Gemini 2.5 Flash…`);

const resp = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: userPrompt,
  config: {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { caption: { type: Type.STRING } },
        required: ["caption"],
      },
    },
    temperature: 1.0,
  },
});

const text = resp.text;
const captions = JSON.parse(text);
if (!Array.isArray(captions) || captions.length !== items.length) {
  console.error("Got bad response:", text);
  process.exit(1);
}

const validIndices = indices.filter((i) => quotes[i]);
validIndices.forEach((idx, i) => {
  quotes[idx].caption = captions[i].caption;
});

await fs.writeFile(quotesPath, JSON.stringify(quotes, null, 2));
console.log(`\n✓ Updated ${validIndices.length} caption(s) in ${quotesPath}`);
console.log("\nNew captions:");
validIndices.forEach((idx, i) => {
  console.log(`\n[${idx + 1}] ${captions[i].caption}`);
});
