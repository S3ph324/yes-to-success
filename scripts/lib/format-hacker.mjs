// Format Hacker — deconstruct a viral ad / post and adapt it into client-voiced
// video storyboards. Reuses the same Vertex/Gemini setup as the rest of the
// pipeline (broll-analyze.mjs). Multimodal: accepts a screenshot (inline image),
// scraped URL text, or an auto-discovered "ads breakdown" transcript.
//
// Exported: hackFormat({ client, method, imageBase64, mimeType, url })
//   → { blueprint:{visualStrategy,copywritingFormula,whyItWorked},
//       adaptedStoryboards:[ {title,hook,scenes:[{cameraAction,onScreenText,voiceover}]} ] }
//
// Throws Error(message) on failure — the dashboard route turns it into a JSON
// error, so the server never crashes on a bad link / blocked scrape / bad model
// output.

import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot } from "./client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const scriptsDir = path.join(projectRoot, "scripts");

// Per-client adaptation clause appended to the director system instruction.
const CLIENT_CLAUSE = {
  jurie:
    "ADAPT FOR THE CLIENT — JURIE:\n" +
    "Rebuild the format as a Taglish (natural Tagalog + English) mentorship / " +
    "business short-video storyboard in Jurie's voice for Filipino MSME owners, " +
    "freelancers and side-hustlers. Warm, never shaming — validate effort, then " +
    "reframe. BRAND SAFETY (hard rule): NEVER name, quote, tag, @-mention or " +
    "reference any real person, brand or creator in the output — every line ships " +
    "as Jurie's own words. Borrow the format's structure and psychology, not any " +
    "names.",
  tranzzie:
    "ADAPT FOR THE CLIENT — TRANZZIE EYEGLASSES:\n" +
    "Rebuild the format as a visually engaging e-commerce short-video storyboard " +
    "for Tranzzie, an eyewear brand. Lean into eye-strain / blue-light relief, " +
    "photochromic transition lenses, all-day comfort, and style. Keep it " +
    "aspirational and product-forward; on-screen text and voiceover should sell " +
    "the frames without over-claiming medical benefits.",
};

const CLIENT_NICHE = {
  jurie:
    "AI & business mentorship for Filipino MSME owners / freelancers / side-hustlers (Taglish)",
  tranzzie:
    "eyewear e-commerce (blue-light / eye-strain relief, photochromic transition lenses, style)",
};

// ── response schema (mirrors the user-facing contract) ──────────────────────
const sceneObj = {
  type: Type.OBJECT,
  properties: {
    cameraAction: { type: Type.STRING },
    onScreenText: { type: Type.STRING },
    voiceover: { type: Type.STRING },
  },
  required: ["cameraAction", "onScreenText", "voiceover"],
};
const storyboardObj = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    hook: { type: Type.STRING },
    scenes: { type: Type.ARRAY, items: sceneObj },
  },
  required: ["title", "hook", "scenes"],
};
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    blueprint: {
      type: Type.OBJECT,
      properties: {
        visualStrategy: { type: Type.STRING },
        copywritingFormula: { type: Type.STRING },
        whyItWorked: { type: Type.STRING },
      },
      required: ["visualStrategy", "copywritingFormula", "whyItWorked"],
    },
    adaptedStoryboards: { type: Type.ARRAY, items: storyboardObj },
  },
  required: ["blueprint", "adaptedStoryboards"],
};

const loadText = async (p) => {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return "";
  }
};

// fetch with a hard timeout so a hung proxy / scrape never wedges the request.
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Method B — pull readable text off a pasted link via the Jina reader proxy
// (no headless browser needed; works around most anti-bot walls for public
// pages). Social login-walls may return little — that is fine, Gemini adapts.
async function extractFromUrl(url) {
  let r;
  try {
    r = await fetchWithTimeout("https://r.jina.ai/" + url, {
      headers: { Accept: "text/plain" },
    });
  } catch {
    throw new Error(
      "Could not reach that link. Try a screenshot of the ad instead.",
    );
  }
  if (!r.ok)
    throw new Error(
      "Could not read that link (status " +
        r.status +
        "). Try a screenshot of the ad instead.",
    );
  const txt = (await r.text()).slice(0, 12000).trim();
  if (!txt)
    throw new Error(
      "That link returned no readable text. Try a screenshot of the ad instead.",
    );
  return txt;
}

