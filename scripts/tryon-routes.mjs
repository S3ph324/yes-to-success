#!/usr/bin/env node
// /tryon sub-site — Tranzzie Virtual Try-On
//
// Routes:
//   GET  /tryon                   → Try-On UI page
//   GET  /api/tryon/version       → { version }
//   POST /api/tryon/validate      → validate uploaded glasses photo
//   POST /api/tryon/generate      → generate models (multi-bg, multi-angle)
//   GET  /api/tryon/batches       → Try-On library listing
//   GET  /tryon-lib/:stamp/:file  → serve library assets

import { GoogleGenAI } from "@google/genai";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { applyGcpEnv } from "./lib/client.mjs";

applyGcpEnv();

const __dirname  = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

export const TRYON_VERSION = "2.0.0";

const TEXT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const IMG_MODEL  = process.env.REF_MODEL    || "gemini-2.5-flash-image";

const mimeFor = (filename) => {
  const ext = (path.extname(filename) || ".jpg").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png")  return "image/png";
  return "image/jpeg";
};

const safeStamp = (s) => /^[0-9T\-]+$/.test(String(s || ""));

// ── multer ─────────────────────────────────────────────────────────────────
const UPLOAD_TMP = path.join("/tmp", "tryon-uploads");
const tryonUpload = multer({
  storage: multer.diskStorage({
    destination: async (_r, _f, cb) => {
      await fs.mkdir(UPLOAD_TMP, { recursive: true });
      cb(null, UPLOAD_TMP);
    },
    filename: (_r, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_r, file, cb) =>
    /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error("Images only")),
});

// ── Gemini ─────────────────────────────────────────────────────────────────
const aiClient = () => {
  const project  = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is not set.");
  return new GoogleGenAI({ vertexai: true, project, location });
};

async function genImage(ai, parts, aspectRatio = "3:4") {
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── In-memory session store ─────────────────────────────────────────────────
const uploadStore = new Map();
const UPLOAD_TTL  = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of uploadStore) if (now > v.expires) uploadStore.delete(k);
}, 5 * 60 * 1000);

// ── Prompt builders ─────────────────────────────────────────────────────────
const PERSON = {
  woman: "a young Filipina woman in her late 20s with natural warm skin tone, dark hair, and defined facial features",
  man:   "a young Filipino man in his late 20s with natural warm skin tone, dark hair, and strong facial features",
};

const ANGLE_DESC = {
  front:    "facing directly toward the camera, looking straight into the lens — full frontal, symmetric composition showing both lenses clearly",
  "3q-left":  "turned 40 degrees to their left (camera-right), a three-quarter profile that reveals the frame arm and shows how the glasses sit on the nose from a flattering angle — both eyes still visible",
  "3q-right": "turned 40 degrees to their right (camera-left), the opposite three-quarter profile angle showing the other side of the frame",
};

const BG_LABELS = {
  studio:     "Studio — White Background",
  indoor:     "Indoors — Clear Lenses",
  outdoor:    "Outdoors — Tinted Lenses",
  comparison: "Comparison — Indoor vs Outdoor",
};

function makePrompt(gender, bg, angle = "front") {
  const person     = PERSON[gender] || PERSON.woman;
  const angleTxt   = ANGLE_DESC[angle] || ANGLE_DESC.front;
  const frameNote  = "The eyeglasses in the reference image show the exact frame to reproduce — match the frame shape, color, material texture, and proportion as closely as possible. ";

  if (bg === "indoor") {
    return (
      `Candid, editorial lifestyle photograph of ${person} wearing photochromic eyeglasses inside a bright, modern café or stylish home interior. ` +
      frameNote +
      `The lenses are completely clear and transparent indoors — no tint whatsoever. ${angleTxt}. ` +
      `Natural window light from one side, warm ambient interior tones, shallow depth of field blurring the background softly. ` +
      `Person looks relaxed and natural — mid-activity, not posing stiffly. Authentic, candid feel. ` +
      `Shot on 35mm f/2.0 equivalent. Hyperrealistic, photographic quality, editorial lookbook standard.`
    );
  }
  if (bg === "outdoor") {
    return (
      `Candid outdoor lifestyle photograph of ${person} wearing photochromic eyeglasses in bright natural sunlight — on a modern city street or open park in the Philippines. ` +
      frameNote +
      `The photochromic lenses have darkened visibly in the sunlight to a warm medium tint, like light gradient sunglasses — this is clearly visible. ${angleTxt}. ` +
      `Natural midday or golden-hour sunlight, city or nature background softly blurred, person looks relaxed and confident, casual outfit. ` +
      `Shot on 50mm f/1.8. Authentic lifestyle photography quality, vivid but natural color grade, hyperrealistic.`
    );
  }
  // studio (default)
  return (
    `High-end eyewear lookbook portrait photograph of ${person} wearing the eyeglasses from the reference image. ` +
    frameNote +
    `${angleTxt}. Expression is calm, natural, and confident — not forced. ` +
    `Seamless neutral off-white studio backdrop. Soft-box key light with a subtle fill and gentle rim light giving definition to the face. ` +
    `Shot on Sony A7 IV with an 85mm f/1.8 portrait lens. Ultra-sharp detail on the glasses and facial features, beautifully soft background. ` +
    `Commercial eyewear photography quality, hyperrealistic, magazine-ready.`
  );
}

