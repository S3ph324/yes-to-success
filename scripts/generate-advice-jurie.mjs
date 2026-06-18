#!/usr/bin/env node
// Advice-poster generator (Jurie) via Vertex AI (Gemini).
//
// Produces ADVICE content in the studied "daily builder" format — a hook, a
// short actionable list, and a quotable payoff — OR a single X/Twitter-style
// advice post. Adapted to Jurie's empathetic Taglish AI/business-mentor voice:
// validate the audience's effort, never shame, practical not hypey.
//
// Output entries carry `variant` ("advice" | "tweet") so render-batch routes
// them to AdviceCard / TweetCard. Each entry also has an improved FB `caption`
// built from the learned copy formulas.
//
// Env (set by the dashboard /api/generate handler):
//   DASHBOARD_ADVICE_FORMAT   "advice" | "tweet"   (default "advice")
//   DASHBOARD_ADVICE_SERIES   series label for the footer (e.g. "Working Smart")
//   DASHBOARD_ADVICE_DAYSTART starting day number for the series counter
//   CLIENT_TOPIC              optional single topic/angle
//
// Output: out/<client>-quotes-YYYY-MM-DDTHH-mm.json (same prefix as the quote
// pipeline so batch-jurie.mjs locates it identically).

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot, resolveClient, takeClientArg } from "./lib/client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

process.on("unhandledRejection", (r) => { console.error("[advice-gen] unhandledRejection:", r?.stack || r?.message || String(r)); process.exit(1); });
process.on("uncaughtException", (e) => { console.error("[advice-gen] uncaughtException:", e?.stack || e?.message || String(e)); process.exit(1); });

const { client: clientArg, rest } = takeClientArg(process.argv.slice(2));
const client = await resolveClient(clientArg || "jurie");

const COUNT = Math.max(1, Math.min(50, parseInt(rest[0] || "8", 10)));
const TOPIC = process.env.CLIENT_TOPIC || process.env.JURIE_TOPIC || rest.slice(1).join(" ").trim();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FORMAT = process.env.DASHBOARD_ADVICE_FORMAT === "tweet" ? "tweet" : "advice";
const SERIES = (process.env.DASHBOARD_ADVICE_SERIES || "Working Smart").trim().slice(0, 28);
// Card theme is user-chosen (default dark) — not left to the model, which used
// to randomly emit light/white cards.
const THEME = process.env.DASHBOARD_ADVICE_THEME === "light" ? "light" : "dark";
const DAY_START = Math.max(0, parseInt(process.env.DASHBOARD_ADVICE_DAYSTART || "1", 10) || 1);

const voiceProfile = await fs.readFile(client.voiceProfilePath, "utf-8").catch(() => "");

// Brief (topics + banned phrases).
const briefId = process.env.DASHBOARD_BRIEF_ID || client.briefId;
let brief = null;
try {
  const PERSIST = process.env.PERSIST_BASE || projectRoot;
  const briefs = JSON.parse(await fs.readFile(path.join(PERSIST, "config", "briefs.json"), "utf-8").catch(() =>
    fs.readFile(path.join(projectRoot, "config", "briefs.json"), "utf-8")));
  brief = briefs.find((b) => b.id === briefId) || briefs.find((b) => b.client === client.id) || null;
} catch { /* defaults */ }

const topicsLine = TOPIC
  ? `\n**SINGLE ANGLE — every post is about:** "${TOPIC}"\n`
  : brief?.topics?.length
    ? `\n**Rotate across these topics so the batch feels varied:**\n${brief.topics.map((t) => `- ${t}`).join("\n")}\n`
    : "";
const bannedLine = brief?.bannedPhrases?.length
  ? `\nNEVER use these phrases or anything in their spirit (they shame the audience): ${brief.bannedPhrases.map((p) => `"${p}"`).join(", ")}.\n`
  : "";

// ── Shared craft rules (the learned format, adapted to Jurie's warm voice) ──
const CRAFT = `
COPY CRAFT — the "daily builder" format, in Jurie's voice:
- BREVITY: cut every word that isn't load-bearing. One idea per line.
- HOOK: name a relatable daily-grind pain or limiting belief the business
  owner FEELS (gabi-gabing overtime, takot sa AI, "wala akong oras"). Make
  them think "ako 'to." 6–11 words. Taglish, conversational.
- EMPATHY, NOT SHAME: validate their effort first. Never imply they're lazy,
  tanga, or behind. The enemy is the hard way of working — not the person.
- CONCRETE > ABSTRACT: real actions and small numbers beat adjectives
  ("i-automate ang 3 paulit-ulit na gawain", "30 minuto kada umaga"). No
  fake guarantees, no "get rich quick", no hype.
- PAYOFF: end on ONE quotable Taglish line they'd want to share — a reframe
  toward working smart with AI. Not a summary; a mic-drop.
- Taglish that a real Filipino mentor would post. Read it back — if it sounds
  broken or like a forced slogan, rewrite it.
${bannedLine}`;

