// v3 — opposite intent from v2. The brand needs viewers to RECOGNIZE the
// actual Tranzzie clinic, so the reference photos are treated as ground
// truth, not inspiration. All 5 photos are passed in, and the prompt tells
// Gemini to faithfully replicate every visual identifier (signage, wall,
// LED strips, rack arrangement) so the clinic in the rendered shot is
// instantly recognizable as the real store.
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv } from "./lib/client.mjs";
applyGcpEnv();

const ROOT = "/Users/macbookpro/claude_code/research/remotion-app";
const JSON_PATH = ROOT + "/out/broll-2026-05-30T13-59.json";
const outDir = ROOT + "/public/broll-frames/broll-2026-05-30T13-59";
const data = JSON.parse(await fs.readFile(JSON_PATH, "utf-8"));

const TARGETS = new Set([2, 3, 4, 7, 10, 11, 14, 15, 21, 22, 25, 26, 42]);

const EXACT_MATCH_PREFIX = [
  "CLINIC LOCATION — EXACT REPLICATION REQUIRED:",
  "",
  "The 5 attached photos show the REAL Tranzzie Eyeglasses clinic in Manila. The generated image MUST visually replicate this exact clinic so viewers recognize the actual store. This is a marketing brand requirement — the clinic IS the subject of the brand identity.",
  "",
  "Replicate ALL of the following EXACTLY as seen in the references — do not stylize, simplify, or generalize any of these:",
  "",
  "1. SIGNAGE (when in frame): the illuminated white-channel-letter sign reading 'TRANZZIE EYEGLASSES' in the exact font shown — semi-condensed serif uppercase with subtle drop shadow, mounted on a horizontal canopy above the entrance. Above the letters: the gold laurel-and-eyeglasses crest logo — two stalks of golden laurel leaves curving inward to frame a stylized pair of black eyeglasses with a single yellow accent in the center of the bridge. Reproduce the logo and lettering accurately, NOT a generic optical-store sign.",
  "",
  "2. STALL FORMAT: the shop is inside a Manila shopping mall — narrow rectangular stall (~3m wide × ~6m deep). The exterior shot shows a 'STALL NO. 1B-11' identifier sign at the upper-right of the storefront. Other mall stalls and people are visible in the corridor.",
  "",
  "3. STOREFRONT ENTRY: glass-front facade with wooden-base rotating spinner display racks of eyeglass frames visible right at the entry threshold — these racks have wooden bases at waist height and the spinning wire rack rises above.",
  "",
  "4. INTERIOR SIDE WALLS: BOTH side walls have clear acrylic wall-mounted display shelving running floor to about 2m height, packed solid with dense rows of eyeglass frames — hundreds visible at any wide shot. White display backers are visible behind the acrylic.",
  "",
  "5. INTERIOR CENTER: multiple wooden-base rotating spinner display racks (matching the entry ones) holding more frames, distributed down the center of the narrow shop.",
  "",
  "6. BACK WALL: distinctive black diamond-quilted / tufted wallpaper (small diamond pattern with gold stitching/buttons at each intersection) covering the entire back wall. Centered on it: the gold TRANZZIE EYEGLASSES laurel-and-eyeglasses logo prominently illuminated. To the right of the logo: framed certificates / awards mounted on the wall.",
  "",
  "7. FLOOR: large white/cream square ceramic tiles, slightly polished.",
  "",
  "8. CEILING — distinctive signature features that MUST be visible:",
  "   - Round white LED downlights arranged across the ceiling.",
  "   - A long suspended white fluorescent strip light fixture running down the center.",
  "   - SIGNATURE: thin green AND pink LED accent strip lighting running along the ceiling edges and recessed coves — these strips produce visible GREEN and PINK colored light reflections on the ceiling surface and upper walls. Do NOT omit the colored LEDs — they are the most recognizable signature of this clinic and must always appear when ceiling is visible.",
  "",
  "9. RECEPTION AREA (right side near the back): small white reception counter with QR-code displays mounted on it; framed certificates / business permits on the wall behind. A small white cushioned bench beside it. A small standing pedestal fan often visible. A standing tripod ring light visible to one side (content creation gear).",
  "",
  "10. ATMOSPHERE: warm, busy, lived-in Manila mall optical shop — customers may be sitting on the bench, staff in dark/black shirts. NOT a sterile minimalist store, NOT a Western-style boutique optical chain.",
  "",
  "Match the EXACT physical clinic shown in the references. The generated image should be instantly recognizable as Tranzzie Eyeglasses by anyone who has visited it.",
  "",
  "Within this faithful location, render the shot per the brief below:",
  "",
].join("\n");

