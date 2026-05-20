#!/usr/bin/env node
// B-Roll analyzer. Input: a SCRIPT (text) or a VIDEO file. Produces a
// connected shot list of paired Nano Banana (first frame) + Veo 3.1
// (animation) prompts following scripts/broll-director.md.
//
// Two video transcription paths, auto-selected:
//   - whisperx local (Mac dev): uses ffmpeg → whisperx (if WHISPERX_BIN or
//     the default /Users/macbookpro/.buttercut/whisperx exists).
//   - Gemini direct (server/Railway): uploads the video to Gemini's Files
//     API and lets gemini-2.5-flash transcribe + analyze in one call.
//
// CLI usage:
//   node scripts/broll-analyze.mjs --aspect 9:16 --count 8 --script path.txt
//   node scripts/broll-analyze.mjs --aspect 16:9 --count 10 --character char_jurie --video clip.mp4
//
// Programmatic usage (from server.mjs):
//   import { analyzeBroll, saveAnalysis } from "./broll-analyze.mjs";
//   const result = await analyzeBroll({ source: { kind: "script", text }, aspect, count });
//   const outPath = await saveAnalysis(result, { outDir });

import { GoogleGenAI, Type } from "@google/genai";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

applyGcpEnv();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const aiClient = () =>
  new GoogleGenAI({
    vertexai: true,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
  });

const mmss = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const SHOT_SCHEMA = {
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

const detectMime = (videoPath) => {
  const ext = path.extname(videoPath).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".avi") return "video/x-msvideo";
  return "video/mp4";
};

// True when whisperx is reachable on this machine (Mac dev path).
export function whisperxAvailable() {
  const bin =
    process.env.WHISPERX_BIN || "/Users/macbookpro/.buttercut/whisperx";
  try {
    return existsSync(bin);
  } catch {
    return false;
  }
}

// Mac path: ffmpeg → whisperx (large-v3, tl). Returns transcript text with
// per-segment [m:ss–m:ss] timecodes.
async function transcribeWithWhisperX(videoPath) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "broll-"));
  const audio = path.join(tmp, "audio.mp3");
  let r = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame",
      "-ar", "16000", "-ac", "1", audio,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (r.status !== 0) throw new Error("ffmpeg failed (is it installed?)");

  const wxDir = path.join(tmp, "wx");
  const WHISPERX =
    process.env.WHISPERX_BIN || "/Users/macbookpro/.buttercut/whisperx";
  r = spawnSync(
    WHISPERX,
    [
      audio, "--model", "large-v3", "--language", "tl",
      "--vad_method", "silero", "--no_align", "--output_format", "json",
      "--output_dir", wxDir, "--chunk_size", "30",
      "--compute_type", "int8", "--batch_size", "4",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (r.status !== 0) throw new Error("whisperx failed");

  const jf = (await fs.readdir(wxDir)).find((f) => f.endsWith(".json"));
  if (!jf) throw new Error("whisperx produced no output JSON");
  const wx = JSON.parse(await fs.readFile(path.join(wxDir, jf), "utf-8"));
  return (wx.segments || [])
    .map(
      (s) => `[${mmss(s.start)}–${mmss(s.end)}] ${String(s.text).trim()}`,
    )
    .join("\n");
}

// Server path: upload video to Gemini's Files API and wait for ACTIVE.
// Returns the file ref for inclusion in generateContent parts.
async function uploadVideoToGemini(ai, videoPath) {
  const uploaded = await ai.files.upload({
    file: videoPath,
    config: {
      mimeType: detectMime(videoPath),
      displayName: path.basename(videoPath),
    },
  });
  let file = uploaded;
  // Poll until ACTIVE (video processing on Gemini side); cap at ~5 min.
  for (let i = 0; i < 150 && file.state && file.state !== "ACTIVE"; i++) {
    if (file.state === "FAILED")
      throw new Error("Gemini video processing failed");
    await new Promise((r) => setTimeout(r, 2000));
    file = await ai.files.get({ name: file.name });
  }
  if (file.state !== "ACTIVE")
    throw new Error(`Gemini file did not reach ACTIVE (state=${file.state})`);
  return file;
}

// Build the director system instruction (broll-director.md + dynamic block
// for this run). The dynamic block adapts to whether we have a video file
// (Gemini infers timecodes), a timecoded transcript, or a script with no
// timing.
async function buildDirectorInstruction({
  sourceKind,
  aspect,
  charMode,
  count,
  inputMode, // "script" | "transcript" | "video-file"
}) {
  const director = await fs.readFile(
    path.join(projectRoot, "scripts", "broll-director.md"),
    "utf-8",
  );
  const timingLine =
    inputMode === "transcript"
      ? '- The source has [m:ss–m:ss] timecodes — set each shot\'s timecode to when its line is said.'
      : inputMode === "video-file"
        ? '- The source is an attached video file — set each shot\'s timecode to the m:ss–m:ss range when the supporting beat is spoken or shown.'
        : '- No timing in the source — set every timecode to "".';
  const characterNote =
    charMode === "reference-image"
      ? " — a reference image WILL be attached; do not describe the character, use the placeholder and the preserve-the-reference instruction"
      : " — no character; scenes/objects/places only";
  const dynamic = `

## THIS RUN
- Source type: ${sourceKind}
- Aspect ratio: ${aspect} (state it in EVERY image and video prompt)
- Character mode: ${charMode}${characterNote}
- Produce EXACTLY ${count} shots, in story order, each connected to a real beat.
${timingLine}
`;
  return `${director}${dynamic}`;
}

// Core analyzer. Returns { meta, transcript, shots }. Does NOT persist.
//
// source:
//   { kind: "script", text: "..." }
//   { kind: "video", videoPath: "/abs/path/to.mp4" }
//
// options:
//   aspect: "9:16" | "16:9" (default "9:16")
//   count: 1..40 (default 8)
//   characterId: "" | "<id>" (default "")
//   preferWhisperX: boolean (default whisperxAvailable())
//   onProgress: (msg) => void
export async function analyzeBroll({
  source,
  aspect = "9:16",
  count = 8,
  characterId = "",
  preferWhisperX = whisperxAvailable(),
  onProgress = () => {},
} = {}) {
  const ar = aspect === "16:9" ? "16:9" : "9:16";
  const c = Math.max(1, Math.min(40, parseInt(count, 10) || 8));
  const charMode =
    characterId && characterId !== "none" ? "reference-image" : "none";
  const ai = aiClient();

  let sourceKind = "SCRIPT";
  let inputMode = "script";
  let sourceText = "";
  let videoFile = null;

  if (!source || typeof source !== "object")
    throw new Error("source is required");
  if (source.kind === "script") {
    sourceText = String(source.text || "").trim();
    if (sourceText.length < 20)
      throw new Error("Script too short / empty after trim");
  } else if (source.kind === "video") {
    if (!source.videoPath)
      throw new Error("source.videoPath is required for video input");
    sourceKind = "VIDEO TRANSCRIPT";
    if (preferWhisperX) {
      onProgress("Transcribing video (whisperx)…");
      sourceText = await transcribeWithWhisperX(source.videoPath);
      inputMode = "transcript";
    } else {
      onProgress("Uploading video to Gemini…");
      videoFile = await uploadVideoToGemini(ai, source.videoPath);
      inputMode = "video-file";
    }
  } else {
    throw new Error("source.kind must be 'script' or 'video'");
  }

  const systemInstruction = await buildDirectorInstruction({
    sourceKind,
    aspect: ar,
    charMode,
    count: c,
    inputMode,
  });

  const contents = videoFile
    ? [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: videoFile.uri,
                mimeType: videoFile.mimeType,
              },
            },
            {
              text: "Analyze the attached video against the director instruction and return the shot list.",
            },
          ],
        },
      ]
    : `SOURCE (${sourceKind}):\n\n${sourceText}`;

  onProgress(
    `Analyzing → ${c} shot(s), ${ar}, character: ${charMode}…`,
  );
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: { type: Type.ARRAY, items: SHOT_SCHEMA },
      temperature: 0.7,
    },
  });

  let shots;
  try {
    shots = JSON.parse(resp.text);
  } catch {
    throw new Error("Model response was not valid JSON");
  }
  if (!Array.isArray(shots) || shots.length === 0)
    throw new Error("Empty / invalid shot list from model");
  shots = shots.slice(0, c).map((s, i) => ({
    n: i + 1,
    title: String(s.title || `Shot ${i + 1}`),
    beat: String(s.beat || ""),
    timecode: String(s.timecode || ""),
    usesCharacter: charMode === "none" ? false : !!s.usesCharacter,
    imagePrompt: String(s.imagePrompt || ""),
    videoPrompt: String(s.videoPrompt || ""),
  }));

  return {
    meta: {
      aspect: ar,
      count: shots.length,
      characterId: charMode === "none" ? "" : characterId,
      charMode,
      sourceKind,
      inputMode, // "script" | "transcript" | "video-file"
      createdAt: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16),
    },
    transcript:
      sourceKind === "VIDEO TRANSCRIPT" && sourceText ? sourceText : "",
    shots,
  };
}

