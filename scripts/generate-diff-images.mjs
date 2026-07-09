#!/usr/bin/env node
// Techsplains step 2/4 — source the two comparison images per segment
// (4 per video). REAL STOCK PHOTOS first (Pexels search on the script's
// searchQuery — the user rejected AI-rendered examples); Vertex image gen
// (gemini-2.5-flash-image) only as the fallback when the stock search misses.
//
// Usage:
//   PEXELS_API_KEY=... node scripts/generate-diff-images.mjs <scripts.json>
//
// Writes images to public/generated-diff/<stamp>/ and adds aImg/bImg (paths
// relative to public/) to each segment in the JSON, in place.

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./lib/client.mjs";
import { applyTechsplainsGcpEnv, TS_GCP } from "./lib/techsplains.mjs";

applyTechsplainsGcpEnv();

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
// Fresh GCP projects get a low requests-per-minute quota on the image model —
// run sequentially and retry 429s with backoff rather than failing the slot.
const CONCURRENCY = parseInt(process.env.TECHSPLAINS_IMG_CONCURRENCY || "1", 10);
const MAX_RETRIES = 5;

const scriptsArg = process.argv[2];
if (!scriptsArg) {
  console.error("Usage: node scripts/generate-diff-images.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

// Batch stamp from the scripts filename so all steps share one folder name.
const stamp =
  scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] ||
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const relDir = path.posix.join("generated-diff", stamp);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const ai = new GoogleGenAI({
  vertexai: true,
  project: TS_GCP.project,
  location: TS_GCP.imageLocation,
});

const STYLE_TAIL =
  " Vertical-friendly square composition, subject fills the frame, bright and " +
  "clear at thumbnail size. No text, no words, no letters, no watermark, no logos.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Image sources: Google Images (CSE) → Pexels → AI generation ─────────────
const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const CSE_KEY = process.env.GOOGLE_CSE_KEY || "";
const CSE_ID = process.env.GOOGLE_CSE_ID || "";
let warnedNoPexels = false;
let warnedNoCse = false;

// Vision gate: image search ranks by popularity, not accuracy — Pexels' first
// hit for "lavalier microphone" was a handheld Shure. Show the candidate
// thumbnails to gemini-2.5-flash and let it pick the one that actually
// depicts the thing; -1 means none qualify and the caller falls through.
async function pickBest(thumbBufs, label, query, otherLabel) {
  const parts = thumbBufs.map((buf) => ({
    inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") },
  }));
  if (!parts.length) return -1;
  parts.push({
    text:
      `These ${parts.length} photos are numbered 1..${parts.length} in order. ` +
      `Which one best and unmistakably shows: "${label}" (search was "${query}")? ` +
      `Requirements, in priority order: ` +
      `(1) it actually depicts that specific thing — not a related or similar-looking object` +
      (otherLabel
        ? `, and NOT a ${otherLabel} (the video contrasts the two) or anything mistakable for one`
        : "") +
      `; (2) it reads like an OBVIOUS textbook/stock example: bright, simple, ` +
      `subject clear and centered, instantly readable at thumbnail size. ` +
      `Visible stock-site watermarks are perfectly acceptable. ` +
      `Reject moody, dark, artistic, heavily blurred, or cluttered shots even if the subject is right. ` +
      `Reply with ONLY the number, or NONE if none clearly qualifies.`,
  });
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
  });
  const answer = (resp.text || "").trim().toUpperCase();
  const n = parseInt(answer, 10);
  return Number.isInteger(n) && n >= 1 && n <= thumbBufs.length ? n - 1 : -1;
}