// Load character refs
const chars = JSON.parse(
  await fs.readFile(ROOT + "/config/characters.json", "utf-8"),
);
const ch = chars.find((c) => c.id === "char_jurie");
const charRefs = [];
for (const rel of (ch?.photos || []).slice(0, 3)) {
  const buf = await fs.readFile(ROOT + "/public/" + rel);
  const ext = path.extname(rel).slice(1).toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : "image/png";
  charRefs.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
}

// Load 5 individual clinic refs
const clinicRefs = [];
const clinicDir = ROOT + "/public/refs/tranzzie-clinic";
for (const f of (await fs.readdir(clinicDir))
  .filter((f) => /^clinic-\d+\.(jpg|jpeg|png|webp)$/i.test(f))
  .sort()) {
  const buf = await fs.readFile(path.join(clinicDir, f));
  const ext = path.extname(f).slice(1).toLowerCase();
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : "image/png";
  clinicRefs.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
}
console.log(`Loaded ${charRefs.length} char ref(s) + ${clinicRefs.length} clinic ref(s)`);

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = data.shots.filter((s) => TARGETS.has(s.n));
console.log(`Re-rendering ${shots.length} clinic-identity shot(s) — EXACT replication…\n`);

let ok = 0;
const fails = [];
for (let i = 0; i < shots.length; i++) {
  const s = shots[i];
  if (i > 0) await sleep(8000);
  const useChar = s.usesCharacter && charRefs.length > 0;
  const fullPrompt =
    EXACT_MATCH_PREFIX +
    s.imagePrompt +
    (useChar
      ? "\n\nCHARACTER REF: use the provided character reference photo (cap, rimless glasses, headphones, white tank top) to preserve the character's face, hair, wardrobe, and proportions exactly. The character is in this clinic — both the character AND the clinic must be faithful reproductions of the reference images."
      : "");
  // Order: clinic refs first (location ground truth), char refs, then prompt
  const parts = useChar
    ? [...clinicRefs, ...charRefs, { text: fullPrompt }]
    : [...clinicRefs, { text: fullPrompt }];

  let buf = null;
  let err = "";
  for (let a = 1; a <= 5 && !buf; a++) {
    try {
      const r = await ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [{ role: "user", parts }],
        config: { imageConfig: { aspectRatio: data.meta?.aspect || "9:16" } },
      });
      for (const p of r.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) {
          buf = Buffer.from(p.inlineData.data, "base64");
          break;
        }
      }
      if (!buf) err = "no image";
    } catch (e) {
      err = (e?.message || String(e)).slice(0, 120);
    }
    if (!buf && a < 5) {
      console.log(`  [${s.n}] retry ${a} — ${err.slice(0, 80)}`);
      await sleep(10000 * a);
    }
  }
  if (buf) {
    const fname = `shot-${String(s.n).padStart(2, "0")}.png`;
    // Keep the v2 (collage) as backup
    try {
      await fs.copyFile(
        outDir + "/" + fname,
        outDir + "/" + fname.replace(".png", ".clinic-v2.png"),
      );
    } catch {}
    await fs.writeFile(outDir + "/" + fname, buf);
    console.log(
      `  ✓ [${i + 1}/${shots.length}] ${fname}  (${(buf.length / 1024).toFixed(0)} KB)`,
    );
    ok++;
  } else {
    fails.push(s.n);
    console.log(`  ✗ shot ${s.n} gave up: ${err}`);
  }
}
console.log(
  `\n✓ Recovered ${ok}/${shots.length}. Failed: ${fails.join(", ") || "none"}`,
);
