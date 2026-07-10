#!/usr/bin/env node
// Techsplains step 3 — the DIRECTOR. A QC agent that double-checks every
// script and every sourced visual before money is spent on TTS + render.
//
//   Script pass  — fact-checks each video, verifies the formula, and punches
//                  up weak hooks/definitions/outros/captions (bounded
//                  rewrites; intro sentence patterns are never touched).
//                  Factually-broken videos are CUT from the batch.
//   Visual pass  — looks at every final image (and the first frame of every
//                  stock clip) at full resolution and fails anything that
//                  doesn't clearly show its label; failed slots get a better
//                  search query and ONE re-source round (video → Openverse →
//                  Pexels → AI). Still failing → the slot stays empty and the
//                  render step skips that video, as designed.
//
// Runs BEFORE the audio step so text fixes land before narration is
// synthesized. Skip entirely with TECHSPLAINS_DIRECTOR=0.
//
// Usage:
//   node scripts/generate-diff-director.mjs <scripts.json>

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GoogleGenAI, Type } from "@google/genai";
import { projectRoot } from "./lib/client.mjs";
import { applyTechsplainsGcpEnv, TS_GCP } from "./lib/techsplains.mjs";
import { stockImage, genImage, openverseImage, stockVideo } from "./lib/image-sourcing.mjs";

applyTechsplainsGcpEnv();
const run = promisify(execFile);

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (process.env.TECHSPLAINS_DIRECTOR === "0") {
  console.log("Director QC disabled (TECHSPLAINS_DIRECTOR=0) — passing batch through.");
  process.exit(0);
}

const scriptsArg = process.argv[2];
if (!scriptsArg) {
  console.error("Usage: node scripts/generate-diff-director.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

const stamp =
  scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] || "unknown";
const absDir = path.join(projectRoot, "public", "generated-diff", stamp);
const relDir = path.posix.join("generated-diff", stamp);

const ai = new GoogleGenAI({
  vertexai: true,
  project: TS_GCP.project,
  location: TS_GCP.location,
});

const words = (t) => String(t || "").split(/\s+/).filter(Boolean).length;

// ── Pass 1: script review ────────────────────────────────────────────────────

const reviewSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      index: { type: Type.NUMBER, description: "0-based index of the video being reviewed" },
      note: { type: Type.STRING, description: "One line: what was checked, what was wrong / improved / why rejected" },
      verdict: { type: Type.STRING, enum: ["pass", "fix", "reject"] },
      hook: { type: Type.STRING, description: "FINAL hook text (improved or unchanged)" },
      outro: { type: Type.STRING, description: "FINAL outro text" },
      caption: { type: Type.STRING, description: "FINAL Facebook caption (keep any trailing 📷 credit line EXACTLY as-is)" },
      segments: {
        type: Type.ARRAY,
        description: "One entry per segment, same order",
        items: {
          type: Type.OBJECT,
          properties: {
            defA: { type: Type.STRING, description: "FINAL defA text" },
            defB: { type: Type.STRING, description: "FINAL defB text ('' for did-you-know)" },
          },
          required: ["defA", "defB"],
        },
      },
    },
    required: ["index", "note", "verdict", "hook", "outro", "caption", "segments"],
    propertyOrdering: ["index", "note", "verdict", "hook", "outro", "caption", "segments"],
  },
};

const reviewInstruction = `You are the DIRECTOR doing final QC on short-form
"what's the difference" / "did you know" explainer scripts for the Techsplains
Facebook brand. For each video, in order:

1. FACT-CHECK every claim. These are educational — no false claim may ship.
   STRONGLY prefer repairing over rejecting: if rewriting a definition (or
   hook/outro/caption) within the word limits makes the video accurate, DO
   the rewrite and use verdict "fix" ("a frog is a reptile" → fix defA to say
   amphibian; do not throw the video away). Verdict "reject" is the last
   resort, ONLY when the video's core premise/title is unsalvageably wrong
   (e.g. the two things are actually the same thing, or the "fact" is a myth).
2. QUALITY: hooks must open a curiosity gap or start a debate (never announce
   the topic); definitions must be plain-English, mirrored A/B, ideally with
   one vivid TRUE detail; the outro question must be answerable in one word.
   If anything is weak, rewrite it and use verdict "fix".
3. Return the FINAL text for hook, outro, caption, and each segment's
   defA/defB — unchanged fields returned verbatim.

HARD RULES for rewrites:
- Never change what the video is about or its title/labels.
- defA/defB: max 16 words each, one sentence, starts with the term.
- hook: max 9 words (a "did you know" video's hook MUST still literally
  start with "Did you know" and may be up to 11 words).
- outro: engagement question + "Follow Techsplains for more!".
- caption: keep the structure; if it ends with a 📷 credit line, copy that
  line over EXACTLY unchanged.
- Do NOT touch introA/introB (renderer depends on their sentence pattern).
- Accuracy outranks punchiness — never add a "fact" you are not sure of.

Output ONLY the JSON array, one entry per video, index matching the input.`;