// Persist an analysis result to <outDir>/broll-<stamp>.json. Returns the path.
export async function saveAnalysis(result, { outDir } = {}) {
  const stamp = result?.meta?.createdAt || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const dir = outDir || path.join(projectRoot, "out");
  await fs.mkdir(dir, { recursive: true });
  const outPath = path.join(dir, `broll-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify(result, null, 2));
  return outPath;
}

// ── CLI ───────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  url.fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name, def = "") => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
  };
  const aspect = flag("--aspect", "9:16");
  const count = parseInt(flag("--count", "8"), 10) || 8;
  const characterId = flag("--character", "");
  const scriptArg = flag("--script", "");
  const videoArg = flag("--video", "");
  if (!scriptArg && !videoArg) {
    console.error("Provide --script <file> or --video <file>");
    process.exit(1);
  }
  try {
    let source;
    if (scriptArg) {
      const p = path.isAbsolute(scriptArg)
        ? scriptArg
        : path.join(process.cwd(), scriptArg);
      source = { kind: "script", text: await fs.readFile(p, "utf-8") };
    } else {
      const vp = path.isAbsolute(videoArg)
        ? videoArg
        : path.join(process.cwd(), videoArg);
      source = { kind: "video", videoPath: vp };
    }
    const start = Date.now();
    const result = await analyzeBroll({
      source,
      aspect,
      count,
      characterId,
      onProgress: (m) => console.log(m),
    });
    const outPath = await saveAnalysis(result);
    const dt = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n✓ ${result.shots.length} shot(s) in ${dt}s\n  → ${outPath}\n`);
    for (const s of result.shots.slice(0, 6))
      console.log(`  ${s.n}. ${s.title}${s.timecode ? ` [${s.timecode}]` : ""}`);
    if (result.shots.length > 6)
      console.log(`  …and ${result.shots.length - 6} more`);
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
}