let schemaProps, schemaRequired, formatNote;
if (FORMAT === "tweet") {
  formatNote = `
FORMAT — X/TWITTER POST "SCREENSHOT". MIX the batch:
- About HALF the posts are in JURIE'S own Taglish mentor voice
  (authorName: "Jurie", authorHandle: "@learnwithjurie").
- The OTHER half are a genuine insight from a PROMINENT ENTREPRENEUR / SALES /
  MARKETING / WEALTH figure, written in THAT person's voice (English), with
  their real name + handle. Use these (name → handle):
    Alex Hormozi → @AlexHormozi
    Gary Vaynerchuk → @garyvee
    Naval Ravikant → @naval
    Grant Cardone → @GrantCardone
    Russell Brunson → @russellbrunson
    Robert Kiyosaki → @theRealKiyosaki
    Jordan Belfort → @wolfofwallst
    Tony Robbins → @tonyrobbins
    Sam Altman → @sama
  Vary which figure across the batch; pick one whose topic fits the post.
- tweetBody: ONE short post (2–4 short lines, blank line between beats), under
  ~240 chars, no hashtags/links. For a figure it MUST be their AUTHENTIC,
  widely-documented idea — faithfully paraphrased — NEVER an invented claim,
  fake stat, or words they're not actually known for.
- authorName / authorHandle: the poster (Jurie + "@learnwithjurie", or the
  figure + their handle above).
- caption: a longer Facebook caption (see CAPTION). When the post is a figure's,
  the caption is JURIE reacting to / building on that insight in her voice.`;
  schemaProps = {
    tweetBody: { type: Type.STRING },
    authorName: { type: Type.STRING },
    authorHandle: { type: Type.STRING },
    caption: { type: Type.STRING },
    theme: { type: Type.STRING },
  };
  schemaRequired = ["tweetBody", "authorName", "authorHandle", "caption"];
} else {
  formatNote = `
FORMAT — QUOTE-LED ADVICE CARD. The QUOTE is the hero (shown biggest, read
first); Jurie's hook + 3 steps are the supporting "take" beneath it.
- payoff: THE HERO — a SUBSTANTIVE, insightful quote from a well-known
  ENTREPRENEUR / SALES / MARKETING / WEALTH figure whose GENUINE thinking backs
  the advice. It must carry REAL value — a complete idea people would screenshot,
  roughly 14–26 words. NOT a 3–6 word slogan ("Sales solve all problems" is too
  thin). Prefer a quote that teaches or reframes. English.
- authorName: that person's name, e.g. "Alex Hormozi".
- hook: a short relatable line in JURIE'S Taglish voice that bridges the quote
  to the steps (6–10 words).
- lines: 5 short, concrete advice steps in Jurie's voice (each one line,
  ≤8 words, no ellipsis). Each must add its OWN value — no filler or repeats.
  (Square posters show the first 3; taller 4:5 / 9:16 posters show more.)
- caption: the Facebook caption (see CAPTION).

AUTHORITY QUOTE — rules (do this carefully):
- Quote the kind of big names business owners actually follow. Pick whoever
  truly fits THIS post (vary across the batch):
    • Offers / scaling a business → Alex Hormozi, Dan Martell, Tony Robbins
    • Sales / persuasion / closing → Jordan Belfort, Grant Cardone, Alex Hormozi
    • Marketing / funnels / attention → Russell Brunson, Gary Vaynerchuk, Seth Godin
    • Money / wealth / assets → Robert Kiyosaki, Naval Ravikant, Warren Buffett
    • Consistency / patience / volume → Gary Vaynerchuk, Alex Hormozi
    • Leverage / AI / building → Naval Ravikant, Sam Altman
- Do NOT use productivity authors like James Clear or Cal Newport — the
  audience wants business/sales/wealth voices, not "habits" authors.
- Use their AUTHENTIC idea/principle. Paraphrase faithfully if unsure of exact
  wording — but NEVER invent fake statistics, fake verbatim quotes, or put
  words in their mouth they're not genuinely known for.
- The quote must REINFORCE the advice, never contradict it.`;
  schemaProps = {
    hook: { type: Type.STRING },
    lines: { type: Type.ARRAY, items: { type: Type.STRING } },
    payoff: { type: Type.STRING },
    authorName: { type: Type.STRING },
    caption: { type: Type.STRING },
    theme: { type: Type.STRING },
  };
  schemaRequired = ["hook", "lines", "payoff", "authorName", "caption"];
}

