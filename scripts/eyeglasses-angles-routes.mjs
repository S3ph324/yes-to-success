#!/usr/bin/env node
// Eyeglasses reference-set generator (Tranzzie Eyeglasses tab).
//
// Lets the user upload ONE photo of a frame and have Gemini generate
// additional angle views of that SAME pair, compiled into a collage for
// review. The user can Approve (saves the set as a new/updated frame's
// reference photos), Regenerate (try again), or Cancel (discard).
//
// This deliberately reuses the EXISTING /api/eyeglasses + /api/eyeglasses/photo
// routes for the actual save step (the frontend posts the approved images
// through them as normal uploads) — this file only adds the
// validate → generate review loop in front of that.
//
// Routes:
//   POST /api/eyeglasses/angles/validate  → validate uploaded photo is a clear frame shot
//   POST /api/eyeglasses/angles/generate  → generate N additional angle views (data URLs)

import { GoogleGenAI } from "@google/genai";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import heicConvert from "heic-convert";
import { applyGcpEnv } from "./lib/client.mjs";

applyGcpEnv();

const TEXT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const IMG_MODEL  = process.env.REF_MODEL    || "gemini-2.5-flash-image";

const mimeFor = (filename) => {
  const ext = (path.extname(filename) || ".jpg").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png")  return "image/png";
  if (ext === ".heic") return "image/heic";
  if (ext === ".heif") return "image/heif";
  return "image/jpeg";
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const aiClient = () => {
  const project  = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is not set.");
  return new GoogleGenAI({ vertexai: true, project, location });
};

async function genImage(ai, parts, aspectRatio = "1:1") {
  let buf = null, lastErr = "";
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: IMG_MODEL,
        contents: [{ role: "user", parts }],
        config: { imageConfig: { aspectRatio } },
      });
      for (const p of resp.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) { buf = Buffer.from(p.inlineData.data, "base64"); break; }
      }
      if (!buf) { lastErr = "no image in response"; if (attempt < 3) await delay(2500 * attempt); }
    } catch (err) {
      lastErr = err?.message?.slice(0, 200) || String(err);
      if (attempt < 3) await delay(2500 * attempt);
    }
  }
  if (!buf) throw new Error(`Image generation failed after 3 attempts: ${lastErr}`);
  return buf;
}

// ── In-memory session store (mirrors tryon-routes.mjs) ──────────────────────
const uploadStore = new Map();
const UPLOAD_TTL  = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of uploadStore) if (now > v.expires) uploadStore.delete(k);
}, 5 * 60 * 1000);

// ── Angle prompts ────────────────────────────────────────────────────────────
// Product-only shots — no person, no hands, no props. The whole point is to
// give the renderer multiple CLEAN angles of the SAME physical product to
// anchor on, matching the framing/background style of a real catalogue shot
// (and of generate-backgrounds-jurie.mjs's reference usage downstream).
const FRAME_LOCK =
  "This must be the EXACT SAME pair of eyeglasses shown in the reference " +
  "image — identical frame shape, color, material, texture, lens tint, " +
  "hinge style, and every design detail. Do not redesign, restyle, or " +
  "substitute any element. ";

const ANGLES = [
  {
    key: "three_quarter",
    label: "¾ Angle",
    desc:
      "Photograph it from a 3/4 angle, turned roughly 35-40 degrees so the " +
      "front of the frame and one temple arm are both clearly visible.",
  },
  {
    key: "side_profile",
    label: "Side Profile",
    desc:
      "Photograph it in a direct side profile view, showing the temple arm, " +
      "hinge, and the silhouette of the frame from the side.",
  },
];

function makeAnglePrompt(angle) {
  return (
    `Clean studio product photograph of a pair of eyeglasses. ${FRAME_LOCK}` +
    `${angle.desc} ` +
    "Place it on a plain seamless white or very light neutral surface (or " +
    "floating against a seamless light backdrop), soft even studio lighting " +
    "from the front-top, sharp focus across the entire frame, no people, no " +
    "hands, no props, no text, no logos, no watermarks, no reflections " +
    "obscuring the product. Commercial e-commerce / catalogue product " +
    "photography quality, hyperrealistic, neutral color balance."
  );
}