// ── Library save (async, non-blocking) ─────────────────────────────────────
async function saveLibraryBatch(libDir, stamp, meta, batches) {
  const files = [];
  for (const batch of batches) {
    if (batch.comparison) {
      for (const r of batch.results) {
        for (const side of ["indoor", "outdoor"]) {
          const dataUrl = side === "indoor" ? r.indoorUrl : r.outdoorUrl;
          if (!dataUrl) continue;
          const fn = `comparison-${r.gender}-${side}.png`;
          await fs.writeFile(path.join(libDir, fn),
            Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
          files.push(fn);
        }
      }
    } else if (batch.multiAngle) {
      for (const r of batch.results) {
        for (const ang of r.angles || []) {
          const slug = ang.view.toLowerCase().replace(/[^a-z0-9]/g, "-");
          const fn = `${batch.bg}-${r.gender}-${slug}.png`;
          await fs.writeFile(path.join(libDir, fn),
            Buffer.from(ang.dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
          files.push(fn);
        }
      }
    } else {
      for (const r of batch.results) {
        if (!r.dataUrl) continue;
        const fn = `${batch.bg}-${r.gender}.png`;
        await fs.writeFile(path.join(libDir, fn),
          Buffer.from(r.dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
        files.push(fn);
      }
    }
  }
  const manifest = {
    stamp,
    createdAt: new Date().toISOString(),
    description: meta.description,
    backgrounds: meta.backgrounds,
    multiAngle: meta.multiAngle,
    complete: true,
    files,
  };
  const glassesFile = (await fs.readdir(libDir)).find(f => f.startsWith("glasses"));
  if (glassesFile) manifest.glassesFile = glassesFile;
  await fs.writeFile(path.join(libDir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

// ── Routes ──────────────────────────────────────────────────────────────────
export function registerTryonRoutes(app, { EXPORT_BASE, guard }) {
  const TRYON_LIB = EXPORT_BASE
    ? path.join(EXPORT_BASE, "tryon")
    : path.join(projectRoot, "out", "tryon");

  // GET /tryon
  app.get("/tryon", (_req, res) => res.type("html").send(TRYON_PAGE));

  // GET /api/tryon/version
  app.get("/api/tryon/version", (_req, res) => res.json({ version: TRYON_VERSION }));

  // GET /api/tryon/batches — library listing
  app.get("/api/tryon/batches", async (_req, res) => {
    let stamps = [];
    try { stamps = (await fs.readdir(TRYON_LIB)).filter(safeStamp).sort().reverse(); }
    catch { return res.json([]); }
    const out = [];
    for (const stamp of stamps) {
      try {
        const man = JSON.parse(await fs.readFile(path.join(TRYON_LIB, stamp, "manifest.json"), "utf-8"));
        if (man.complete) out.push({ stamp, ...man });
      } catch { /* skip incomplete */ }
    }
    res.json(out);
  });

  // GET /tryon-lib/:stamp/:file — serve library assets
  app.get("/tryon-lib/:stamp/:file", (req, res) => {
    const { stamp, file } = req.params;
    if (!safeStamp(stamp) || !/^[\w.\-]+\.(png|jpg|jpeg|webp)$/.test(file))
      return res.status(400).end();
    const fp = path.join(TRYON_LIB, stamp, file);
    if (!fp.startsWith(TRYON_LIB)) return res.status(400).end();
    if (req.query.dl) res.set("Content-Disposition", `attachment; filename="${file}"`);
    res.sendFile(fp);
  });

  // POST /api/tryon/validate
  app.post("/api/tryon/validate", tryonUpload.single("photo"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const filePath = req.file.path;
    try {
      const imgBuf = await fs.readFile(filePath);
      const mime   = mimeFor(req.file.originalname || req.file.filename);
      const b64    = imgBuf.toString("base64");
      fs.unlink(filePath).catch(() => {});

      const resp = await aiClient().models.generateContent({
        model: TEXT_MODEL,
        contents: [{ role: "user", parts: [
          { inlineData: { mimeType: mime, data: b64 } },
          { text: `Analyze this image carefully.
Is it a clear, usable photograph of a pair of eyeglasses or spectacle frames?

VALID: full frame clearly visible, in focus, lighting shows color and shape.
INVALID: blurry, not glasses, partial view, packaging only, person wearing glasses, low light.

Respond ONLY with valid JSON — no markdown, no explanation outside JSON:
{
  "valid": true or false,
  "reason": "one sentence",
  "description": "2-3 sentences: frame shape, color, material (e.g. thick black acetate, thin rimless metal), bridge style, any notable details"
}` }
        ]}],
        config: { temperature: 0.1 },
      });

      let parsed = { valid: false, reason: "Could not analyze image." };
      try {
        const raw = resp.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { /* keep fallback */ }

      const token = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      uploadStore.set(token, { base64: b64, mime, expires: Date.now() + UPLOAD_TTL });
      res.json({ ...parsed, token, mime });
    } catch (err) {
      fs.unlink(filePath).catch(() => {});
      console.error("tryon/validate error:", err.message || err);
      res.status(500).json({ error: "Validation failed: " + (err.message || "unknown") });
    }
  });

  // POST /api/tryon/generate
  app.post("/api/tryon/generate", async (req, res) => {
    if (!guard(req, res)) return;
    const { token, description, backgrounds, multiAngle } = req.body || {};
    if (!token || !/^[\w.\-]+$/.test(token))
      return res.status(400).json({ error: "Invalid session. Please re-upload." });

    const stored = uploadStore.get(token);
    if (!stored || Date.now() > stored.expires) {
      uploadStore.delete(token);
      return res.status(400).json({ error: "Session expired (30 min). Please re-upload." });
    }

    const VALID_BGS = ["studio", "indoor", "outdoor", "comparison"];
    const bgs = (Array.isArray(backgrounds) ? backgrounds : [backgrounds || "studio"])
      .filter(b => VALID_BGS.includes(b));
    if (!bgs.length) bgs.push("studio");

    const isMultiAngle = multiAngle === true || multiAngle === "true";
    const angles = isMultiAngle ? ["front", "3q-left", "3q-right"] : ["front"];
    const frameDesc = (description || "stylish eyeglasses").slice(0, 300);
    const refPart   = { inlineData: { mimeType: stored.mime, data: stored.base64 } };

    // Save glasses photo to library before clearing session
    const stamp  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const libDir = path.join(TRYON_LIB, stamp);
    let libReady = false;
    try {
      await fs.mkdir(libDir, { recursive: true });
      const ext = stored.mime === "image/png" ? ".png" : stored.mime === "image/webp" ? ".webp" : ".jpg";
      await fs.writeFile(path.join(libDir, `glasses${ext}`), Buffer.from(stored.base64, "base64"));
      libReady = true;
    } catch (e) { console.warn("Library dir failed:", e.message); }

    uploadStore.delete(token); // single-use

    try {
      const resultBatches = [];

      for (const bg of bgs) {
        if (bg === "comparison") {
          const [womanIn, womanOut, manIn, manOut] = await Promise.all([
            genImage(aiClient(), [refPart, { text: makePrompt("woman", "indoor",  "front") }], "3:4"),
            genImage(aiClient(), [refPart, { text: makePrompt("woman", "outdoor", "front") }], "3:4"),
            genImage(aiClient(), [refPart, { text: makePrompt("man",   "indoor",  "front") }], "3:4"),
            genImage(aiClient(), [refPart, { text: makePrompt("man",   "outdoor", "front") }], "3:4"),
          ]);
          resultBatches.push({
            bg: "comparison", label: BG_LABELS.comparison, comparison: true,
            results: [
              { gender: "woman", label: "Female model",
                indoorUrl:  `data:image/png;base64,${womanIn.toString("base64")}`,
                outdoorUrl: `data:image/png;base64,${womanOut.toString("base64")}` },
              { gender: "man",   label: "Male model",
                indoorUrl:  `data:image/png;base64,${manIn.toString("base64")}`,
                outdoorUrl: `data:image/png;base64,${manOut.toString("base64")}` },
            ],
          });
        } else {
          // Generate all gender × angle combinations in parallel
          const tasks = [];
          for (const gender of ["woman", "man"])
            for (const angle of angles)
              tasks.push(genImage(aiClient(), [refPart, { text: makePrompt(gender, bg, angle) }], "3:4")
                .then(buf => ({ gender, angle, buf })));
          const generated = await Promise.all(tasks);

          // Group by gender
          const byGender = {};
          for (const { gender, angle, buf } of generated) {
            if (!byGender[gender]) byGender[gender] = {};
            byGender[gender][angle] = buf;
          }
          const ANGLE_LABEL = { front: "Front", "3q-left": "¾ Left", "3q-right": "¾ Right" };
          const results = [];
          for (const gender of ["woman", "man"]) {
            const label = gender === "woman" ? "Female model" : "Male model";
            if (isMultiAngle) {
              results.push({ gender, label, multiAngle: true,
                angles: angles.map(a => ({
                  view: ANGLE_LABEL[a],
                  dataUrl: `data:image/png;base64,${byGender[gender][a].toString("base64")}`,
                })) });
            } else {
              results.push({ gender, label,
                dataUrl: `data:image/png;base64,${byGender[gender]["front"].toString("base64")}` });
            }
          }
          resultBatches.push({ bg, label: BG_LABELS[bg], multiAngle: isMultiAngle, results });
        }
      }

      // Save batch to library (async, non-blocking)
      if (libReady) {
        saveLibraryBatch(libDir, stamp, { description: frameDesc, backgrounds: bgs, multiAngle: isMultiAngle }, resultBatches)
          .catch(e => console.warn("Library save:", e.message));
      }

      res.json({ ok: true, batches: resultBatches, stamp });
    } catch (err) {
      console.error("tryon/generate error:", err.message || err);
      res.status(500).json({ error: "Generation failed: " + (err.message || "unknown") });
    }
  });
}

// ── TRYON PAGE ──────────────────────────────────────────────────────────────
const TRYON_PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Virtual Try-On — Tranzzie Eyewear</title>
<style>
:root{--gold:#F4B400;--red:#E11522;--bg:#0a0a0b;--panel:#121214;
--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.18);--txt:#ededee;--mut:#7f7f87}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",Roboto,system-ui,sans-serif;
font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased;
background:radial-gradient(900px 600px at 10% -8%,rgba(244,180,0,.06),transparent 55%),var(--bg)}
header{padding:22px 28px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header a{color:var(--mut);font-size:12px;text-decoration:none;letter-spacing:.02em}
header a:hover{color:var(--txt)}
header .dot{width:8px;height:8px;border-radius:50%;background:var(--gold);box-shadow:0 0 10px rgba(244,180,0,.5);flex-shrink:0}
header h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.22em;text-transform:uppercase}
header .sp{flex:1}
main{max-width:900px;margin:0 auto;padding:36px 28px 72px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px 30px;margin-bottom:20px}
h2{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--mut)}
p.sub{margin:0 0 20px;color:var(--mut);font-size:13px;line-height:1.55}
.upload-area{border:2px dashed var(--line2);border-radius:12px;padding:40px 24px;text-align:center;cursor:pointer;
transition:border-color .18s,background .18s;position:relative}
.upload-area:hover,.upload-area.over{border-color:var(--gold);background:rgba(244,180,0,.04)}
.upload-area input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.upload-area .icon{font-size:36px;margin-bottom:10px;opacity:.5}
.upload-area b{display:block;font-size:14px;margin-bottom:4px}
.upload-area span{font-size:12px;color:var(--mut)}
#preview-wrap{display:none;margin-top:20px;text-align:center}
#preview-wrap img{max-height:260px;max-width:100%;border-radius:10px;border:1px solid var(--line2)}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
padding:6px 13px;border-radius:999px;margin-top:12px;letter-spacing:.02em}
.badge.ok{background:rgba(60,180,80,.15);color:#5be07e;border:1px solid rgba(60,180,80,.25)}
.badge.bad{background:rgba(224,86,75,.12);color:#ff8a82;border:1px solid rgba(224,86,75,.22)}
.badge.checking{background:rgba(244,180,0,.1);color:var(--gold);border:1px solid rgba(244,180,0,.2)}
#desc-box{display:none;margin-top:14px;padding:14px 16px;background:rgba(255,255,255,.03);
border:1px solid var(--line2);border-radius:9px;font-size:13px;line-height:1.55}
.opts-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:14px 0}
.opt-check{display:flex;align-items:flex-start;gap:9px;cursor:pointer;font-size:13px;
background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:9px;
padding:11px 13px;transition:border-color .14s,background .14s;line-height:1.4}
.opt-check:hover{border-color:var(--gold);background:rgba(244,180,0,.04)}
.opt-check input{margin:3px 0 0;flex-shrink:0;accent-color:var(--gold)}
.opt-check b{display:block;font-size:13px;color:var(--txt)}
.opt-check small{color:var(--mut);font-size:11px}
.ma-toggle{display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;
padding:12px 14px;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:9px;margin-bottom:16px;
transition:border-color .14s}
.ma-toggle:hover{border-color:var(--gold)}
.ma-toggle input{accent-color:var(--gold)}
button.go{background:var(--gold);color:#15120a;border:0;font-weight:700;font-size:13.5px;
padding:13px 26px;border-radius:10px;cursor:pointer;letter-spacing:.015em;transition:all .15s;
box-shadow:0 1px 0 rgba(255,255,255,.14) inset}
button.go:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(244,180,0,.28),0 1px 0 rgba(255,255,255,.18) inset}
button.go:active:not(:disabled){transform:translateY(0)}
button.go:disabled{opacity:.38;cursor:not-allowed}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(244,180,0,.3);
border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:7px}
@keyframes spin{to{transform:rotate(360deg)}}
.bg-section{margin-top:18px;border-top:1px solid var(--line);padding-top:18px}
.bg-section h3{font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);margin:0 0 14px}
.result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-top:12px}
.result-card{background:#0d0d0f;border:1px solid var(--line2);border-radius:12px;overflow:hidden;text-align:center}
.result-card img{width:100%;display:block;aspect-ratio:3/4;object-fit:cover}
.result-card.strip img{aspect-ratio:9/4}
.result-card .foot{padding:10px 13px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.result-card .lbl{font-size:11px;font-weight:600;color:var(--txt);letter-spacing:.04em;text-transform:uppercase}
.result-card a{font-size:11px;color:var(--gold);text-decoration:none;border:1px solid rgba(244,180,0,.3);
padding:4px 10px;border-radius:6px;font-weight:600;transition:all .14s}
.result-card a:hover{background:rgba(244,180,0,.1)}
.notice{font-size:11.5px;color:var(--mut);margin-top:14px;line-height:1.55;text-align:center}
#err-msg{color:#ff8a82;font-size:13px;margin-top:12px;display:none}
#gen-status{color:var(--mut);font-size:13px;margin-top:10px;display:none}
.lib-batch{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:20px}
.lib-batch:last-child{border-bottom:0;padding-bottom:0;margin-bottom:0}
.lib-header{display:flex;align-items:flex-start;gap:14px;margin-bottom:14px}
.lib-glasses{width:72px;height:72px;object-fit:contain;border:1px solid var(--line2);border-radius:8px;background:#0d0d0f;flex-shrink:0}
.lib-meta{flex:1;min-width:0}
.lib-date{font-size:12px;font-weight:600;color:var(--txt);margin-bottom:3px}
.lib-desc{font-size:11.5px;color:var(--mut);line-height:1.5}
.lib-imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.lib-imgs img{width:100%;border-radius:8px;border:1px solid var(--line);display:block;aspect-ratio:3/4;object-fit:cover;cursor:pointer;transition:border-color .14s}
.lib-imgs img:hover{border-color:var(--gold)}
.lib-imgs img.strip{aspect-ratio:9/4}
</style></head><body>
<header>
  <div class="dot"></div>
  <h1>Tranzzie — Virtual Try-On</h1>
  <span style="font-size:11px;color:var(--mut);letter-spacing:.04em">v${TRYON_VERSION}</span>
  <span class="sp"></span>
  <a href="/">← Studio</a>
</header>
<main>
  <div class="card">
    <h2>Upload Eyeglasses Photo</h2>
    <p class="sub">Upload a clear product shot of the frame. The AI validates it, then generates realistic model photos wearing that exact frame.</p>
    <div class="upload-area" id="drop-zone">
      <input type="file" id="photo-input" accept="image/*">
      <div class="icon">🕶️</div>
      <b>Click to upload or drag & drop</b>
      <span>JPG, PNG, WEBP — max 15 MB. Full frame must be clearly visible.</span>
    </div>
    <div id="preview-wrap">
      <img id="preview-img" src="" alt="preview">
      <div id="val-badge"></div>
      <div id="desc-box"></div>
    </div>
    <div id="err-msg"></div>
  </div>

  <div class="card" id="options-card" style="display:none">
    <h2>Generation Options</h2>

    <label class="ma-toggle">
      <input type="checkbox" id="multi-angle">
      <span>
        <b>Multi-angle collage</b> — generates Front, ¾ Left, and ¾ Right views composited into a side-by-side strip
        <br><small style="color:var(--mut)">3× more API calls per background — takes longer but shows the full frame from every angle</small>
      </span>
    </label>

    <div class="bg-section">
      <h3>Backgrounds — select one or more</h3>
      <div class="opts-grid">
        <label class="opt-check">
          <input type="checkbox" name="bg" value="studio" checked>
          <span><b>🤍 Studio</b><small>Clean white backdrop, soft-box lighting — ideal for catalogue</small></span>
        </label>
        <label class="opt-check">
          <input type="checkbox" name="bg" value="indoor">
          <span><b>🏠 Indoors</b><small>Café or office — lenses appear completely clear (photochromic feature)</small></span>
        </label>
        <label class="opt-check">
          <input type="checkbox" name="bg" value="outdoor">
          <span><b>☀️ Outdoors</b><small>Sunlit street or park — lenses visibly tinted (photochromic feature)</small></span>
        </label>
        <label class="opt-check">
          <input type="checkbox" name="bg" value="comparison">
          <span><b>⚡ Comparison</b><small>Side-by-side indoor (clear) vs outdoor (tinted) — best photochromic demo</small></span>
        </label>
      </div>
    </div>

    <p style="margin:18px 0 0;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <button class="go" id="gen-btn" disabled>Generate Try-On Photos</button>
      <span id="img-count" style="font-size:12px;color:var(--mut)"></span>
    </p>
    <div id="gen-status"></div>
    <div id="results-section" style="display:none;margin-top:20px"></div>
  </div>

  <div class="card" id="library-card" style="display:none">
    <h2>Try-On Library</h2>
    <p class="sub" style="margin-bottom:18px">Previously generated batches — each grouped by the glasses frame used.</p>
    <div id="library-body"></div>
  </div>
</main>

<script>
const $=s=>document.querySelector(s);
const $$=s=>Array.from(document.querySelectorAll(s));
let validToken=null,validMime=null,validDesc=null;
const _FMON=['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtTs(s){
  const m=s.match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})/);
  if(!m)return s;
  const yr=+m[1],mo=+m[2]-1,dy=+m[3],hr=+m[4],mn=+m[5];
  const h=hr%12||12,ap=hr<12?'AM':'PM';
  return _FMON[mo]+' '+dy+', '+yr+' \xb7 '+h+':'+(mn<10?'0':'')+mn+' '+ap;
}

function setBadge(state,text){const b=$('#val-badge');if(!b)return;
  b.innerHTML=state?'<span class="badge '+state+'">'+text+'</span>':'';}
function setErr(msg){const e=$('#err-msg');if(!e)return;e.textContent=msg||'';e.style.display=msg?'block':'none';}
function setGenStatus(msg){const s=$('#gen-status');if(!s)return;s.innerHTML=msg||'';s.style.display=msg?'block':'none';}

function updateImgCount(){
  const bgs=$$('input[name="bg"]:checked').map(x=>x.value);
  const ma=$('#multi-angle')?.checked;
  let calls=0;
  bgs.forEach(b=>{
    if(b==='comparison') calls+=4;
    else calls+=ma?6:2;
  });
  const el=$('#img-count');
  if(el) el.textContent=calls?calls+' image'+(calls===1?'':'s')+' will be generated'+( calls>6?' — may take 60–120s':''):'';
}

$$('input[name="bg"]').forEach(x=>x.onchange=updateImgCount);
$('#multi-angle').onchange=updateImgCount;
updateImgCount();

async function validate(file){
  validToken=null;validDesc=null;
  $('#gen-btn').disabled=true;
  setBadge('checking','<span class="spinner"></span> Checking image…');
  setErr('');
  const fd=new FormData();fd.append('photo',file);
  try{
    const r=await fetch('/api/tryon/validate',{method:'POST',body:fd});
    const d=await r.json();
    if(!r.ok||d.error){setBadge('bad','&#x2717; '+(d.error||'Error'));setErr(d.error||'Validation error.');return;}
    if(!d.valid){setBadge('bad','&#x2717; Not a clear glasses photo');setErr(d.reason||'Please upload a clearer shot of the frame.');return;}
    setBadge('ok','&#x2713; Clear shot detected');
    validToken=d.token;validMime=d.mime;validDesc=d.description||'';
    if(validDesc){$('#desc-box').textContent='Frame detected: '+validDesc;$('#desc-box').style.display='block';}
    $('#options-card').style.display='block';
    $('#gen-btn').disabled=false;
  }catch(e){setBadge('bad','&#x2717; Error');setErr('Could not reach server. Try again.');}
}

$('#photo-input').onchange=e=>{
  const f=e.target.files[0];if(!f)return;
  $('#preview-img').src=URL.createObjectURL(f);
  $('#preview-wrap').style.display='block';
  $('#options-card').style.display='none';
  $('#results-section').style.display='none';
  $('#results-section').innerHTML='';
  setBadge('','');$('#desc-box').style.display='none';$('#desc-box').textContent='';setGenStatus('');
  validate(f);
};
const dz=$('#drop-zone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
dz.addEventListener('drop',e=>{
  e.preventDefault();dz.classList.remove('over');
  const f=e.dataTransfer.files[0];if(!f||!/^image\\//.test(f.type))return;
  const dt=new DataTransfer();dt.items.add(f);
  $('#photo-input').files=dt.files;
  $('#preview-img').src=URL.createObjectURL(f);
  $('#preview-wrap').style.display='block';
  $('#options-card').style.display='none';
  $('#results-section').style.display='none';
  setBadge('','');$('#desc-box').style.display='none';setGenStatus('');
  validate(f);
});

// ── Canvas compositors ──────────────────────────────────────────────────────
function compositeStrip(dataUrls,labels){
  return new Promise(resolve=>{
    const imgs=dataUrls.map(u=>{const i=new Image();i.src=u;return i;});
    let loaded=0;
    imgs.forEach(i=>i.onload=()=>{
      if(++loaded<imgs.length)return;
      const W=imgs[0].width,H=imgs[0].height,N=imgs.length;
      const c=document.createElement('canvas');c.width=W*N;c.height=H;
      const ctx=c.getContext('2d');
      imgs.forEach((img,idx)=>{
        ctx.drawImage(img,idx*W,0,W,H);
        // divider
        if(idx>0){ctx.strokeStyle='rgba(255,255,255,0.6)';ctx.lineWidth=2;
          ctx.beginPath();ctx.moveTo(idx*W,0);ctx.lineTo(idx*W,H);ctx.stroke();}
        // label bar
        const lh=Math.round(H*0.06);
        ctx.fillStyle='rgba(0,0,0,0.65)';ctx.fillRect(idx*W,H-lh,W,lh);
        const fs=Math.round(lh*0.44);
        ctx.fillStyle='#F4B400';ctx.textAlign='center';ctx.font='600 '+fs+'px system-ui,sans-serif';
        ctx.fillText(labels[idx]||'',idx*W+W/2,H-Math.round(lh*0.28));
      });
      resolve(c.toDataURL('image/png'));
    });
  });
}
function compositeCompare(item){
  return compositeStrip([item.indoorUrl,item.outdoorUrl],['INDOORS — Clear','OUTDOORS — Tinted']);
}

// ── Render results ──────────────────────────────────────────────────────────
async function renderResults(data){
  const wrap=$('#results-section');if(!wrap)return;
  wrap.style.display='block';
  let html='';
  for(const batch of (data.batches||[])){
    html+='<div class="bg-section"><h3>'+batch.label+'</h3>';
    if(batch.comparison){
      // composite and render
      const cards=await Promise.all((batch.results||[]).map(async item=>{
        const du=await compositeCompare(item);
        const fn=(item.gender==='woman'?'female':'male')+'-comparison.png';
        return '<div class="result-card strip"><img src="'+du+'"><div class="foot">'
          +'<span class="lbl">'+item.label+'</span>'
          +'<a href="'+du+'" download="'+fn+'">Download</a></div></div>';
      }));
      html+='<div class="result-grid">'+cards.join('')+'</div>';
    } else if(batch.multiAngle){
      const cards=await Promise.all((batch.results||[]).map(async r=>{
        const urls=r.angles.map(a=>a.dataUrl);
        const labels=r.angles.map(a=>a.view);
        const composite=await compositeStrip(urls,labels);
        const fn=(r.gender==='woman'?'female':'male')+'-'+batch.bg+'-angles.png';
        return '<div class="result-card strip"><img src="'+composite+'"><div class="foot">'
          +'<span class="lbl">'+r.label+'</span>'
          +'<a href="'+composite+'" download="'+fn+'">Download strip</a></div></div>';
      }));
      html+='<div class="result-grid">'+cards.join('')+'</div>';
    } else {
      const cards=(batch.results||[]).map(r=>{
        const fn=(r.gender==='woman'?'female':'male')+'-'+batch.bg+'.png';
        return '<div class="result-card"><img src="'+r.dataUrl+'"><div class="foot">'
          +'<span class="lbl">'+r.label+'</span>'
          +'<a href="'+r.dataUrl+'" download="'+fn+'">Download</a></div></div>';
      });
      html+='<div class="result-grid">'+cards.join('')+'</div>';
    }
    html+='</div>';
  }
  html+='<p class="notice">&#9888; AI-generated images. Frame design is approximated from your reference photo.</p>';
  wrap.innerHTML=html;
  wrap.scrollIntoView({behavior:'smooth',block:'start'});
}

// ── Generate ────────────────────────────────────────────────────────────────
$('#gen-btn').onclick=async()=>{
  if(!validToken)return;
  const bgs=$$('input[name="bg"]:checked').map(x=>x.value);
  if(!bgs.length){setErr('Select at least one background option.');return;}
  const ma=$('#multi-angle').checked;
  $('#gen-btn').disabled=true;setErr('');
  let calls=0;bgs.forEach(b=>{calls+=b==='comparison'?4:ma?6:2;});
  setGenStatus('<span class="spinner"></span> Generating '+calls+' image'+(calls===1?'':'s')+'… '+(calls>6?'this may take 60–120s.':'this takes 20–40s.'));
  try{
    const r=await fetch('/api/tryon/generate',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:validToken,description:validDesc,backgrounds:bgs,multiAngle:ma})});
    const d=await r.json();
    if(!r.ok||d.error){setErr(d.error||'Generation failed.');setGenStatus('');$('#gen-btn').disabled=false;return;}
    setGenStatus('');
    await renderResults(d);
    $( '#gen-btn').disabled=false;
    loadLibrary();
  }catch(e){setErr('Network error. Try again.');setGenStatus('');$('#gen-btn').disabled=false;}
};

// ── Library ─────────────────────────────────────────────────────────────────
async function loadLibrary(){
  try{
    const batches=await fetch('/api/tryon/batches').then(r=>r.json());
    if(!batches.length){$('#library-card').style.display='none';return;}
    $('#library-card').style.display='block';
    let html='';
    for(const b of batches){
      const glassesUrl=b.glassesFile?'/tryon-lib/'+encodeURIComponent(b.stamp)+'/'+encodeURIComponent(b.glassesFile):'';
      const thumbHtml=glassesUrl
        ?'<img class="lib-glasses" src="'+glassesUrl+'" alt="frame" onerror="this.style.display=\\'none\\'">'
        :'<div class="lib-glasses" style="display:flex;align-items:center;justify-content:center;font-size:22px">🕶️</div>';
      const bgsLabel=(b.backgrounds||[]).map(x=>{
        const m={'studio':'Studio','indoor':'Indoors','outdoor':'Outdoors','comparison':'Comparison'};
        return m[x]||x;}).join(', ');
      html+='<div class="lib-batch">'
        +'<div class="lib-header">'+thumbHtml
        +'<div class="lib-meta">'
        +'<div class="lib-date">'+fmtTs(b.stamp)+'</div>'
        +'<div class="lib-desc">'+(b.description||'').slice(0,120)+(( b.description||'').length>120?'…':'')+'</div>'
        +'<div style="font-size:11px;color:var(--mut);margin-top:4px">'+bgsLabel+(b.multiAngle?' \xb7 Multi-angle':'')+'</div>'
        +'</div></div>'
        +'<div class="lib-imgs">'
        +(b.files||[]).map(f=>{
          const u='/tryon-lib/'+encodeURIComponent(b.stamp)+'/'+encodeURIComponent(f);
          const isStrip=f.indexOf('-angles')>-1||f.indexOf('comparison-')>-1;
          return '<img src="'+u+'" class="'+(isStrip?'strip':'')+'" onclick="window.open(this.src)" loading="lazy" title="'+f+'">';
        }).join('')
        +'</div>'
        +'</div>';
    }
    $('#library-body').innerHTML=html;
  }catch(e){/* silently skip */}
}
loadLibrary();
</script></body></html>`;