const fetchBuf = async (url, minBytes = 1) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`not an image (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error("too small");
  return buf;
};

// Google Images via Custom Search — the "obvious stock example" look the
// user asked for (Glipo-style, watermarked previews welcome). Primary source.
async function googleImage(query, label, otherLabel, usedIds, outAbs) {
  if (!CSE_KEY || !CSE_ID) {
    if (!warnedNoCse) {
      console.warn("  GOOGLE_CSE_KEY/GOOGLE_CSE_ID not set — skipping Google Images source.");
      warnedNoCse = true;
    }
    return false;
  }
  const url =
    `https://customsearch.googleapis.com/customsearch/v1?key=${CSE_KEY}&cx=${CSE_ID}` +
    `&q=${encodeURIComponent(query)}&searchType=image&num=8&imgSize=LARGE&safe=active`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CSE HTTP ${res.status}: ${(await res.text()).slice(0, 100)}`);
  const json = await res.json();
  const items = (json.items || []).filter((it) => it.link && !usedIds.has(it.link));
  if (!items.length) return false;
  // Gate on Google's cached thumbnails (always fetchable, tiny).
  const thumbs = [];
  const valid = [];
  for (const it of items) {
    try {
      thumbs.push(await fetchBuf(it.image?.thumbnailLink || it.link));
      valid.push(it);
    } catch { /* skip unfetchable */ }
  }
  const pick = await pickBest(thumbs, label, query, otherLabel);
  if (pick === -1) {
    console.log(`    vision gate: no Google Images hit clearly shows "${label}"`);
    return false;
  }
  // Download the picked full-size image; hotlink-protected hosts are common,
  // so on failure fall through to the Pexels source rather than fighting it.
  try {
    const buf = await fetchBuf(valid[pick].link, 15000);
    await fs.writeFile(outAbs, buf);
    usedIds.add(valid[pick].link);
    return true;
  } catch (err) {
    console.log(`    google full-size download failed (${String(err.message || err).slice(0, 50)})`);
    return false;
  }
}

async function stockImage(query, label, otherLabel, usedIds, outAbs) {
  if (!PEXELS_KEY) {
    if (!warnedNoPexels) {
      console.warn("  PEXELS_API_KEY not set — falling back to AI image generation for ALL slots.");
      warnedNoPexels = true;
    }
    return false;
  }
  // Two searches: a "white background"-biased one for basic catalog shots,
  // then the plain query. Pexels ranks artsy/editorial photos first, which
  // the user rejected — the biased query surfaces plainer product shots.
  const collected = [];
  const seen = new Set();
  for (const q of [`${query} white background`, query]) {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=8&orientation=square`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (res.status === 429) throw new Error("Pexels rate limit (429)");
    if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
    const json = await res.json();
    for (const p of json.photos || []) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        collected.push(p);
      }
    }
  }
  // Never reuse a photo already placed in this video — related search queries
  // (ring light / softbox) can rank the same popular photo first for both.
  const candidates = collected.filter(
    (p) => p.width >= 900 && p.height >= 900 && !usedIds.has(p.id),
  ).slice(0, 8);
  if (!candidates.length) return false;
  let pick;
  try {
    const thumbs = [];
    const valid = [];
    for (const p of candidates) {
      try {
        thumbs.push(await fetchBuf(p.src.medium || p.src.small));
        valid.push(p);
      } catch { /* skip unfetchable */ }
    }
    pick = await pickBest(thumbs, label, query, otherLabel);
    if (pick === -1) {
      console.log(`    vision gate: no Pexels hit actually shows "${label}" — AI fallback`);
      return false;
    }
    candidates.length = 0;
    candidates.push(...valid);
  } catch (err) {
    console.warn(`    vision gate failed (${String(err.message || err).slice(0, 50)}) — using first result`);
    pick = 0;
  }
  const photo = candidates[pick];
  const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`Pexels download HTTP ${imgRes.status}`);
  await fs.writeFile(outAbs, Buffer.from(await imgRes.arrayBuffer()));
  usedIds.add(photo.id);
  return true;
}

