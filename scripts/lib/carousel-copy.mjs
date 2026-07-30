// Carousel copy generation for Jurie.
//
// Runs as a direct Gemini call (like /api/brandcard/taglines), NOT a spawned
// render job, so the dashboard can show the copy for approval in seconds and
// the user edits it BEFORE any image credits are spent. Image generation is
// the expensive half; writing is nearly free, so approve-then-render is both
// cheaper and produces better carousels.

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

export const CAROUSEL_ENGINES = ["framework", "question", "take"];

// What actually feeds a carousel. Deliberately NOT the source video's "daily
// AI news repost" model — that would collide with two of Jurie's brand rules
// (never name or quote anyone, and don't perform someone else's act).
const ENGINE_BRIEF = {
  framework:
    "ENGINE: FRAMEWORK. Teach one concrete thing Jurie actually does, broken " +
    "into numbered steps. Evergreen, not news. Each slide is one step that " +
    "stands on its own and is genuinely useful even if the reader stops there.",
  question:
    "ENGINE: AUDIENCE QUESTION. The topic is a real question from her audience. " +
    "Slide 1 is the question as the hook; the rest is her direct, honest answer " +
    "from her own experience, including the parts most people leave out.",
  take:
    "ENGINE: HER TAKE. The topic is something happening in AI or business. " +
    "Do NOT report it like news and do NOT name any company, product, person or " +
    "account. Refer to it generically ('may bagong tool', 'may lumabas na update'). " +
    "The value is her interpretation: what it actually means for a small business " +
    "owner, and what she would do about it.",
};

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    coverHeadline: { type: Type.STRING },
    slides: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          headline: { type: Type.STRING },
          body: { type: Type.STRING },
        },
        required: ["headline", "body"],
      },
    },
    cta: {
      type: Type.OBJECT,
      properties: {
        kicker: { type: Type.STRING },
        headline: { type: Type.STRING },
        body: { type: Type.STRING },
      },
      required: ["kicker", "headline", "body"],
    },
    caption: { type: Type.STRING },
  },
  required: ["coverHeadline", "slides", "cta", "caption"],
};

const RULES =
  "HARD RULES, these override everything else:\n" +
  "- Taglish, the way she actually talks. Natural code-switching, not translated English.\n" +
  "- First person. Her own experience and observations: 'ito ang ginagawa ko', " +
  "'ito ang natutunan ko'. Never instruct from above.\n" +
  "- NEVER name, quote, tag or reference any person, brand, company, product or " +
  "account. No exceptions, not even well-known ones.\n" +
  "- NO free-bait. Never write 'FREE', 'libre', 'secret', 'hack', 'trick', or " +
  "promise a whole system in one post. She respects that knowledge has value.\n" +
  "- Never shame the reader for how they work now. Validate the effort, then " +
  "offer the sharper way.\n" +
  "- Direct. No paligoy-ligoy, no hype, no fake urgency.\n";

const LENGTHS =
  "LENGTH RULES, these are strict because the text is rendered into fixed slide " +
  "layouts and overflow breaks the design:\n" +
  "- coverHeadline: max 46 characters. It is set in huge condensed capitals and " +
  "is the entire hook. Punchy and concrete.\n" +
  "- slides[].headline: max 34 characters.\n" +
  "- slides[].body: 2 to 3 short sentences, max 165 characters total. Always end on a complete sentence.\n" +
  "- cta.kicker: max 26 characters. cta.headline: max 32. cta.body: max 95.\n" +
  "- caption: 2 to 4 sentences for the Instagram caption, then 4 to 6 relevant " +
  "hashtags on their own final line.\n";

/**
 * @param {object} o
 * @param {string} o.engine    one of CAROUSEL_ENGINES
 * @param {string} o.topic     topic / question / thing-that-happened
 * @param {number} o.slideCount total slides INCLUDING cover and CTA
 * @param {string[]} o.recentTopics  topic ledger, to avoid repeating himself
 * @returns {Promise<object>} approved-copy shape
 */
export async function generateCarouselCopy({
  engine = "framework",
  topic = "",
  slideCount = 6,
  recentTopics = [],
  projectRoot,
  gcpProject,
  gcpLocation = "us-central1",
}) {
  if (!gcpProject) throw new Error("No GOOGLE_CLOUD_PROJECT configured for copy generation.");
  const eng = CAROUSEL_ENGINES.includes(engine) ? engine : "framework";
  // cover + teaching slides + CTA
  const teaching = Math.max(1, Math.min(8, Number(slideCount) - 2));

  const voice = await fs
    .readFile(path.join(projectRoot, "scripts", "voice-profile-jurie.md"), "utf-8")
    .catch(() => "");

  const dedupe = recentTopics.length
    ? "\nSHE HAS ALREADY POSTED THESE RECENTLY — pick a genuinely different angle, " +
      "do not rehash them:\n" + recentTopics.slice(0, 40).map((t) => "- " + t).join("\n") + "\n"
    : "";

  const ai = new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation });
  const resp = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text:
      "Write the copy for one Instagram carousel by Jurie.\n\n" +
      ENGINE_BRIEF[eng] + "\n\n" +
      "TOPIC: " + (topic || "(choose a strong one from her usual subject matter)") + "\n\n" +
      "STRUCTURE: a cover headline, exactly " + teaching + " teaching slides, and a " +
      "closing call-to-action slide that invites a real conversation in the comments " +
      "(never a keyword-comment bait like 'comment MENTOR').\n\n" +
      RULES + "\n" + LENGTHS + dedupe }] }],
    config: {
      systemInstruction: voice || "You write for Jurie, a Filipina AI and business mentor.",
      responseMimeType: "application/json",
      responseSchema: SCHEMA,
      temperature: 0.9,
    },
  });

  let parsed = null;
  try { parsed = JSON.parse(resp.text || "null"); } catch { parsed = null; }
  if (!parsed || !parsed.coverHeadline || !Array.isArray(parsed.slides) || !parsed.slides.length) {
    throw new Error("The model did not return usable carousel copy — try again.");
  }

  // Trim to the layout budgets. The renderer cannot reflow, so anything longer
  // overruns its slide — but a naive .slice() amputates mid-word ("MAKAKATULO"
  // out of "MAKAKATULONG"), so back off to a clean boundary instead.
  const clip = (s, n) => {
    const t = String(s || "").trim().replace(/\s+/g, " ");
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const sp = cut.lastIndexOf(" ");
    return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:\-\u2013\u2014]+$/, "").trim();
  };
  // Body copy reads as prose, so drop to the last COMPLETE sentence rather
  // than leaving a dangling clause.
  const clipBody = (s, n) => {
    const t = String(s || "").trim().replace(/\s+/g, " ");
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (stop > n * 0.45) return cut.slice(0, stop + 1).trim();
    return clip(t, n);
  };
  return {
    engine: eng,
    topic: clip(topic, 160),
    coverHeadline: clip(parsed.coverHeadline, 46),
    slides: parsed.slides.slice(0, teaching).map((s, i) => ({
      n: i + 1,
      headline: clip(s.headline, 34),
      body: clipBody(s.body, 210),
    })),
    cta: {
      kicker: clip(parsed.cta?.kicker, 30),
      headline: clip(parsed.cta?.headline, 34),
      body: clipBody(parsed.cta?.body, 110),
    },
    caption: String(parsed.caption || "").trim().slice(0, 900),
  };
}