// Method C — auto-discover a "winning ads breakdown" video and pull its
// transcript. yt-search + youtube-transcript are dynamic-imported and fully
// guarded: if the modules are missing, YouTube blocks the datacenter IP, or no
// transcript is available, we return fellBack:true and let Gemini synthesize a
// proven format from knowledge instead of hard-failing.
async function extractAuto() {
  const queries = [
    "winning facebook ads breakdown marketing",
    "best tiktok ads strategy breakdown",
    "viral ad breakdown copywriting",
  ];
  try {
    const [ytMod, txMod] = await Promise.all([
      import("yt-search"),
      import("youtube-transcript"),
    ]);
    const ytSearch = ytMod.default || ytMod;
    const YoutubeTranscript =
      txMod.YoutubeTranscript || txMod.default || txMod;
    for (const q of queries) {
      let vids = [];
      try {
        const r = await ytSearch(q);
        vids = ((r && r.videos) || []).slice(0, 5);
      } catch {
        continue;
      }
      for (const v of vids) {
        try {
          const parts = await YoutubeTranscript.fetchTranscript(v.videoId);
          const text = parts
            .map((p) => p.text)
            .join(" ")
            .slice(0, 12000)
            .trim();
          if (text.length > 200) {
            return {
              text:
                'BREAKDOWN VIDEO: "' +
                (v.title || "") +
                '"\n\nTRANSCRIPT:\n' +
                text,
              fellBack: false,
            };
          }
        } catch {
          /* no transcript for this one — try the next */
        }
      }
    }
  } catch {
    /* modules absent or search unavailable — fall through to synthesis */
  }
  return { text: "", fellBack: true };
}

export async function hackFormat({ client, method, imageBase64, mimeType, url }) {
  client = client === "tranzzie" ? "tranzzie" : "jurie";
  const director = await loadText(path.join(scriptsDir, "hack-director.md"));
  const voice = await loadText(
    path.join(scriptsDir, "voice-profile-" + client + ".md"),
  );

  // Resolve the source into either an inline image part or extracted text.
  let imagePart = null;
  let sourceText = "";
  let synthesize = false;

  if (method === "image") {
    const data = String(imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
    if (data.length < 32) throw new Error("No screenshot was provided.");
    imagePart = { inlineData: { mimeType: mimeType || "image/png", data } };
  } else if (method === "url") {
    sourceText = await extractFromUrl(url);
  } else if (method === "auto") {
    const a = await extractAuto();
    sourceText = a.text;
    synthesize = a.fellBack;
  } else {
    throw new Error("Unknown input method.");
  }

  const systemInstruction =
    director +
    "\n\n---\n\n" +
    (CLIENT_CLAUSE[client] || CLIENT_CLAUSE.jurie) +
    "\n\nClient niche: " +
    (CLIENT_NICHE[client] || "") +
    "\n\n## CLIENT VOICE PROFILE (write the voiceover + on-screen text in THIS voice)\n\n" +
    (voice || "(voice profile unavailable — infer a natural brand voice.)");

  let userParts;
  if (imagePart) {
    userParts = [
      imagePart,
      {
        text:
          "Deconstruct the viral ad/post in THIS screenshot (visual format + " +
          "copywriting formula), then adapt it into 2 storyboards for the client " +
          "per the system instruction. Output the JSON object only.",
      },
    ];
  } else if (sourceText) {
    userParts = [
      {
        text:
          "VIRAL SOURCE (extracted text):\n\n" +
          sourceText +
          "\n\n---\n\nDeconstruct this content (visual format + copywriting " +
          "formula), then adapt it into 2 storyboards for the client per the " +
          "system instruction. Output the JSON object only.",
      },
    ];
  } else {
    // Auto-discover fell back — no source text available.
    userParts = [
      {
        text:
          "No source could be fetched. SYNTHESIZE FROM KNOWLEDGE: pick a proven, " +
          "high-performing short-form ad/content format for the client's niche, " +
          "describe that format as the blueprint (visual + copywriting), then " +
          "adapt it into 2 storyboards per the system instruction. Output the " +
          "JSON object only.",
      },
    ];
  }

  const ai = new GoogleGenAI({ vertexai: true, project, location });
  let resp;
  try {
    resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: userParts }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.85,
      },
    });
  } catch (e) {
    throw new Error("The AI request failed: " + (e?.message || e));
  }

  let out;
  try {
    out = JSON.parse(resp.text);
  } catch {
    throw new Error("The AI returned an unreadable response — please try again.");
  }

  // Defensive coercion so the frontend can always render.
  const bp = out?.blueprint || {};
  const blueprint = {
    visualStrategy: String(bp.visualStrategy || ""),
    copywritingFormula: String(bp.copywritingFormula || ""),
    whyItWorked: String(bp.whyItWorked || ""),
  };
  let boards = Array.isArray(out?.adaptedStoryboards)
    ? out.adaptedStoryboards
    : [];
  boards = boards.slice(0, 2).map((b) => ({
    title: String(b?.title || "Untitled concept"),
    hook: String(b?.hook || ""),
    scenes: (Array.isArray(b?.scenes) ? b.scenes : []).map((s) => ({
      cameraAction: String(s?.cameraAction || ""),
      onScreenText: String(s?.onScreenText || ""),
      voiceover: String(s?.voiceover || ""),
    })),
  }));
  if (boards.length === 0)
    throw new Error("The AI did not return any storyboards — please try again.");

  return { blueprint, adaptedStoryboards: boards, synthesized: synthesize };
}
