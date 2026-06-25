#!/usr/bin/env node
// B-Roll analyzer. Input: a SCRIPT file/text OR a VIDEO file. Produces a
// connected shot list of paired Nano Banana (first frame) + Veo 3.1
// (animation) prompts following scripts/broll-director.md.
//
// Usage:
//   node scripts/broll-analyze.mjs --aspect 9:16 --count 8 --script path.txt
//   node scripts/broll-analyze.mjs --aspect 16:9 --count 10 --character char_jurie --video clip.mp4
//
// Output: out/broll-<stamp>.json  { meta, transcript, shots:[...] }

import { GoogleGenAI, Type } from "@google/genai";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ── args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = "") => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const aspect = flag("--aspect", "9:16") === "16:9" ? "16:9" : "9:16";
const count = Math.max(1, Math.min(200, parseInt(flag("--count", "8"), 10) || 8));
const characterId = flag("--character", ""); // "" or "none" = no character
const scriptArg = flag("--script", "");
const videoArg = flag("--video", "");
const ideaArg = flag("--idea", ""); // a file holding a short IDEA → drafted into a script first
const stampArg = flag("--stamp", ""); // caller-controlled stamp (the dashboard pins it so it can reference the set across stages)
// mode: "broll" (cutaway shots illustrating a source) | "story" (sequential
// narrative SCENES that ARE the video). Swaps the director prompt + framing.
const mode = flag("--mode", "broll") === "story" ? "story" : "broll";
const unit = mode === "story" ? "scene" : "b-roll shot";
if (!scriptArg && !videoArg && !ideaArg) {
  console.error("Provide --idea <file>, --script <file> or --video <file>");
  process.exit(1);
}

const charMode =
  characterId && characterId !== "none" ? "reference-image" : "none";

// ── resolve source text ───────────────────────────────────────────────────
const mmss = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

let sourceKind = "SCRIPT";
let sourceText = "";
let draftedScript = ""; // set when --idea drafts a script (surfaced in meta.script)
let videoPart = null; // { inlineData } | { fileData } — direct-to-Gemini video

// Video MIME guesser
const videoMimeFor = (p) => {
  const ext = path.extname(p).toLowerCase().slice(1);
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  if (ext === "mkv") return "video/x-matroska";
  if (ext === "avi") return "video/x-msvideo";
  if (ext === "m4v") return "video/x-m4v";
  return "video/mp4";
};

