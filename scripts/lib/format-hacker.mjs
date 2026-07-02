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
    "reframe. VOICE: authentic and FIRST-PERSON, from Jurie's real experience and " +
    "observations ('ito ang natutunan ko, ito ang nakita ko'); direct, no " +
    "paligoy-ligoy. NO free-bait or fake 'secret hack' framing, and do NOT pretend " +
    "to hand over a whole system in one video — give real awareness, insight and " +
    "direction, and be transparent that the deep implementation/guidance has value " +
    "(one concept MAY be explicit that it is paid — naturally, never salesy). Rotate " +
    "BOTH angles across the 2 concepts: a classic pain->AI reframe AND a first-person " +
    "realization. BRAND SAFETY (hard rule): NEVER name, quote, tag, @-mention or " +
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
// One shot in a storyboard. Kept shoot-ready: a shot type + rough duration, the
// literal on-screen caption, the ACTUAL spoken voiceover, concrete camera
// direction, and an optional b-roll cutaway idea.
const sceneObj = {
  type: Type.OBJECT,
  properties: {
    shot: { type: Type.STRING }, // Close-up / Medium / Wide / Screen-rec / POV / B-roll / Text card
    duration: { type: Type.STRING }, // rough length, e.g. "3s"
    onScreenText: { type: Type.STRING }, // literal caption/overlay for this beat
    voiceover: { type: Type.STRING }, // the exact words spoken (real lines, not a description)
    cameraAction: { type: Type.STRING }, // concrete framing / movement / subject action / setting
    bRoll: { type: Type.STRING }, // optional cutaway idea ("" if none)
  },
  required: ["shot", "onScreenText", "voiceover", "cameraAction"],
};
// One adapted concept: the plain-language idea, the hook, the scene list, and a
// ready-to-post caption + hashtags — so a busy creator can skim and shoot.
const storyboardObj = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING }, // short punchy concept name
    contentIdea: { type: Type.STRING }, // one sentence: the angle + who it is for
    hook: { type: Type.STRING }, // first-3-seconds hook line
    scenes: { type: Type.ARRAY, items: sceneObj },
    caption: { type: Type.STRING }, // ready-to-post caption in the client voice
    hashtags: { type: Type.ARRAY, items: { type: Type.STRING } }, // 4-6 relevant tags
  },
  required: ["title", "contentIdea", "hook", "scenes", "caption"],
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
  const raw = await r.text();
  // Capture the FULL post/thread, not just a snippet (was 12k).
  const txt = raw.slice(0, 30000).trim();
  if (!txt)
    throw new Error(
      "That link returned no readable text. Try a screenshot of the ad instead.",
    );
  // Best-effort: pull up to 3 image URLs from the Jina markdown for the UI.
  const images = [];
  const re = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = re.exec(raw)) && images.length < 3) images.push(m[1]);
  return { text: txt, images };
}