// ── Routes ──────────────────────────────────────────────────────────────────
export function registerEyeglassAngleRoutes(app, { guard }) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_r, file, cb) =>
      /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error("Images only")),
  });

  // POST /api/eyeglasses/angles/validate
  app.post("/api/eyeglasses/angles/validate", upload.single("photo"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    try {
      const mime = mimeFor(req.file.originalname || "photo.jpg");
      const b64  = req.file.buffer.toString("base64");

      const resp = await aiClient().models.generateContent({
        model: TEXT_MODEL,
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType: mime, data: b64 } },
          { text: `Analyze this image carefully.
Is it a clear, usable photograph of a pair of eyeglasses or spectacle frames
(the actual product — not a person wearing them, not packaging-only)?

VALID: full frame clearly visible, in focus, lighting shows true color and shape.
INVALID: blurry, not glasses, partial/cropped view, packaging only, low light,
mostly obscured by a hand or person's face.

Respond ONLY with valid JSON — no markdown, no explanation outside JSON:
{
  "valid": true or false,
  "reason": "one sentence",
  "description": "2-3 sentences: frame shape, color, material (e.g. thick black acetate, thin rimless metal), bridge style, any notable details"
}` },
        ]}],
        config: { temperature: 0.1 },
      });

      let parsed = { valid: false, reason: "Could not analyze image." };
      try {
        const raw = resp.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { /* keep fallback */ }

      const token = `ea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      uploadStore.set(token, {
        base64: b64,
        mime,
        originalName: req.file.originalname || "photo.jpg",
        expires: Date.now() + UPLOAD_TTL,
      });
      res.json({ ...parsed, token, mime });
    } catch (err) {
      console.error("eyeglasses/angles/validate error:", err.message || err);
      res.status(500).json({ error: "Validation failed: " + (err.message || "unknown") });
    }
  });

  // POST /api/eyeglasses/angles/generate
  // Body: { token, description } → { ok, original: {dataUrl,label}, angles: [{key,label,dataUrl}] }
  // Re-runnable (Regenerate) — does NOT consume the token, so the user can
  // try again against the same uploaded original without re-uploading.
  app.post("/api/eyeglasses/angles/generate", async (req, res) => {
    if (!guard(req, res)) return;
    const { token, description } = req.body || {};
    if (!token || !/^[\w.\-]+$/.test(token))
      return res.status(400).json({ error: "Invalid session. Please re-upload." });
    const stored = uploadStore.get(token);
    if (!stored || Date.now() > stored.expires) {
      uploadStore.delete(token);
      return res.status(400).json({ error: "Session expired (30 min). Please re-upload." });
    }

    const refPart = { inlineData: { mimeType: stored.mime, data: stored.base64 } };
    const descNote = description ? ` Reference description: ${String(description).slice(0, 240)}.` : "";

    try {
      const ai = aiClient();
      const generated = await Promise.all(
        ANGLES.map((angle) =>
          genImage(ai, [refPart, { text: makeAnglePrompt(angle) + descNote }], "1:1")
            .then((buf) => ({
              key: angle.key,
              label: angle.label,
              dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
            })),
        ),
      );
      // Browsers other than Safari can't decode HEIC/HEIF in <img>/Image() —
      // sending the raw HEIC bytes back as the "original" preview makes the
      // client-side collage compositor hang forever waiting for an onload
      // that will never fire (symptom: stuck on "Compiling collage…").
      // Convert to JPEG for display purposes only — the AI generation above
      // already used the original HEIC bytes (Gemini supports them natively).
      let originalMime = stored.mime;
      let originalB64 = stored.base64;
      if (/^image\/hei[cf]$/i.test(stored.mime)) {
        try {
          const out = await heicConvert({
            buffer: Buffer.from(stored.base64, "base64"),
            format: "JPEG",
            quality: 0.9,
          });
          originalMime = "image/jpeg";
          originalB64 = Buffer.from(out).toString("base64");
        } catch (err) {
          console.warn(`  HEIC preview convert failed: ${err?.message || err}`);
          // fall through with the original HEIC bytes — the client-side
          // onerror safety net will surface a clear error instead of hanging
        }
      }

      res.json({
        ok: true,
        original: {
          label: "Original",
          dataUrl: `data:${originalMime};base64,${originalB64}`,
        },
        angles: generated,
      });
    } catch (err) {
      console.error("eyeglasses/angles/generate error:", err.message || err);
      res.status(500).json({ error: "Generation failed: " + (err.message || "unknown") });
    }
  });
}