if (ideaArg) {
  // IDEA → draft a short voiceover script first (the user can read it), then
  // analyze that script into shots like any other SCRIPT source.
  const p = path.isAbsolute(ideaArg) ? ideaArg : path.join(process.cwd(), ideaArg);
  const ideaText = (await fs.readFile(p, "utf-8")).trim();
  if (ideaText.length < 4) {
    console.error("Idea too short.");
    process.exit(1);
  }
  console.log("Drafting a short script from the idea…");
  const draftAi = new GoogleGenAI({ vertexai: true, project, location });
  const dr = await draftAi.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text:
      `IDEA:\n${ideaText}\n\nWrite a short ${mode === "story"
        ? "NARRATIVE video script — a tiny story with a beginning, middle, and end"
        : "spoken-word VOICEOVER SCRIPT"} for a ` +
      `${aspect} short-form social video that delivers this idea. Natural Taglish ` +
      `is welcome. Open with a hook, ${mode === "story"
        ? "build through 2–4 story beats"
        : "make 2–4 concrete points"}, and close with a ` +
      `memorable line. Keep it tight (roughly ${Math.max(40, count * 8)}–` +
      `${count * 16} words). Output ONLY the script text — no title, no ` +
      `scene directions, no labels, no quotation marks.` }] }],
    config: { temperature: 0.85 },
  });
  sourceText = (dr.text || "").trim();
  draftedScript = sourceText;
  if (sourceText.length < 20) {
    console.error("Script drafting failed (empty response).");
    process.exit(1);
  }
  sourceKind = "SCRIPT";
  console.log("Drafted script:\n" + sourceText.slice(0, 500) + (sourceText.length > 500 ? "…" : ""));
} else if (scriptArg) {
  const p = path.isAbsolute(scriptArg)
    ? scriptArg
    : path.join(process.cwd(), scriptArg);
  sourceText = await fs.readFile(p, "utf-8");
} else {
  // Video path — two modes:
  //   1. BROLL_USE_WHISPERX=1 + WHISPERX_BIN — Mac flow: ffmpeg+whisperx →
  //      timestamped transcript, then Gemini analyzes the transcript.
  //   2. Default (hosted & anywhere else) — feed the video directly to
  //      Gemini 2.5 (it watches frames and listens to audio). No ffmpeg,
  //      no whisper, no extra binaries.
  const vid = path.isAbsolute(videoArg)
    ? videoArg
    : path.join(process.cwd(), videoArg);
  const stat = await fs.stat(vid);
  const sizeMB = stat.size / (1024 * 1024);

  const useWhisper =
    process.env.BROLL_USE_WHISPERX === "1" && process.env.WHISPERX_BIN;

  if (useWhisper) {
    sourceKind = "VIDEO TRANSCRIPT";
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "broll-"));
    const audio = path.join(tmp, "audio.mp3");
    console.log("Extracting audio (ffmpeg)…");
    let r = spawnSync(
      "ffmpeg",
      ["-y", "-i", vid, "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", audio],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    if (r.status !== 0) {
      console.error("ffmpeg failed");
      process.exit(1);
    }
    console.log("Transcribing (whisperx large-v3, tl)… this can take a while.");
    const wxDir = path.join(tmp, "wx");
    r = spawnSync(
      process.env.WHISPERX_BIN,
      [
        audio, "--model", "large-v3", "--language", "tl",
        "--vad_method", "silero", "--no_align", "--output_format", "json",
        "--output_dir", wxDir, "--chunk_size", "30",
        "--compute_type", "int8", "--batch_size", "4",
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (r.status !== 0) {
      console.error("whisperx failed (set WHISPERX_BIN correctly, or unset BROLL_USE_WHISPERX to use Gemini direct)");
      process.exit(1);
    }
    const jf = (await fs.readdir(wxDir)).find((f) => f.endsWith(".json"));
    const wx = JSON.parse(await fs.readFile(path.join(wxDir, jf), "utf-8"));
    sourceText = (wx.segments || [])
      .map((s) => `[${mmss(s.start)}–${mmss(s.end)}] ${String(s.text).trim()}`)
      .join("\n");
  } else {
    sourceKind = "VIDEO";
    const mime = videoMimeFor(vid);
    console.log(
      `Sending video (${sizeMB.toFixed(1)}MB, ${mime}) directly to Gemini…`,
    );
    if (sizeMB <= 19) {
      // Inline base64 (≤20MB request limit on Vertex inlineData)
      const buf = await fs.readFile(vid);
      videoPart = {
        inlineData: { mimeType: mime, data: buf.toString("base64") },
      };
    } else {
      // Files API (works on Vertex via the managed staging bucket)
      console.log("Video > 19MB — uploading via Gemini Files API…");
      try {
        // Lazy-construct ai client just for the upload (real one is below).
        const tmpAi = new GoogleGenAI({ vertexai: true, project, location });
        let file = await tmpAi.files.upload({
          file: vid,
          config: { mimeType: mime },
        });
        const t0 = Date.now();
        while (file.state === "PROCESSING") {
          if (Date.now() - t0 > 5 * 60 * 1000)
            throw new Error("Files API still PROCESSING after 5 min");
          await new Promise((r) => setTimeout(r, 3000));
          file = await tmpAi.files.get({ name: file.name });
        }
        if (file.state !== "ACTIVE")
          throw new Error("Files API ended in state " + file.state);
        videoPart = { fileData: { fileUri: file.uri, mimeType: mime } };
      } catch (e) {
        console.error(
          "Video too large for inline (>19MB), and Files API upload failed:",
          e?.message || e,
        );
        console.error(
          "Options: (1) compress the video below 19MB, (2) use a shorter clip, or (3) paste the script as text.",
        );
        process.exit(1);
      }
    }
  }
}

if (!videoPart) {
  sourceText = sourceText.trim();
  if (sourceText.length < 20) {
    console.error("Source text too short / empty after processing.");
    process.exit(1);
  }
}

// ── build the director instruction ────────────────────────────────────────
const director = await fs.readFile(
  path.join(projectRoot, "scripts", mode === "story" ? "story-director.md" : "broll-director.md"),
  "utf-8",
);
const charNote = mode === "story"
  ? (charMode === "reference-image"
      ? " — a reference image WILL be attached. The character is the PROTAGONIST: feature them in MOST scenes (usesCharacter: true), centered and emoting as the story needs. Do not describe them — use the placeholder and the preserve-the-reference instruction."
      : " — no character reference attached YET, but this is a NARRATIVE: build it around ONE recurring PROTAGONIST who carries the story and set usesCharacter: true on every scene they appear in (most scenes). Use the placeholder \"the character (use the provided reference image)\" for them and describe everything else; the user attaches or invents a consistent character before frames are generated. Do NOT reduce the story to object/B-roll cutaways.")
  : (charMode === "reference-image"
      ? " — a reference image WILL be attached; do not describe the character, use the placeholder and the preserve-the-reference instruction"
      : " — no character reference is attached yet. Still set usesCharacter per shot: true ONLY when a recurring on-camera PERSON is genuinely the subject of that beat; false for scene / object / place cutaways (most b-roll). This lets the user optionally add a character afterwards.");
const countLine = mode === "story"
  ? `- Produce EXACTLY ${count} scenes, in story order, that together form ONE complete narrative arc (hook → development → payoff/CTA). Each scene cuts into the next.`
  : `- Produce EXACTLY ${count} shots, in story order, each connected to a real beat.`;
const timingLine = mode === "story"
  ? '- This is an original narrative — set every timecode to "".'
  : sourceKind === "VIDEO TRANSCRIPT"
    ? "- The source has [m:ss–m:ss] timecodes — set each shot's timecode to when its line is said."
    : sourceKind === "VIDEO"
      ? "- The source is a video you can watch and listen to directly. For each shot, set timecode (m:ss) to the moment in the video the b-roll should cover. Use the visuals AND the spoken audio to find the beats."
      : '- No timing in the source — set every timecode to "".';
const dynamic = `

## THIS RUN
- Source type: ${sourceKind}
- Aspect ratio: ${aspect} (state it in EVERY image and video prompt)
- Character mode: ${charMode}${charNote}
${countLine}
${timingLine}
`;

const ai = new GoogleGenAI({ vertexai: true, project, location });
const shotObj = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    beat: { type: Type.STRING },
    timecode: { type: Type.STRING },
    usesCharacter: { type: Type.BOOLEAN },
    imagePrompt: { type: Type.STRING },
    videoPrompt: { type: Type.STRING },
  },
  required: ["title", "beat", "imagePrompt", "videoPrompt", "usesCharacter"],
};

