// scripts/lib/image-sourcing.mjs
// Shared vision-gated image sourcing (Pexels → Gemini AI fallback),
// extracted from generate-diff-images.mjs so any Techsplains pipeline
// (videos, the PDF course) can source images at the same quality bar
// without duplicating this logic.
//
// (Google Images via Custom Search was removed 2026-07: Google closed the
// Custom Search JSON API to new customers — every call 403s with "This
// project does not have the access", regardless of key/billing/API-enable.
// Existing customers must migrate off it by 2027-01-01 anyway.)

import fs from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { applyTechsplainsGcpEnv, TS_GCP } from "./techsplains.mjs";

// Must run before constructing the client below — an importer of this
// module may not have called this itself yet, and GoogleGenAI reads
// GOOGLE_APPLICATION_CREDENTIALS at construction time.
applyTechsplainsGcpEnv();

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
// Fresh GCP projects get a low requests-per-minute quota on the image model —
// run sequentially and retry 429s with backoff rather than failing the slot.
const MAX_RETRIES = 5;

const ai = new GoogleGenAI({
  vertexai: true,
  project: TS_GCP.project,
  location: TS_GCP.imageLocation,
});

export const STYLE_TAIL =
  " Vertical-friendly square composition, subject fills the frame, bright and " +
  "clear at thumbnail size. No text, no words, no letters, no watermark, no logos.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Image sources: Pexels stock → AI generation ─────────────────────────────
const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
let warnedNoPexels = false;

// Vision gate: image search ranks by popularity, not accuracy — Pexels' first
// hit for "lavalier microphone" was a handheld Shure. Show the candidate
// thumbnails to gemini-2.5-flash and let it pick the one that actually
// depicts the thing; -1 means none qualify and the caller falls through.
export async function pickBest(thumbBufs, label, query, otherLabel) {
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

export const fetchBuf = async (url, minBytes = 1) => {
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

export async function stockImage(query, label, otherLabel, usedIds, outAbs) {
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

export async function genImage(prompt, outAbs, fallbackPrompt) {
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