const CAPTION_RULES = `
CAPTION (Facebook) — improved with the studied formulas:
- Open with a HOOK in the first line (a question, a relatable scene, or a
  confession) — never a description. This is what stops the scroll.
- Then 2–4 short lines or a tiny dash list that delivers the actual value.
- Close on the same quotable payoff as the card, then ONE soft CTA
  (e.g. "Comment 'AI' para ituro ko sa'yo kung paano."). No fake guarantees.
- Conversational Taglish. Short lines, generous breaks — NOT a paragraph wall.`;

const systemInstruction = `${voiceProfile}

You are writing ${COUNT} ${FORMAT === "tweet" ? "single X/Twitter-style advice posts" : "advice cards"} for ${client.label} (${brief?.name || "AI for business owners"}).
${topicsLine}${formatNote}
${CRAFT}
${CAPTION_RULES}

Vary the structure and opening across the batch — no two posts should share a
sentence shape or opening word. Output ONLY a valid JSON array, no markdown.`;

const userPrompt = TOPIC
  ? `Write ${COUNT} ${FORMAT} posts for ${client.label}, all about: "${TOPIC}". Mix Taglish naturally. Vary every opening.`
  : `Write ${COUNT} ${FORMAT} posts for ${client.label}, rotating the brief topics. Mix Taglish naturally. Vary every opening.`;

const ai = new GoogleGenAI({ vertexai: true, project, location });
console.log(`Generating ${COUNT} ${client.label} ${FORMAT} post(s) via Vertex AI (${MODEL})` + (TOPIC ? ` · angle "${TOPIC}"` : "") + `…`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isQuota = (m) => /429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(String(m));
let resp;
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    resp = await ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: schemaProps, required: schemaRequired } },
        temperature: 0.92,
      },
    });
    break;
  } catch (err) {
    const msg = err?.message || String(err);
    if (attempt < 3 && isQuota(msg)) { const w = [15000, 45000][attempt - 1]; console.warn(`[advice-gen] attempt ${attempt} quota — waiting ${w / 1000}s`); await delay(w); }
    else { console.error(`[advice-gen] Vertex error (attempt ${attempt}): ${msg}`); process.exit(1); }
  }
}
if (!resp) { console.error("[advice-gen] no response"); process.exit(1); }

let posts;
try { posts = JSON.parse(resp.text); } catch { console.error("Bad JSON:\n", resp.text); process.exit(1); }
if (!Array.isArray(posts) || !posts.length) { console.error("Empty/non-array response"); process.exit(1); }

// ── Normalise into render-batch entries ────────────────────────────────────
// One generation moment for the whole batch — tweets render this as their
// posted-at timestamp ("exact time it was generated").
const generatedAt = new Date().toISOString();
const clean = [];
for (const p of posts) {
  if (!p || typeof p.caption !== "string" || !p.caption.trim()) continue;
  const e = {
    variant: FORMAT,
    kind: FORMAT,
    aspectRatio: "4:5",
    caption: p.caption.trim(),
    theme: THEME,
    seriesLabel: SERIES,
    dayNumber: DAY_START + clean.length,
    generatedAt,
  };
  if (FORMAT === "tweet") {
    if (typeof p.tweetBody !== "string" || !p.tweetBody.trim()) continue;
    e.tweetBody = p.tweetBody.trim();
    // Tweet author — Jurie or a prominent figure. Default to Jurie.
    e.authorName = (p.authorName || "Jurie").trim();
    let h = (p.authorHandle || "").trim();
    if (h && !h.startsWith("@")) h = "@" + h.replace(/^@+/, "");
    e.authorHandle = h || (/^jurie$/i.test(e.authorName) ? "@learnwithjurie" : "");
    e.quote = e.tweetBody.split("\n")[0];
  } else {
    if (typeof p.hook !== "string" || !p.hook.trim()) continue;
    e.hook = p.hook.trim();
    e.lines = (Array.isArray(p.lines) ? p.lines : []).map((l) => String(l).trim()).filter(Boolean).slice(0, 5);
    e.payoff = (p.payoff || "").trim();
    e.authorName = (p.authorName || "").trim();
    e.quote = e.hook;
    if (!e.lines.length) continue;
  }
  clean.push(e);
}
if (!clean.length) { console.error("All entries failed validation."); process.exit(1); }

const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outPath = path.join(outDir, `${client.quotePrefix}-${stamp}.json`);
await fs.writeFile(outPath, JSON.stringify(clean, null, 2));

console.log(`\n✓ ${clean.length} ${client.label} ${FORMAT} post(s)\n  → ${outPath}\n`);
for (const e of clean.slice(0, 6)) console.log(`  • ${(e.hook || e.tweetBody || "").slice(0, 60)}`);