console.log(
  `Analyzing ${sourceKind.toLowerCase()} → ${count} ${unit}(s), ${aspect}, character: ${charMode} …`,
);
const start = Date.now();
const userParts = videoPart
  ? [
      videoPart,
      {
        text: mode === "story"
          ? "Watch this video and adapt it into the connected narrative scene list per the system instruction."
          : "Watch this video carefully — every frame and all spoken audio — " +
            "and produce the connected b-roll shot list per the system instruction.",
      },
    ]
  : [{ text: `SOURCE (${sourceKind}):\n\n${sourceText}` }];
const resp = await ai.models.generateContent({
  model: MODEL,
  contents: [{ role: "user", parts: userParts }],
  config: {
    systemInstruction: `${director}${dynamic}`,
    responseMimeType: "application/json",
    responseSchema: { type: Type.ARRAY, items: shotObj },
    temperature: 0.7,
  },
});

let shots;
try {
  shots = JSON.parse(resp.text);
} catch {
  console.error("Model response was not valid JSON:\n", resp.text);
  process.exit(1);
}
if (!Array.isArray(shots) || shots.length === 0) {
  console.error("Empty / invalid shot list.");
  process.exit(1);
}
shots = shots.slice(0, count).map((s, i) => ({
  n: i + 1,
  title: String(s.title || `Shot ${i + 1}`),
  beat: String(s.beat || ""),
  timecode: String(s.timecode || ""),
  usesCharacter: !!s.usesCharacter,
  imagePrompt: String(s.imagePrompt || ""),
  videoPrompt: String(s.videoPrompt || ""),
}));
// Whether the content itself implies a recurring on-camera person — the UI uses
// this to suggest adding a character.
const charDetected = shots.some((s) => s.usesCharacter);

const stamp = stampArg || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `broll-${stamp}.json`);
await fs.writeFile(
  outPath,
  JSON.stringify(
    {
      meta: {
        aspect,
        mode,
        count: shots.length,
        characterId: charMode === "none" ? "" : characterId,
        charMode,
        sourceKind,
        createdAt: stamp,
        // Drafted from an idea (empty for script/video sources).
        script: draftedScript,
        // Content implies a recurring on-camera person → offer a character.
        charDetected,
      },
      transcript: sourceKind === "VIDEO TRANSCRIPT" ? sourceText : "",
      shots,
    },
    null,
    2,
  ),
);
// Also persist to the Railway volume so the analyzed set survives a container
// restart or an out/ cleanup (out/ is ephemeral). The staged flow restores this
// for the frames/character stages — without it you get "Analyzed set not found".
const exportDir = process.env.BROLL_EXPORT_DIR;
if (exportDir) {
  try {
    const vdir = path.join(exportDir, stamp);
    await fs.mkdir(vdir, { recursive: true });
    await fs.copyFile(outPath, path.join(vdir, "analyzed.json"));
  } catch (e) {
    console.warn(`  (could not persist analyzed set to volume: ${e?.message || e})`);
  }
}

const dt = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n✓ ${shots.length} ${unit}(s) in ${dt}s\n  → ${outPath}\n`);
for (const s of shots.slice(0, 6))
  console.log(`  ${s.n}. ${s.title}${s.timecode ? ` [${s.timecode}]` : ""}`);
if (shots.length > 6) console.log(`  …and ${shots.length - 6} more`);