console.log(`Director QC — reviewing ${videos.length} script(s)…`);
let reviews = [];
try {
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents:
      "Review these video scripts:\n\n" +
      JSON.stringify(
        videos.map((v) => ({
          title: v.title,
          variant: v.variant,
          category: v.category,
          hook: v.hook,
          outro: v.outro,
          caption: v.caption,
          segments: v.segments.map((s) => ({
            aLabel: s.aLabel, bLabel: s.bLabel,
            introA: s.introA, introB: s.introB,
            defA: s.defA, defB: s.defB,
          })),
        })),
        null, 2,
      ),
    config: {
      systemInstruction: reviewInstruction,
      responseMimeType: "application/json",
      responseSchema: reviewSchema,
      temperature: 0.2,
    },
  });
  reviews = JSON.parse(resp.text);
} catch (err) {
  console.warn(`  script review failed (${String(err.message || err).slice(0, 80)}) — skipping script pass`);
}

const cut = new Set();
for (const r of reviews) {
  const v = videos[r.index];
  if (!v) continue;
  if (r.verdict === "reject") {
    cut.add(r.index);
    console.log(`  ✗ CUT "${v.title}" — ${r.note}`);
    continue;
  }
  if (r.verdict === "fix") {
    // Apply bounded fixes only; anything over the caps keeps the original.
    const isDyk = v.variant === "didyouknow";
    if (r.hook && words(r.hook) <= (isDyk ? 12 : 10) &&
        (!isDyk || /^did you know/i.test(r.hook.trim()))) v.hook = r.hook;
    if (r.outro && words(r.outro) <= 16 && /follow techsplains/i.test(r.outro)) v.outro = r.outro;
    if (r.caption) v.caption = r.caption;
    (r.segments || []).forEach((rs, si) => {
      const s = v.segments[si];
      if (!s) return;
      if (rs.defA && words(rs.defA) <= 18) s.defA = rs.defA;
      if (s.bLabel && rs.defB && words(rs.defB) <= 18) s.defB = rs.defB;
    });
    console.log(`  ✎ FIXED "${v.title}" — ${r.note}`);
  } else {
    console.log(`  ✓ PASS "${v.title}"`);
  }
}
if (cut.size) videos.splice(0, videos.length, ...videos.filter((_, i) => !cut.has(i)));

// ── Pass 2: visual review ────────────────────────────────────────────────────

const mimeFor = (p) => (p.endsWith(".png") ? "image/png" : "image/jpeg");

// First frame of a clip, so the director reviews what the viewer actually sees.
async function posterFrame(absMp4) {
  const out = absMp4.replace(/\.mp4$/, "-poster.jpg");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1", "-i", absMp4,
    "-frames:v", "1", "-q:v", "4", out]);
  const buf = await fs.readFile(out);
  await fs.rm(out, { force: true });
  return buf;
}

// `reason` is deliberately FIRST (propertyOrdering): forcing the model
// straight into a pass/fail token skips its visual reasoning — in testing it
// waved through a frog/toad photo swap that it correctly failed when asked
// to explain first. One short sentence of reasoning fixes that.
const visualSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      slot: { type: Type.NUMBER, description: "1-based slot number as presented" },
      reason: { type: Type.STRING, description: "One short line: what the image shows vs what was expected" },
      verdict: { type: Type.STRING, enum: ["pass", "fail"] },
      betterQuery: { type: Type.STRING, description: "On fail: a better 2-4 keyword stock search for this label ('' on pass)" },
    },
    required: ["slot", "reason", "verdict", "betterQuery"],
    propertyOrdering: ["slot", "reason", "verdict", "betterQuery"],
  },
};

let visualsChecked = 0;
let visualsFailed = 0;
const resourceJobs = [];

