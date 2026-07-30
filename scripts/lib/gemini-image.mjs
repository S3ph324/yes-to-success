// Gemini image generation for carousel slides, billed to the client's own GCP
// project instead of Higgsfield credits.
//
// WHY THE VERIFICATION LOOP EXISTS: gemini-2.5-flash-image renders Tagalog
// unreliably. Across three identical test renders it produced "nagsistulma"
// and "nagsislulma" for *nagsisimula*, and "blankong" for *blangkong* — 3/3
// runs had at least one error, and instructing it to "spell every word exactly
// as given" did not fix it. Misspelled Tagalog on a published carousel is
// worse than a slightly less polished render, so every slide is read back and
// re-rendered until the text actually matches.
//
// Higgsfield's Nano Banana 2 got the same copy right every time, so it remains
// the better choice where a retry is expensive (see lib/higgsfield.mjs).

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

export const GEMINI_IMAGE_MODEL = process.env.CAROUSEL_IMAGE_MODEL || "gemini-2.5-flash-image";
const READBACK_MODEL = process.env.CAROUSEL_READBACK_MODEL || "gemini-2.5-flash";

const clientFor = (project, location) =>
  new GoogleGenAI({ vertexai: true, project, location: location || "us-central1" });

const imageFromResponse = (resp) => {
  for (const p of resp?.candidates?.[0]?.content?.parts || []) {
    if (p.inlineData?.data) return Buffer.from(p.inlineData.data, "base64");
  }
  return null;
};

/** One raw generation. Returns a PNG/JPEG buffer. */
export async function genImage({ prompt, aspect = "4:5", refs = [], project, location }) {
  const ai = clientFor(project, location);
  const parts = [];
  for (const r of refs.filter(Boolean)) {
    try {
      const buf = await fs.readFile(r);
      const ext = path.extname(r).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      parts.push({ inlineData: { mimeType, data: buf.toString("base64") } });
    } catch { /* skip unreadable reference */ }
  }
  parts.push({ text: prompt });
  const resp = await ai.models.generateContent({
    model: GEMINI_IMAGE_MODEL,
    contents: [{ role: "user", parts }],
    config: { imageConfig: { aspectRatio: aspect } },
  });
  const buf = imageFromResponse(resp);
  if (!buf) throw new Error("Gemini returned no image.");
  return buf;
}

// Compare what was asked for against what actually got rendered. Deliberately
// forgiving about case, punctuation and line breaks — a render is only wrong
// if the LETTERS differ, which is exactly what the Tagalog failures were.
const normalize = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

/** Ask Gemini to transcribe every piece of text it can see in the image. */
export async function readBackText(buf, { project, location } = {}) {
  const ai = clientFor(project, location);
  const resp = await ai.models.generateContent({
    model: READBACK_MODEL,
    contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: buf.toString("base64") } },
      { text: "Transcribe EVERY piece of text visible in this image, exactly as rendered, " +
              "including any misspellings. Do not correct anything. Return one JSON array of strings." },
    ] }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  try {
    const arr = JSON.parse(resp.text || "[]");
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch { return []; }
}

/**
 * Generate, then verify the rendered text really says what it should, retrying
 * on mismatch.
 * @param {string[]} expect strings that MUST appear verbatim in the render
 * @returns {Promise<{buf:Buffer, attempts:number, verified:boolean, missing:string[]}>}
 */
export async function genVerified({
  prompt, expect = [], aspect = "4:5", refs = [], project, location, maxAttempts = 3, log = () => {},
}) {
  // Only bother checking strings long enough to be meaningful — a stray "01"
  // or "2/5" is not worth a re-render.
  const targets = expect.map((e) => String(e || "").trim()).filter((e) => e.length >= 12);
  let last = null;
  let lastMissing = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const buf = await genImage({ prompt, aspect, refs, project, location });
    last = buf;
    if (!targets.length) return { buf, attempts: attempt, verified: true, missing: [] };
    const seen = normalize((await readBackText(buf, { project, location })).join(" "));
    const missing = targets.filter((t) => !seen.includes(normalize(t)));
    lastMissing = missing;
    if (!missing.length) return { buf, attempts: attempt, verified: true, missing: [] };
    log(`      text check failed (attempt ${attempt}/${maxAttempts}): ${missing.map((m) => `"${m.slice(0, 40)}"`).join(", ")}`);
  }
  // Hand back the last attempt rather than nothing — a slightly-wrong slide the
  // user can see and reject beats an empty carousel.
  return { buf: last, attempts: maxAttempts, verified: false, missing: lastMissing };
}
