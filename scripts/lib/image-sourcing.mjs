// scripts/lib/image-sourcing.mjs
// Shared vision-gated media sourcing, extracted from generate-diff-images.mjs
// so any Techsplains pipeline (videos, the PDF course) can source at the same
// quality bar without duplicating this logic. Sources:
//   stockVideo     — Pexels Videos (moving clips for "did you know" slots)
//   openverseImage — Openverse CC photos (real photos: Flickr/Wikimedia; no
//                    key, 200 req/day; CC BY credits returned to the caller)
//   stockImage     — Pexels stock photos
//   genImage       — Vertex image gen (gemini-2.5-flash-image), last resort
//
// (Google Images via Custom Search was removed 2026-07: Google closed the
// Custom Search JSON API to new customers — every call 403s with "This
// project does not have the access", regardless of key/billing/API-enable.
// Existing customers must migrate off it by 2027-01-01 anyway. Openverse
// fills the "actual photo of the actual thing" role CSE used to.)

import fs from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { applyTechsplainsGcpEnv, TS_GCP } from "./techsplains.mjs";

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
// Fresh GCP projects get a low requests-per-minute quota on the image model —
// run sequentially and retry 429s with backoff rather than failing the slot.
// Both are env-tunable so a quota-heavy batch (e.g. a Tranzzie run with DYK
// slideshows) can raise the retry ceiling and pace requests to avoid 429s
// entirely; defaults keep existing callers (Techsplains, the course) unchanged.
const MAX_RETRIES = parseInt(process.env.DIFF_IMG_MAX_RETRIES || "5", 10);
// A 429 is a per-minute QUOTA, not a real failure — give it its own generous
// retry budget (separate from MAX_RETRIES for genuine errors) so a big batch is
// never dropped for quota; it just waits the quota out.
const QUOTA_MAX_RETRIES = parseInt(process.env.DIFF_IMG_QUOTA_RETRIES || "20", 10);
// Spacing between image-gen calls (ms). 0 = no pacing (default). The interval
// ADAPTS upward on every 429 (up to MAX_INTERVAL_MS, never shrinks within a
// run) so the batch converges to a rate the quota tolerates and STOPS tripping
// 429s for the rest of the run — this is what makes hefty batches finish.
const MIN_INTERVAL_MS = parseInt(process.env.DIFF_IMG_MIN_INTERVAL_MS || "0", 10);
const MAX_INTERVAL_MS = parseInt(process.env.DIFF_IMG_MAX_INTERVAL_MS || "30000", 10);
let curInterval = MIN_INTERVAL_MS; // module-global: the learned rate carries across the whole batch
let lastGenAt = 0;
async function paceGen() {
  if (curInterval <= 0) return;
  const waitFor = lastGenAt + curInterval - Date.now();
  if (waitFor > 0) await new Promise((r) => setTimeout(r, waitFor));
  lastGenAt = Date.now();
}
// Widen the global pace after a quota hit so subsequent calls stop tripping it.
function widenPaceAfterQuota() {
  curInterval = Math.min(MAX_INTERVAL_MS, Math.max(curInterval, 1500) * 1.5);
}

// GCP binding for the Vertex vision-gate (pickBest) and image-gen (genImage).
// DEFAULT = Techsplains' isolated project, so existing importers that don't
// configure (the PDF course pipeline) keep working exactly as before. A
// multi-brand caller (the video pipeline) calls configureImageGcp(cfg.gcp)
// FIRST to point these at the client's OWN project + credentials — otherwise a
// Tranzzie batch would authenticate/bill against Techsplains' project, breaking
// GCP isolation. The client is built lazily so a late configure() takes effect,
// and GoogleGenAI reads GOOGLE_APPLICATION_CREDENTIALS at construction time so
// `apply` must run immediately before it.
let _gcp = {
  project: TS_GCP.project,
  imageLocation: TS_GCP.imageLocation,
  apply: applyTechsplainsGcpEnv,
};
let _ai = null;
function getAi() {
  if (!_ai) {
    _gcp.apply?.();
    _ai = new GoogleGenAI({ vertexai: true, project: _gcp.project, location: _gcp.imageLocation });
  }
  return _ai;
}

