// AI product-placement scene generation for the TikTok Shop cards.
//
// Takes the seller's uploaded eyeglasses-frame photo(s) as a REFERENCE and uses
// Gemini image (gemini-2.5-flash-image / "Nano Banana") to generate clean
// product-placement scenes of the SAME EXACT frame — a white studio shot, a
// lifestyle flat-lay, and a dark macro close-up — which the ShopListingCard
// then brands. The frame being sold must not be altered, so every prompt locks
// the product to the reference.
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";

const mimeFor = (p) => {
  const e = (path.extname(p) || "").toLowerCase();
  return e === ".png" ? "image/png" : e === ".webp" ? "image/webp" : e === ".heic" || e === ".heif" ? "image/heic" : "image/jpeg";
};

// Hard product-fidelity lock appended to every scene prompt.
const FRAME_LOCK =
  " CRITICAL — the eyeglasses are a REAL product being sold: reproduce the EXACT " +
  "pair shown in the reference photo(s). The frame shape, colour, material, rim " +
  "thickness, temples, hinges and every detail must match the reference EXACTLY. " +
  "Do NOT redesign, recolour, restyle, swap, or invent a different pair. " +
  "No people, no faces, no hands, no mannequins. " +
  "Absolutely NO text, letters, numbers, logos, labels or watermarks anywhere. " +
  "Photorealistic commercial product photography, ultra-clean, sharp, high detail, 1:1 square.";

export const SHOP_SCENES = {
  // Used by the hero + variant cards (clean cutout-style product on white).
  clean:
    "Premium studio product photograph: the eyeglasses LARGE and centred, filling " +
    "most of the frame, on a deep charcoal / near-black seamless studio backdrop, " +
    "dramatic soft key lighting with subtle reflections and a gentle shadow " +
    "beneath, slight three-quarter angle. Moody, high-end, cinematic catalogue " +
    "hero shot." + FRAME_LOCK,
  // Dark moody lifestyle flat-lay for the studio card.
  life:
    "Premium lifestyle flat-lay product photograph: the eyeglasses resting at a " +
    "natural angle on a dark slate or dark wood surface beside a minimal eyewear " +
    "case, low-key moody lighting, deep soft shadows, elegant dark palette." + FRAME_LOCK,
  // Dark dramatic macro for the detail card.
  dark:
    "Dramatic macro close-up product photograph: the eyeglasses on a dark charcoal " +
    "slate surface, the temple and hinge in sharp focus, moody directional rim " +
    "lighting with subtle reflections, high-end and premium." + FRAME_LOCK,
  // Clean marketplace hero — front-on, fully visible, plain WHITE background.
  // The classic online-store / TikTok-Shop main listing image.
  front:
    "Clean e-commerce catalogue HERO product photograph: the eyeglasses shown " +
    "perfectly FRONT-ON and fully open, standing upright and facing the camera, " +
    "so BOTH lenses and the COMPLETE frame outline are entirely visible, " +
    "symmetric and unobstructed — nothing cropped or cut off. Centered on a PURE " +
    "PLAIN WHITE seamless studio background, bright soft even high-key lighting, a " +
    "soft natural shadow directly beneath the frame, the whole product crisp and " +
    "in sharp focus. Exactly like an online-store / marketplace product listing " +
    "main image." + FRAME_LOCK,
};

// Generate the requested scenes. Returns a map { key: absPath } for the scenes
// that succeeded; callers fall back to the raw upload for any that didn't.
export async function generateShopScenes({
  refPaths, project, location, outDir, keys = ["clean", "life", "dark"], log = () => {},
}) {
  const refParts = [];
  for (const p of (refPaths || []).slice(0, 3)) {
    try {
      const buf = await fs.readFile(p);
      refParts.push({ inlineData: { mimeType: mimeFor(p), data: buf.toString("base64") } });
    } catch { /* skip unreadable ref */ }
  }
  if (!refParts.length) throw new Error("no readable reference photos");

  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const model = process.env.REF_MODEL || "gemini-2.5-flash-image";
  await fs.mkdir(outDir, { recursive: true });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const out = {};
  for (const key of keys) {
    const prompt = SHOP_SCENES[key];
    if (!prompt) continue;
    let buf = null;
    for (let attempt = 1; attempt <= 2 && !buf; attempt++) {
      try {
        const t0 = Date.now();
        const resp = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts: [...refParts, { text: prompt }] }],
          config: { imageConfig: { aspectRatio: "1:1" } },
        });
        const parts = resp.candidates?.[0]?.content?.parts || [];
        for (const pt of parts) if (pt.inlineData?.data) { buf = Buffer.from(pt.inlineData.data, "base64"); break; }
        if (!buf) throw new Error("no image in response");
        log(`  ✓ scene '${key}' (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (e) {
        log(`  scene '${key}' attempt ${attempt}: ${String(e?.message || e).slice(0, 120)}`);
        if (attempt < 2) await delay(4000);
      }
    }
    if (buf) {
      const fp = path.join(outDir, `${key}.png`);
      await fs.writeFile(fp, buf);
      out[key] = fp;
    }
  }
  return out;
}