// Method C — auto-discover a "winning ads breakdown" video and pull its
// transcript. yt-search + youtube-transcript are dynamic-imported and fully
// guarded: if the modules are missing, YouTube blocks the datacenter IP, or no
// transcript is available, we return fellBack:true and let Gemini synthesize a
// proven format from knowledge instead of hard-failing.
async function extractAuto(topic) {
  const t = String(topic || "").trim();
  // When the user gives a niche/topic, point the search AT it; otherwise use the
  // generic "winning ads" queries.
  const queries = t
    ? [
        `best ${t} ads breakdown`,
        `${t} viral ad breakdown marketing`,
        `winning ${t} tiktok ads strategy`,
        `how to advertise ${t}`,
      ]
    : [
        "winning facebook ads breakdown marketing",
        "best tiktok ads strategy breakdown",
        "viral ad breakdown copywriting",
      ];
  const MAX = 4; // gather several winning examples, not just one
  const collected = [];
  try {
    const [ytMod, txMod] = await Promise.all([
      import("yt-search"),
      import("youtube-transcript"),
    ]);
    const ytSearch = ytMod.default || ytMod;
    const YoutubeTranscript =
      txMod.YoutubeTranscript || txMod.default || txMod;
    const seen = new Set();
    for (const q of queries) {
      if (collected.length >= MAX) break;
      let vids = [];
      try {
        const r = await ytSearch(q);
        vids = ((r && r.videos) || []).slice(0, 8);
      } catch {
        continue;
      }
      for (const v of vids) {
        if (collected.length >= MAX) break;
        if (!v.videoId || seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        try {
          const parts = await YoutubeTranscript.fetchTranscript(v.videoId);
          // Smaller per-item cap since we now combine several examples.
          const text = parts.map((p) => p.text).join(" ").slice(0, 6000).trim();
          if (text.length > 200) {
            collected.push({
              title: v.title || "",
              url: v.url || "https://www.youtube.com/watch?v=" + v.videoId,
              videoId: v.videoId || "",
              thumbnail:
                v.thumbnail ||
                v.image ||
                (v.videoId
                  ? "https://i.ytimg.com/vi/" + v.videoId + "/hqdefault.jpg"
                  : ""),
              transcript: text,
            });
          }
        } catch {
          /* no transcript for this one — try the next */
        }
      }
    }
  } catch {
    /* modules absent or search unavailable — fall through to synthesis */
  }
  if (collected.length === 0) return { text: "", fellBack: true, sources: [] };
  const text = collected
    .map((c, i) => `EXAMPLE ${i + 1} — "${c.title}":\n${c.transcript}`)
    .join("\n\n---\n\n");
  const sources = collected.map((c) => ({
    kind: "video",
    title: c.title,
    url: c.url,
    videoId: c.videoId,
    thumbnail: c.thumbnail,
  }));
  return { text, fellBack: false, sources };
}

export async function hackFormat({ client, method, imageBase64, mimeType, url, topic }) {
  client = client === "tranzzie" ? "tranzzie" : "jurie";
  const t = String(topic || "").trim().slice(0, 200);
  const director = await loadText(path.join(scriptsDir, "hack-director.md"));
  const voice = await loadText(
    path.join(scriptsDir, "voice-profile-" + client + ".md"),
  );

  // Resolve the source into either an inline image part or extracted text.
  let imagePart = null;
  let sourceText = "";
  let synthesize = false;
  let sources = []; // [{ kind, url?, title?, thumbnail?, images? }] — the "what it analyzed" card
  let multi = false;

  if (method === "image") {
    const data = String(imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
    if (data.length < 32) throw new Error("No screenshot was provided.");
    imagePart = { inlineData: { mimeType: mimeType || "image/png", data } };
    sources = [{ kind: "image" }]; // the frontend already has the screenshot to display
  } else if (method === "url") {
    const u = await extractFromUrl(url);
    sourceText = u.text;
    sources = [{ kind: "link", url, images: (u.images || []).slice(0, 3) }];
  } else if (method === "auto") {
    const a = await extractAuto(t);
    sourceText = a.text;
    synthesize = a.fellBack;
    sources = a.sources || [];
    multi = sources.length > 1;
  } else {
    throw new Error("Unknown input method.");
  }

  // When the user typed a niche/topic/idea, both concepts must serve it — and if
  // it's just a rough idea, use the proven format(s) to give it a working shape.
  const topicBlock = t
    ? '\n\n## USER\'S NICHE / IDEA (build BOTH adapted concepts to serve THIS)\n' +
      'The user wants content about / for: "' + t + '".\n' +
      'Both storyboards MUST be about this niche/idea. If it is a rough idea they ' +
      'do not yet know how to execute, use the proven winning format(s) to give it ' +
      'a working structure — make it THEIRS, but built on what already works.\n'
    : "";

  const systemInstruction =
    director +
    "\n\n---\n\n" +
    (CLIENT_CLAUSE[client] || CLIENT_CLAUSE.jurie) +
    "\n\nClient niche: " +
    (CLIENT_NICHE[client] || "") +
    topicBlock +
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
    const task = multi
      ? "The text above contains MULTIPLE winning examples (separated by ---). " +
        "Find the FORMAT they SHARE — the recurring visual + copywriting pattern " +
        "across them — and build the blueprint from that common pattern (not just " +
        "one example). Then adapt it into 2 storyboards for the client per the " +
        "system instruction. Output the JSON object only."
      : "Deconstruct this content (visual format + copywriting formula), then " +
        "adapt it into 2 storyboards for the client per the system instruction. " +
        "Output the JSON object only.";
    userParts = [
      {
        text:
          (multi
            ? "WINNING EXAMPLES (extracted text):\n\n"
            : "VIRAL SOURCE (extracted text):\n\n") +
          sourceText +
          "\n\n---\n\n" +
          task,
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
    contentIdea: String(b?.contentIdea || ""),
    hook: String(b?.hook || ""),
    caption: String(b?.caption || ""),
    hashtags: (Array.isArray(b?.hashtags) ? b.hashtags : [])
      .map((h) => String(h).replace(/^#/, "").trim())
      .filter(Boolean)
      .slice(0, 8),
    scenes: (Array.isArray(b?.scenes) ? b.scenes : []).map((s) => ({
      shot: String(s?.shot || ""),
      duration: String(s?.duration || ""),
      onScreenText: String(s?.onScreenText || ""),
      voiceover: String(s?.voiceover || ""),
      cameraAction: String(s?.cameraAction || ""),
      bRoll: String(s?.bRoll || ""),
    })),
  }));
  if (boards.length === 0)
    throw new Error("The AI did not return any storyboards — please try again.");

  return { blueprint, adaptedStoryboards: boards, synthesized: synthesize, sources };
}