for (let vi = 0; vi < videos.length; vi++) {
  const v = videos[vi];
  // Collect this video's slots: [segment, side, label, otherLabel, relPath, isClip]
  const slots = [];
  v.segments.forEach((s) => {
    if (s.aVideo || s.aImg) slots.push({ s, side: "a", label: s.aLabel, other: s.bLabel, rel: s.aVideo || s.aImg, isClip: !!s.aVideo });
    if (s.bLabel && s.bImg) slots.push({ s, side: "b", label: s.bLabel, other: s.aLabel, rel: s.bImg, isClip: false });
  });
  if (!slots.length) continue;

  const parts = [];
  let loadable = [];
  for (const slot of slots) {
    try {
      const abs = path.join(projectRoot, "public", slot.rel);
      const buf = slot.isClip ? await posterFrame(abs) : await fs.readFile(abs);
      parts.push({ inlineData: { mimeType: slot.isClip ? "image/jpeg" : mimeFor(slot.rel), data: buf.toString("base64") } });
      loadable.push(slot);
    } catch { /* missing file — render step will skip; nothing to review */ }
  }
  if (!loadable.length) continue;
  visualsChecked += loadable.length;

  parts.push({
    text:
      `These ${loadable.length} visuals are numbered 1..${loadable.length} in order. ` +
      `They appear in the video "${v.title}". Expected subjects, in order:\n` +
      loadable.map((sl, i) =>
        `${i + 1}. "${sl.label}"` + (sl.other ? ` (must NOT look like a ${sl.other} — the video contrasts the two)` : ""),
      ).join("\n") +
      `\n\nFor each: verdict "pass" if it clearly, brightly, unmistakably shows its ` +
      `subject and reads instantly at thumbnail size; "fail" if it shows the wrong ` +
      `thing, is ambiguous with the contrasted item, or is too dark/cluttered/abstract ` +
      `to read. On fail, give a better 2-4 keyword stock search query for that subject.`,
  });

  try {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", responseSchema: visualSchema, temperature: 0 },
    });
    const verdicts = JSON.parse(resp.text);
    for (const r of verdicts) {
      const slot = loadable[r.slot - 1];
      if (!slot || r.verdict !== "fail") continue;
      visualsFailed++;
      console.log(`  ✗ visual FAIL "${v.title}" — ${slot.label} (retry query: "${r.betterQuery || slot.label}")`);
      // Clear the slot + file; queue one re-source round with the better query.
      await fs.rm(path.join(projectRoot, "public", slot.rel), { force: true });
      if (slot.side === "a") { delete slot.s.aImg; delete slot.s.aVideo; delete slot.s.aVideoDurationSec; delete slot.s.aCredit; }
      else { delete slot.s.bImg; delete slot.s.bCredit; }
      resourceJobs.push({ v, vi, slot, query: r.betterQuery || slot.label });
    }
  } catch (err) {
    console.warn(`  visual review failed for "${v.title}" (${String(err.message || err).slice(0, 60)}) — keeping visuals as-is`);
  }
}

// ── One re-source round for failed slots ─────────────────────────────────────

if (resourceJobs.length) {
  console.log(`Re-sourcing ${resourceJobs.length} failed visual(s)…`);
  const usedByVideo = new Map();
  for (const job of resourceJobs) {
    if (!usedByVideo.has(job.vi)) usedByVideo.set(job.vi, new Set());
    const usedIds = usedByVideo.get(job.vi);
    const si = job.v.segments.indexOf(job.slot.s);
    const base = `${String(job.vi + 1).padStart(2, "0")}-${si + 1}${job.slot.side}r`;
    const { label, other } = job.slot;
    try {
      let rel = "";
      if (job.v.variant === "didyouknow") {
        const clip = await stockVideo(job.query, label, usedIds, path.join(absDir, `${base}.mp4`)).catch(() => false);
        if (clip) {
          rel = path.posix.join(relDir, `${base}.mp4`);
          job.slot.s.aVideo = rel;
          job.slot.s.aVideoDurationSec = clip.durationSec;
        }
      }
      if (!rel) {
        const out = path.join(absDir, `${base}.jpg`);
        const ov = await openverseImage(job.query, label, other, usedIds, out).catch(() => null);
        let got = !!ov;
        if (ov?.credit) job.slot.s[job.slot.side === "a" ? "aCredit" : "bCredit"] = ov.credit;
        if (!got) got = await stockImage(job.query, label, other, usedIds, out).catch(() => false);
        if (got) {
          rel = path.posix.join(relDir, `${base}.jpg`);
        } else {
          await genImage(
            `bright clear photo-style image of ${label}, in the context of "${job.v.title}"`,
            path.join(absDir, `${base}.png`),
            `clean minimal flat illustration of ${label}, single centered subject`,
          );
          rel = path.posix.join(relDir, `${base}.png`);
        }
        job.slot.s[job.slot.side === "a" ? "aImg" : "bImg"] = rel;
      }
      console.log(`  ↻ re-sourced ${label} → ${path.posix.basename(rel)}`);
    } catch (err) {
      console.warn(`  ✗ re-source failed for ${label} (${String(err.message || err).slice(0, 80)}) — video will be skipped at render`);
    }
  }
  // Credits may have changed — rebuild each caption's credit line.
  for (const v of videos) {
    const credits = [...new Set(v.segments.flatMap((s) => [s.aCredit, s.bCredit]).filter(Boolean))];
    v.caption = (v.caption || "").replace(/\n*📷[^\n]*$/u, "").trimEnd();
    if (credits.length) v.caption += `\n\n📷 ${credits.join(" · ")}`;
  }
}

await fs.writeFile(scriptsPath, JSON.stringify(videos, null, 2));
console.log(
  `\n✓ Director QC done — ${videos.length} video(s) approved` +
  (cut.size ? `, ${cut.size} cut` : "") +
  ` · visuals: ${visualsChecked} checked, ${visualsFailed} replaced`,
);
if (!videos.length) {
  console.error("Director cut every video — nothing left to produce.");
  process.exit(1);
}
