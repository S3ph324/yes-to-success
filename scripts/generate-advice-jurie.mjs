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

// ── Shared craft rules ──────────────────────────────────────────────────────
// These encode PROVEN content-creator patterns (hook-retain-reward, ruthless
// concision, authentic first-person insight) — rendered 100% as Jurie's OWN
// warm, DIRECT Taglish voice. She is transparent that deep guidance has value
// (no "free tips / secret hack" bait). We never name, quote, tag, or imitate
// any outside person/guru in the output; only the underlying craft is borrowed.
const CRAFT = `
COPY CRAFT — the "DAILY BUILDER" format (the studied Facebook page style),
written entirely in JURIE'S warm Taglish voice.
HARD RULE: never name, quote, tag, @-mention, or reference any outside person,
brand, author, or guru. Every line is Jurie's own. No attributions.

THE SIGNATURE MOVES (use them — this is the style to copy):
- HOOK LEADS, and it's the biggest line. Rotate the hook formula across the
  batch:
    1. Number + hard promise — "3 gawain na dapat mo nang itigil ngayon."
    2. Command opener — "Ilista ang 5 paulit-ulit mong ginagawa araw-araw."
    3. Aphorism — "Ang busy ay hindi katumbas ng kita."
    4. Contrarian split (the "most people" foil) — "Karamihan, gustong lumago.
       Iilan lang ang handang magbago ng sistema."
    5. Confession / proof — "Ito ang routine na nagbawas ng 10 oras ko kada linggo:"
- "MOST PEOPLE" FOIL, but EMPATHETIC. Cast the HARD WAY of working as the foil,
  never the reader as tamad/tanga/behind. "Karamihan, X — pero may mas madaling
  paraan." The enemy is the grind, not the person.
- CONCRETE > ABSTRACT. Real numbers and actions beat adjectives
  ("i-automate ang 3 follow-ups", "30 minuto kada umaga", "1 tool, 1 task").
- REPETITION-THEN-TURN. Stack parallel lines, then flip:
  "Hindi kapag may oras. Hindi kapag pagod. Kapag may sistema — kahit puyat."
- PAYOFF = a quotable MANTRA. End on ONE short reframe they'd screenshot/save.
- BREVITY. One idea per line. "Walang masyadong mahaba, meron lang masyadong
  boring." White space is the design — never a paragraph block.
- IDENTITY framing. Not just "gawin mo 'to" — "ito ang ginagawa ng umaangat."
  The reader self-selects into the worldview.
- Topic stays in Jurie's lane: AI + systems for Filipino business owners.
- AUTHENTIC & FIRST-PERSON. Write from Jurie's real experience, observations,
  and realizations ("ito ang natutunan ko, ito ang nakita ko"), not a copied
  guru act. Direct — no paligoy-ligoy.
- TRANSPARENT VALUE, NOT FREE-BAIT. Never frame it as "FREE TIPS/VALUE/SECRET"
  or a "secret hack", and never pretend to hand over a whole system in one post.
  Give REAL awareness, insight, and direction (the WHAT and the WHY, plus a
  concrete starting point) — that is genuinely valuable. Be honest that the deep
  implementation/guidance has a price; OCCASIONALLY (not every post) say so
  plainly, never salesy. "Ang libre ay simula; may lalim pa na may halaga."
  Never claim "lahat ng libre walang silbi."
- EMPATHY, NEVER SHAME. No fake guarantees, no "get rich quick."
${bannedLine}`;

let schemaProps, schemaRequired, formatNote;
if (FORMAT === "tweet") {
  formatNote = `
FORMAT — X/TWITTER POST in the DAILY-BUILDER style, 100% JURIE'S OWN voice
(@learnwithjurie always the poster). NEVER quote, name, tag, @-mention, or
reference anyone. Rotate the post shape across the batch:
   • Contrarian split (the "most people" foil) — "Karamihan, X. Iilan lang, Y."
   • List-in-a-tweet — "3 bagay na pwede mo nang i-automate:" + 2–3 tight lines.
   • Aphorism — one quotable mantra line.
   • System reveal — "Ito ang routine ko:" + 2–3 dash lines.
   • Reframe — flip an excuse into agency.
- tweetBody: 2–4 short lines, blank line between beats, ≤ ~260 chars. Lead with
  the hook, give ONE concrete takeaway (real numbers/actions), end on a mantra.
  You MAY use repetition-then-turn. No hashtags, links, @mentions, attributions,
  or quotation-mark quotes.
- caption: a longer Facebook caption in Jurie's voice (see CAPTION).`;
  schemaProps = { tweetBody: { type: Type.STRING }, caption: { type: Type.STRING }, theme: { type: Type.STRING } };
  schemaRequired = ["tweetBody", "caption"];
} else {
  formatNote = `
FORMAT — DAILY-BUILDER ADVICE CARD, 100% in JURIE'S OWN voice. NEVER quote,
name, tag, or reference anyone. Structure, top → bottom:
- hook: THE HERO — the biggest line, read first. Use one of the hook formulas
  above and ROTATE them across the batch. 5–11 words. The scroll-stopper.
- lines: 3–5 concrete points beneath it (each ≤8 words, no ellipsis). Each gives
  real INSIGHT / AWARENESS / DIRECTION — the what and the why, or a concrete
  starting point (not the entire step-by-step system). You MAY run the
  repetition-then-turn rhythm across these lines. (Square shows the first 3;
  taller 4:5 / 9:16 posters show more.)
- payoff: the closing MANTRA — one short quotable reframe they'd save. Jurie's
  own words, 4–12 words.
- caption: the Facebook caption (see CAPTION).

Rotate the post TYPE across the batch (like the page does): single-habit card,
system reveal ("ito ang routine ko:"), contrarian split, aphorism, roadmap/
challenge, or reframe (flip an excuse into agency).`;
  schemaProps = {
    hook: { type: Type.STRING },
    lines: { type: Type.ARRAY, items: { type: Type.STRING } },
    payoff: { type: Type.STRING },
    caption: { type: Type.STRING },
    theme: { type: Type.STRING },
  };
  schemaRequired = ["hook", "lines", "payoff", "caption"];
}

const CAPTION_RULES = `
CAPTION (Facebook) — improved with the studied formulas:
- Open with a HOOK in the first line (a question, a relatable scene, or a
  confession) — never a description. This is what stops the scroll.
- Then 2–4 short lines or a tiny dash list that delivers real insight/direction
  in Jurie's first-person voice (awareness + the why + a starting point — not
  the whole system).
- Close on the same quotable payoff as the card, then ONE soft CTA
  (e.g. "Comment 'AI' para ituro ko kung saan magsisimula."). No fake
  guarantees. OCCASIONALLY (not every caption) be transparent that the deeper
  implementation/guidance is paid — naturally, never salesy.
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
    // Jurie is always the poster; the body itself may quote a prominent figure.
    e.tweetBody = p.tweetBody.trim();
    e.quote = e.tweetBody.split("\n")[0];
  } else {
    if (typeof p.hook !== "string" || !p.hook.trim()) continue;
    e.hook = p.hook.trim();
    e.lines = (Array.isArray(p.lines) ? p.lines : []).map((l) => String(l).trim()).filter(Boolean).slice(0, 5);
    e.payoff = (p.payoff || "").trim();
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
