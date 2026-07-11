#!/usr/bin/env node
// Difference-video step 3/4 — voiceover + word timings.
//
// ONE Gemini-TTS request per video (the whole narration in a single read) so
// the voice stays consistent start-to-finish — per-sentence synthesis made
// the voice audibly "change" between lines and over-perform each one. If the
// model reads long, the track is tempo-adjusted toward cfg.tts.targetSec.
//
// Captions display the EXACT SCRIPT TEXT. Whisper supplies timing only: its
// heard words are paired with script words in order, so a transcription
// error can shift a timestamp slightly but can never put a wrong word on
// screen. Phase boundaries come from the aligned word times.
//
// Usage:
//   node scripts/generate-diff-audio.mjs <scripts.json>
//
// Adds to each video in the JSON (in place):
//   audio        — mp3 path relative to public/
//   durationSec  — full track duration
//   phases       — [{key, seg, kind, start, end, text, words:[{w,s,e}]}]

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI } from "@google/genai";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";

const { client: CLIENT_ID, rest: audArgs } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
cfg.applyGcpEnv();
const run = promisify(execFile);

const WHISPER_MODEL =
  process.env.TECHSPLAINS_WHISPER_MODEL || "mlx-community/whisper-large-v3-mlx";

const scriptsArg = audArgs[0];
if (!scriptsArg) {
  console.error("Usage: node scripts/generate-diff-audio.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

const stamp = stampFromScriptsPath(scriptsPath);
const relDir = path.posix.join("generated-diff", stamp);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const ai = new GoogleGenAI({
  vertexai: true,
  project: cfg.gcp.project,
  location: cfg.gcp.location,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ttsFull(text, outRaw) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: cfg.tts.model,
        contents: `${cfg.tts.stylePrompt}\n\n${text}`,
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.tts.voice } },
          },
        },
      });
      const part = (resp.candidates?.[0]?.content?.parts || []).find(
        (p) => p.inlineData?.data,
      );
      if (!part) throw new Error("no audio in response");
      await fs.writeFile(outRaw, Buffer.from(part.inlineData.data, "base64"));
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (!/429|RESOURCE_EXHAUSTED|no audio|503|terminated|fetch failed|ECONN|socket|timeout/i.test(msg) || attempt === 3) break;
      await sleep(6000 * 2 ** attempt);
    }
  }
  throw new Error(`TTS failed: ${String(lastErr?.message || lastErr).slice(0, 200)}`);
}

const probeDuration = async (file) => {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
  ]);
  return parseFloat(stdout.trim());
};

// Phase list for one video, in narration order. "didyouknow" videos map onto
// existing phase kinds so the composition needs no new plumbing: the fact
// reads as introA (image pops in, mascot points) and the why as defA (think).
const phaseList = (v) => {
  const out = [];
  if (v.hook) out.push({ key: "hook", seg: 0, kind: "hook", text: v.hook });
  if (v.variant === "didyouknow") {
    const s = v.segments[0];
    out.push({ key: "fact", seg: 0, kind: "introA", text: s.introA });
    out.push({ key: "why", seg: 0, kind: "defA", text: s.defA });
  } else {
    v.segments.forEach((s, si) => {
      out.push({ key: `s${si}-introA`, seg: si, kind: "introA", text: s.introA });
      out.push({ key: `s${si}-introB`, seg: si, kind: "introB", text: s.introB });
      out.push({ key: `s${si}-question`, seg: si, kind: "question", text: "What's the difference?" });
      out.push({ key: `s${si}-defA`, seg: si, kind: "defA", text: s.defA });
      out.push({ key: `s${si}-defB`, seg: si, kind: "defB", text: s.defB });
    });
  }
  out.push({ key: "outro", seg: -1, kind: "outro", text: v.outro });
  return out;
};

const splitWords = (t) => String(t || "").split(/\s+/).filter(Boolean);

// Proportional fallback: spread phases across the track by word share.
const proportional = (phases, durationSec) => {
  const total = phases.reduce((n, p) => n + splitWords(p.text).length, 0);
  let cum = 0;
  for (const p of phases) {
    const ws = splitWords(p.text);
    p.start = (durationSec * cum) / total;
    cum += ws.length;
    p.end = (durationSec * cum) / total;
    const span = p.end - p.start;
    p.words = ws.map((w, i) => ({
      w,
      s: p.start + (span * i) / ws.length,
      e: p.start + (span * (i + 1)) / ws.length,
    }));
  }
};

