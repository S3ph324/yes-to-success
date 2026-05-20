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
const count = Math.max(1, Math.min(40, parseInt(flag("--count", "8"), 10) || 8));
const characterId = flag("--character", ""); // "" or "none" = no character
const scriptArg = flag("--script", "");
const videoArg = flag("--video", "");
if (!scriptArg && !videoArg) {
  console.error("Provide --script <file> or --video <file>");
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

if (scriptArg) {
  const p = path.isAbsolute(scriptArg)
    ? scriptArg
    : path.join(process.cwd(), scriptArg);
  sourceText = await fs.readFile(p, "utf-8");
} else {
  sourceKind = "VIDEO TRANSCRIPT";
  const vid = path.isAbsolute(videoArg)
    ? videoArg
    : path.join(process.cwd(), videoArg);
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
  if (r.status !== 0) {
    console.error("whisperx failed (is it on PATH? set WHISPERX_BIN)");
    process.exit(1);
  }
  const jf = (await fs.readdir(wxDir)).find((f) => f.endsWith(".json"));
  const wx = JSON.parse(await fs.readFile(path.join(wxDir, jf), "utf-8"));
  sourceText = (wx.segments || [])
    .map((s) => `[${mmss(s.start)}–${mmss(s.end)}] ${String(s.text).trim()}`)
    .join("\n");
}
sourceText = sourceText.trim();
if (sourceText.length < 20) {
  console.error("Source text too short / empty after processing.");
  process.exit(1);
}

// ── build the director instruction ────────────────────────────────────────
const director = await fs.readFile(
  path.join(projectRoot, "scripts", "broll-director.md"),
  "utf-8",
);
const dynamic = `

## THIS RUN
- Source type: ${sourceKind}
- Aspect ratio: ${aspect} (state it in EVERY image and video prompt)
- Character mode: ${charMode}${charMode === "reference-image" ? " — a reference image WILL be attached; do not describe the character, use the placeholder and the preserve-the-reference instruction" : " — no character; scenes/objects/places only"}
- Produce EXACTLY ${count} shots, in story order, each connected to a real beat.
${sourceKind === "VIDEO TRANSCRIPT" ? "- The source has [m:ss–m:ss] timecodes — set each shot's timecode to when its line is said." : "- No timing in the source — set every timecode to \"\"."}
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
  `Analyzing ${sourceKind.toLowerCase()} → ${count} b-roll shot(s), ${aspect}, character: ${charMode} …`,
);
const start = Date.now();
const resp = await ai.models.generateContent({
  model: MODEL,
  contents: `SOURCE (${sourceKind}):\n\n${sourceText}`,
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
  usesCharacter: charMode === "none" ? false : !!s.usesCharacter,
  imagePrompt: String(s.imagePrompt || ""),
  videoPrompt: String(s.videoPrompt || ""),
}));

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outDir = path.join(projectRoot, "out");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `broll-${stamp}.json`);
await fs.writeFile(
  outPath,
  JSON.stringify(
    {
      meta: {
        aspect,
        count: shots.length,
        characterId: charMode === "none" ? "" : characterId,
        charMode,
        sourceKind,
        createdAt: stamp,
      },
      transcript: sourceKind === "VIDEO TRANSCRIPT" ? sourceText : "",
      shots,
    },
    null,
    2,
  ),
);
const dt = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n✓ ${shots.length} shot(s) in ${dt}s\n  → ${outPath}\n`);
for (const s of shots.slice(0, 6))
  console.log(`  ${s.n}. ${s.title}${s.timecode ? ` [${s.timecode}]` : ""}`);
if (shots.length > 6) console.log(`  …and ${shots.length - 6} more`);