async function genImage(prompt, outAbs, fallbackPrompt) {
  let lastErr;
  let textOnlyCount = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // A prompt that keeps producing text-only replies is usually internally
    // contradictory (e.g. "binary code … no letters") — after two of those,
    // stop re-asking the impossible and switch to the simple label fallback.
    const usePrompt = textOnlyCount >= 2 && fallbackPrompt ? fallbackPrompt : prompt;
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: usePrompt + STYLE_TAIL,
        config: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const parts = resp.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          await fs.writeFile(outAbs, Buffer.from(p.inlineData.data, "base64"));
          return true;
        }
      }
      textOnlyCount++;
      throw new Error("no image in response");
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      const retryable = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("no image in response") || msg.includes("503");
      if (!retryable || attempt === MAX_RETRIES) break;
      const wait = msg.includes("no image in response")
        ? 2000
        : Math.min(60000, 8000 * 2 ** attempt);
      console.log(`    …retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s (${msg.slice(0, 60)})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Flatten all slots, run with bounded concurrency (same idea as poster-batch).
const jobs = [];
videos.forEach((v, vi) => {
  v.segments.forEach((s, si) => {
    jobs.push({ v, s, vi, si, side: "a", prompt: s.aImagePrompt, query: s.aSearchQuery });
    // "didyouknow" segments are single-image: no B side.
    if (s.bLabel) jobs.push({ v, s, vi, si, side: "b", prompt: s.bImagePrompt, query: s.bSearchQuery });
  });
});

console.log(
  `Sourcing ${jobs.length} comparison image(s) — Pexels stock${PEXELS_KEY ? "" : " (NO KEY)"} → ${MODEL} fallback…`,
);
let done = 0;
let failed = 0;
let cursor = 0;
const usedByVideo = new Map();
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const base = `${String(job.vi + 1).padStart(2, "0")}-${job.si + 1}${job.side}`;
    const label = job.side === "a" ? job.s.aLabel : job.s.bLabel;
    const otherLabel = job.side === "a" ? job.s.bLabel : job.s.aLabel;
    if (!usedByVideo.has(job.vi)) usedByVideo.set(job.vi, new Set());
    const usedIds = usedByVideo.get(job.vi);
    // Context matters: without it the model illustrates the WORD, not the
    // concept — "Thunderbolt" (the port) came back as a storm cloud.
    const fallback =
      `clean minimal flat illustration representing "${label}" in the context of ` +
      `"${job.v.title}" (a ${job.v.category} explainer video). Depict the actual ` +
      `tech concept, never the literal/weather/food meaning of the word. ` +
      `Single centered subject, friendly and clear.`;
    // Resume support: a slot that already generated (path in JSON + file on
    // disk) is skipped, so quota-starved reruns only pay for the gaps.
    const existingRel = job.s[job.side === "a" ? "aImg" : "bImg"];
    if (existingRel) {
      try {
        await fs.access(path.join(projectRoot, "public", existingRel));
        done++;
        console.log(`  [${done + failed}/${jobs.length}] SKIP ${base} (already sourced)`);
        continue;
      } catch { /* file gone — regenerate */ }
    }
    try {
      // Source order: Google Images (obvious textbook examples, watermarks
      // fine) → Pexels stock → AI generation.
      let rel;
      let source = "";
      const stockOut = path.join(absDir, `${base}.jpg`);
      try {
        if (await googleImage(job.query || label, label, otherLabel, usedIds, stockOut))
          source = "google";
      } catch (err) {
        console.warn(`    google search failed (${String(err.message || err).slice(0, 60)})`);
      }
      if (!source) {
        try {
          if (await stockImage(job.query || label, label, otherLabel, usedIds, stockOut))
            source = "pexels";
        } catch (err) {
          console.warn(`    pexels search failed (${String(err.message || err).slice(0, 60)})`);
        }
      }
      if (source) {
        rel = path.posix.join(relDir, `${base}.jpg`);
      } else {
        await genImage(job.prompt, path.join(absDir, `${base}.png`), fallback);
        rel = path.posix.join(relDir, `${base}.png`);
        source = "AI";
      }
      job.s[job.side === "a" ? "aImg" : "bImg"] = rel;
      done++;
      console.log(`  [${done + failed}/${jobs.length}] ${path.posix.basename(rel)} [${source}]  (${job.v.title} — ${label})`);
    } catch (err) {
      failed++;
      console.warn(`  [${done + failed}/${jobs.length}] FAILED ${base}: ${String(err.message || err).slice(0, 140)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await fs.writeFile(scriptsPath, JSON.stringify(videos, null, 2));
console.log(`\n✓ ${done}/${jobs.length} image(s) → public/${relDir}`);
if (failed) console.log(`  (${failed} failed — render step will skip incomplete videos)`);