for (let vi = 0; vi < videos.length; vi++) {
  const v = videos[vi];
  const vid = String(vi + 1).padStart(2, "0");
  // Resume support: a video that already has its voice track + timings keeps
  // them, so a rerun after a mid-batch failure only pays for the gaps.
  if (v.audio && Array.isArray(v.phases) && v.phases.length) {
    try {
      await fs.access(path.join(projectRoot, "public", v.audio));
      console.log(`\n[${vi + 1}/${videos.length}] ${v.title} — SKIP (already voiced)`);
      continue;
    } catch { /* file gone — regenerate */ }
  }
  const phases = phaseList(v);
  const narration = phases.map((p) => p.text).join("\n\n");
  console.log(`\n[${vi + 1}/${videos.length}] ${v.title} — single-read narration (${phases.length} phases)`);

  // 1) One TTS call for the whole video. Raw PCM s16le 24 kHz mono.
  const raw = path.join(absDir, `${vid}-voice.raw`);
  await ttsFull(narration, raw);

  // 2) Wrap to WAV with edge fades; tempo-correct toward the target length.
  const wavNatural = path.join(absDir, `${vid}-natural.wav`);
  await run("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", raw,
    "-af", "afade=t=in:st=0:d=0.02,areverse,afade=t=in:st=0:d=0.1,areverse",
    "-c:a", "pcm_s16le", wavNatural]);
  await fs.rm(raw, { force: true });
  const naturalDur = await probeDuration(wavNatural);
  const tempo = Math.min(cfg.tts.maxTempo, Math.max(1, naturalDur / cfg.tts.targetSec));
  const fullWav = path.join(absDir, `${vid}-voice.wav`);
  if (tempo > 1.01) {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", wavNatural,
      "-af", `atempo=${tempo.toFixed(3)}`, "-c:a", "pcm_s16le", fullWav]);
    console.log(`  read ${naturalDur.toFixed(1)}s → sped ×${tempo.toFixed(2)} toward ${cfg.tts.targetSec}s target`);
  } else {
    await fs.copyFile(wavNatural, fullWav);
  }
  await fs.rm(wavNatural, { force: true });
  const durationSec = await probeDuration(fullWav);
  const mp3Name = `${vid}-voice.mp3`;
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", fullWav,
    "-codec:a", "libmp3lame", "-q:a", "3", path.join(absDir, mp3Name)]);

  // 3) Whisper the FINAL (tempo-corrected) track for word timings.
  let whisperWords = [];
  try {
    const whisperArgs = [fullWav, "--model", WHISPER_MODEL];
    if (cfg.whisperLang && cfg.whisperLang !== "auto") whisperArgs.push("--language", cfg.whisperLang);
    whisperArgs.push("--word-timestamps", "True", "--output-format", "json", "--output-dir", absDir, "--output-name", `${vid}-voice`);
    await run("mlx_whisper", whisperArgs, { maxBuffer: 32 * 1024 * 1024 });
    const wj = JSON.parse(
      await fs.readFile(path.join(absDir, `${vid}-voice.json`), "utf-8"),
    );
    for (const seg of wj.segments || [])
      for (const w of seg.words || [])
        whisperWords.push({ s: w.start, e: w.end });
  } catch (err) {
    console.warn(`  whisper failed (${String(err.message || err).slice(0, 80)}) — proportional timing`);
  }

  // 4) Pair SCRIPT words with heard timings in order. Caption text is always
  // the script; whisper only decides WHEN each word pops.
  const totalScriptWords = phases.reduce((n, p) => n + splitWords(p.text).length, 0);
  if (whisperWords.length >= totalScriptWords * 0.85) {
    let qi = 0;
    let lastEnd = 0;
    for (const p of phases) {
      const ws = splitWords(p.text);
      const heard = whisperWords.slice(qi, qi + ws.length);
      qi += heard.length;
      p.words = ws.map((w, i) => {
        if (i < heard.length) return { w, s: heard[i].s, e: heard[i].e };
        const base = heard.length ? heard[heard.length - 1].e : lastEnd;
        return { w, s: base + (i - heard.length) * 0.3, e: base + (i - heard.length + 1) * 0.3 };
      });
      p.start = p.words[0].s;
      p.end = p.words[p.words.length - 1].e;
      lastEnd = p.end;
    }
  } else {
    console.warn(`  whisper heard ${whisperWords.length}/${totalScriptWords} words — proportional timing`);
    proportional(phases, durationSec);
  }

  v.audio = path.posix.join(relDir, mp3Name);
  v.durationSec = Math.round(durationSec * 100) / 100;
  v.phases = phases;
  // Persist after EVERY video — a mid-batch crash otherwise loses the record
  // of finished voice tracks and a rerun re-synthesizes them all.
  await fs.writeFile(scriptsPath, JSON.stringify(videos, null, 2));
  console.log(`  ✓ ${v.durationSec}s voice → public/${relDir}/${mp3Name}`);
}

console.log(`\n✓ Audio + timings written back → ${scriptsPath}`);