// Repoint image gen + the vision-gate at a specific client's GCP. Pass the
// resolveDiffClient() gcp shape plus its applyGcpEnv: { project, imageLocation,
// apply }. Rebuilds the client on next use.
export function configureImageGcp({ project, imageLocation, apply } = {}) {
  _gcp = {
    project: project || TS_GCP.project,
    imageLocation: imageLocation || TS_GCP.imageLocation,
    apply: apply || applyTechsplainsGcpEnv,
  };
  _ai = null;
}

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
  const resp = await getAi().models.generateContent({
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

const OPENVERSE_UA = "techsplains-content-studio (villardejurie@gmail.com)";

// Openverse — free CC-licensed REAL photos (Flickr, Wikimedia Commons,
// museums) with no API key. The vision gate still decides whether any hit
// truly shows the subject. Returns { credit } on success (credit is "" for
// CC0/public-domain images, otherwise the attribution string the caption
// must carry), or null to fall through to the next source.
export async function openverseImage(query, label, otherLabel, usedIds, outAbs) {
  let json;
  try {
    const url =
      "https://api.openverse.org/v1/images/?q=" + encodeURIComponent(query) +
      "&categories=photograph&license=cc0,pdm,by,by-sa&filter_dead=true&page_size=8";
    const res = await fetch(url, {
      headers: { "User-Agent": OPENVERSE_UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = await res.json();
  } catch (err) {
    console.warn(`    openverse search failed (${String(err.message || err).slice(0, 60)})`);
    return null;
  }
  const candidates = (json.results || [])
    .filter((p) => p.width >= 700 && p.height >= 500 && !usedIds.has(p.id))
    .slice(0, 8);
  if (!candidates.length) return null;
  const thumbs = [];
  const valid = [];
  for (const p of candidates) {
    try {
      thumbs.push(await fetchBuf(p.thumbnail));
      valid.push(p);
    } catch { /* skip unfetchable */ }
  }
  let pick;
  try {
    pick = await pickBest(thumbs, label, query, otherLabel);
  } catch (err) {
    // Unlike Pexels there is no curation to fall back on — Openverse rank is
    // noisy (random Flickr uploads), so without the gate we skip the source.
    console.warn(`    vision gate failed (${String(err.message || err).slice(0, 50)}) — skipping openverse`);
    return null;
  }
  if (pick === -1) {
    console.log(`    vision gate: no Openverse hit clearly shows "${label}" — trying Pexels`);
    return null;
  }
  const photo = valid[pick];
  try {
    await fs.writeFile(outAbs, await fetchBuf(photo.url, 10000));
  } catch (err) {
    console.warn(`    openverse download failed (${String(err.message || err).slice(0, 60)})`);
    return null;
  }
  usedIds.add(photo.id);
  return /^(cc0|pdm)$/.test(photo.license)
    ? { credit: "" }
    : { credit: `${photo.creator || photo.source} (CC ${photo.license.toUpperCase()})` };
}

// Stock VIDEO for "did you know" slots — a moving clip beats a still card.
// Pexels Videos shares the photo API key; the vision gate runs on the poster
// frames. Returns { durationSec } on success, false to fall through to photos.
export async function stockVideo(query, label, usedIds, outAbs) {
  if (!PEXELS_KEY) return false;
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=8`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
  if (res.status === 429) throw new Error("Pexels rate limit (429)");
  if (!res.ok) throw new Error(`Pexels videos HTTP ${res.status}`);
  const json = await res.json();
  const candidates = (json.videos || [])
    .filter(
      (v) =>
        v.duration >= 4 && v.duration <= 60 &&
        Math.min(v.width, v.height) >= 700 && !usedIds.has(v.id),
    )
    .slice(0, 8);
  if (!candidates.length) return false;
  const thumbs = [];
  const valid = [];
  for (const v of candidates) {
    try {
      thumbs.push(await fetchBuf(v.image));
      valid.push(v);
    } catch { /* skip unfetchable */ }
  }
  let pick;
  try {
    pick = await pickBest(thumbs, label, query, "");
  } catch {
    pick = -1;
  }
  if (pick === -1) {
    console.log(`    vision gate: no stock CLIP clearly shows "${label}" — trying photos`);
    return false;
  }
  const video = valid[pick];
  // The render crops to the frame anyway — an ~1080p file is plenty; bigger
  // just slows the download and the render.
  const files = (video.video_files || []).filter((f) => (f.file_type || "").includes("mp4"));
  files.sort((a, b) => Math.abs((a.height || 0) - 1080) - Math.abs((b.height || 0) - 1080));
  const file = files[0];
  if (!file) return false;
  const vres = await fetch(file.link, { signal: AbortSignal.timeout(120000) });
  if (!vres.ok) throw new Error(`Pexels video download HTTP ${vres.status}`);
  await fs.writeFile(outAbs, Buffer.from(await vres.arrayBuffer()));
  usedIds.add(video.id);
  return { durationSec: video.duration };
}

export async function genImage(prompt, outAbs, fallbackPrompt) {
  let lastErr;
  let textOnlyCount = 0;
  let errAttempts = 0;   // genuine errors (503 / persistent no-image) — capped at MAX_RETRIES
  let quotaAttempts = 0; // 429 / RESOURCE_EXHAUSTED — its own generous budget
  for (;;) {
    // A prompt that keeps producing text-only replies is usually internally
    // contradictory (e.g. "binary code … no letters") — after two of those,
    // stop re-asking the impossible and switch to the simple label fallback.
    const usePrompt = textOnlyCount >= 2 && fallbackPrompt ? fallbackPrompt : prompt;
    // A caller can override the global look per run (e.g. a flat-vector or a
    // photoreal-product style for a specific brand batch). Defaults to
    // STYLE_TAIL so existing callers (Techsplains, the course) are unchanged.
    const styleTail = process.env.DIFF_IMAGE_STYLE_TAIL || STYLE_TAIL;
    try {
      await paceGen(); // proactively stay under the per-minute quota
      const resp = await getAi().models.generateContent({
        model: MODEL,
        contents: usePrompt + styleTail,
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
      const isQuota = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED");
      const isErr = msg.includes("no image in response") || msg.includes("503");
      if (isQuota) {
        // Quota: widen the pace for the rest of the batch and wait it out. The
        // slot is NOT dropped until the (large) quota budget is exhausted.
        quotaAttempts++;
        if (quotaAttempts > QUOTA_MAX_RETRIES) break;
        widenPaceAfterQuota();
        const wait = Math.min(MAX_INTERVAL_MS, 6000 * Math.min(6, quotaAttempts));
        console.log(`    …quota (429) — waiting ${(wait / 1000) | 0}s; pacing now ${(curInterval / 1000).toFixed(1)}s/img (${quotaAttempts}/${QUOTA_MAX_RETRIES})`);
        await sleep(wait);
      } else if (isErr) {
        errAttempts++;
        if (errAttempts > MAX_RETRIES) break;
        const wait = msg.includes("no image in response") ? 2000 : Math.min(60000, 8000 * 2 ** errAttempts);
        console.log(`    …retry ${errAttempts}/${MAX_RETRIES} in ${wait / 1000}s (${msg.slice(0, 50)})`);
        await sleep(wait);
      } else {
        break; // non-retryable
      }
    }
  }
  throw lastErr;
}
