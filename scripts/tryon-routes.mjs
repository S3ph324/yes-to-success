#!/usr/bin/env node
// /tryon sub-site — Tranzzie Virtual Try-On
//
// Customers upload a product photo of an eyeglasses frame → the system
// validates it's a clear shot → generates 2 model photos (woman + man)
// wearing that frame. Customer-service tool: helps answer "what does this
// frame look like when worn?"
//
// Routes registered:
//   GET  /tryon                   → try-on UI page
//   POST /api/tryon/validate      → validate uploaded glasses photo
//   POST /api/tryon/generate      → generate woman + man wearing the frame
//   GET  /tryon-asset/:file       → serve generated result images

import { GoogleGenAI } from "@google/genai";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv } from "./lib/client.mjs";

applyGcpEnv();

const TEXT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const IMG_MODEL  = process.env.REF_MODEL    || "gemini-2.5-flash-image";

const mimeFor = (filename) => {
  const ext = (path.extname(filename) || ".jpg").toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".png")  return "image/png";
  return "image/jpeg";
};

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
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_r, file, cb) =>
    /^image\//.test(file.mimetype) ? cb(null, true) : cb(new Error("Images only")),
});

// ── helpers ────────────────────────────────────────────────────────────────
const aiClient = () => {
  const project  = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is not set.");
  return new GoogleGenAI({ vertexai: true, project, location });
};

// Generate one image; returns a Buffer or null. Retries up to 3 times.
async function genImage(ai, parts, aspectRatio = "3:4") {
  let buf = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: IMG_MODEL,
        contents: [{ role: "user", parts }],
        config: { imageConfig: { aspectRatio } },
      });
      for (const p of resp.candidates?.[0]?.content?.parts || []) {
        if (p.inlineData?.data) {
          buf = Buffer.from(p.inlineData.data, "base64");
          break;
        }
      }
      if (!buf) {
        lastErr = "no image in response";
        if (attempt < 3) await delay(2500 * attempt);
      }
    } catch (err) {
      lastErr = err?.message?.slice(0, 200) || String(err);
      if (attempt < 3) await delay(2500 * attempt);
    }
  }
  if (!buf) throw new Error(`Image generation failed after 3 attempts: ${lastErr}`);
  return buf;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── in-memory upload store (avoids all disk writes between validate+generate)
// token → { base64, mime, expires }. Expires after 30 min; pruned every 5 min.
const uploadStore = new Map();
const UPLOAD_TTL = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of uploadStore) if (now > v.expires) uploadStore.delete(k);
}, 5 * 60 * 1000);

// ── route registrar ────────────────────────────────────────────────────────
export function registerTryonRoutes(app, { EXPORT_BASE, guard }) {
  // No TRYON_OUT directory needed — results are returned as base64 data URIs.

  // ── GET /tryon — UI page ─────────────────────────────────────────────────
  app.get("/tryon", (_req, res) => res.type("html").send(TRYON_PAGE));

  // ── POST /api/tryon/validate ─────────────────────────────────────────────
  app.post("/api/tryon/validate", tryonUpload.single("photo"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No image uploaded." });
    const filePath = req.file.path;
    try {
      const imgBuf = await fs.readFile(filePath);
      const mime   = mimeFor(req.file.originalname || req.file.filename);
      const b64    = imgBuf.toString("base64");

      // Delete from disk immediately — we store in memory instead.
      fs.unlink(filePath).catch(() => {});

      const ai = aiClient();
      const resp = await ai.models.generateContent({
        model: TEXT_MODEL,
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: b64 } },
            { text: `Analyze this image carefully.
Is it a clear, usable photograph of a pair of eyeglasses or spectacle frames?

A VALID image must show:
- The full eyeglass frame clearly visible (not cropped)
- Sufficient focus so the frame design is identifiable
- Enough lighting to see the frame color and shape

An INVALID image would be: blurry, not glasses, only a partial view, packaging/box only, a person already wearing glasses (we need the frame alone or flat-lay), low light, etc.

Respond ONLY with valid JSON — no markdown fences, no extra text:
{
  "valid": true,
  "reason": "one sentence",
  "description": "2-3 sentences: frame shape (e.g. rectangular, round, cat-eye), color, material appearance (e.g. thick black acetate, thin metal), any notable details like nose bridge or temple style"
}` }
          ],
        }],
        config: { temperature: 0.1 },
      });

      let parsed = { valid: false, reason: "Could not analyze image." };
      try {
        const raw = resp.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        parsed = JSON.parse(raw.replace(/```json\n?|\n?```/g, "").trim());
      } catch { /* keep fallback */ }

      // Store in memory (not disk) so generate can use it without disk I/O.
      const token = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      uploadStore.set(token, { base64: b64, mime, expires: Date.now() + UPLOAD_TTL });

      res.json({ ...parsed, token, mime });
    } catch (err) {
      fs.unlink(filePath).catch(() => {});
      console.error("tryon/validate error:", err.message || err);
      res.status(500).json({ error: "Validation failed: " + (err.message || "unknown") });
    }
  });

  // ── POST /api/tryon/generate ─────────────────────────────────────────────
  app.post("/api/tryon/generate", async (req, res) => {
    if (!guard(req, res)) return;
    const { token, description } = req.body || {};
    if (!token || !/^[\w.\-]+$/.test(token))
      return res.status(400).json({ error: "Invalid session. Please re-upload the photo." });

    // Read from memory store — no disk read needed.
    const stored = uploadStore.get(token);
    if (!stored || Date.now() > stored.expires) {
      uploadStore.delete(token);
      return res.status(400).json({ error: "Session expired (30 min limit). Please re-upload." });
    }
    uploadStore.delete(token); // single-use — clear immediately

    const frameDesc = (description || "stylish eyeglass frames").slice(0, 300);
    const refPart   = { inlineData: { mimeType: stored.mime, data: stored.base64 } };

    const makePrompt = (gender) => {
      const model = gender === "woman"
        ? "young Filipino woman in her late 20s"
        : "young Filipino man in his late 20s";
      return (
        `Professional studio portrait photograph of a ${model} wearing eyeglasses. ` +
        `The glasses in the reference image show the frame to use: ${frameDesc}. ` +
        `Reproduce the frame shape, color, and style as closely as possible. ` +
        `Model looks directly at camera, natural confident expression, slight smile. ` +
        `Clean white or light-gray studio background, soft even lighting, ` +
        `portrait crop from shoulders up. Photorealistic, sharp, high quality.`
      );
    };

    try {
      // Generate both in parallel — results returned as base64 data URIs,
      // no disk writes at all (fixes ENOSPC on Railway /tmp).
      const [womanBuf, manBuf] = await Promise.all([
        genImage(aiClient(), [refPart, { text: makePrompt("woman") }], "3:4"),
        genImage(aiClient(), [refPart, { text: makePrompt("man")   }], "3:4"),
      ]);

      res.json({
        ok: true,
        results: [
          { gender: "woman", label: "Female model", dataUrl: `data:image/png;base64,${womanBuf.toString("base64")}` },
          { gender: "man",   label: "Male model",   dataUrl: `data:image/png;base64,${manBuf.toString("base64")}` },
        ],
      });
    } catch (err) {
      console.error("tryon/generate error:", err.message || err);
      res.status(500).json({ error: "Generation failed: " + (err.message || "unknown") });
    }
  });
}

// ── TRYON PAGE ─────────────────────────────────────────────────────────────
const TRYON_PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Virtual Try-On — Tranzzie Eyewear</title>
<style>
:root{--gold:#F4B400;--gold2:#ffe27a;--red:#E11522;--bg:#0a0a0b;--panel:#121214;
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
header h1{margin:0;font-size:13px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--txt)}
header .sp{flex:1}
main{max-width:820px;margin:0 auto;padding:36px 28px 72px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px 30px;margin-bottom:20px}
h2{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--mut)}
p.sub{margin:0 0 22px;color:var(--mut);font-size:13px;line-height:1.55}
.upload-area{border:2px dashed var(--line2);border-radius:12px;padding:40px 24px;text-align:center;cursor:pointer;
transition:border-color .18s,background .18s;position:relative}
.upload-area:hover,.upload-area.over{border-color:var(--gold);background:rgba(244,180,0,.04)}
.upload-area input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.upload-area .icon{font-size:36px;margin-bottom:10px;opacity:.5}
.upload-area b{display:block;font-size:14px;margin-bottom:4px}
.upload-area span{font-size:12px;color:var(--mut)}
#preview-wrap{display:none;margin-top:20px;text-align:center}
#preview-wrap img{max-height:280px;max-width:100%;border-radius:10px;border:1px solid var(--line2)}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
padding:6px 13px;border-radius:999px;margin-top:12px;letter-spacing:.02em}
.badge.ok{background:rgba(60,180,80,.15);color:#5be07e;border:1px solid rgba(60,180,80,.25)}
.badge.bad{background:rgba(224,86,75,.12);color:#ff8a82;border:1px solid rgba(224,86,75,.22)}
.badge.checking{background:rgba(244,180,0,.1);color:var(--gold);border:1px solid rgba(244,180,0,.2)}
#desc-box{display:none;margin-top:14px;padding:14px 16px;background:rgba(255,255,255,.03);
border:1px solid var(--line2);border-radius:9px;font-size:13px;color:var(--txt);line-height:1.55}
button.go{background:var(--gold);color:#15120a;border:0;font-weight:700;font-size:13.5px;
padding:13px 26px;border-radius:10px;cursor:pointer;letter-spacing:.015em;
transition:all .15s;box-shadow:0 1px 0 rgba(255,255,255,.14) inset}
button.go:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 18px rgba(244,180,0,.28),0 1px 0 rgba(255,255,255,.18) inset}
button.go:active:not(:disabled){transform:translateY(0)}
button.go:disabled{opacity:.38;cursor:not-allowed}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(244,180,0,.3);
border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:7px}
@keyframes spin{to{transform:rotate(360deg)}}
.results-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:8px}
@media(max-width:540px){.results-grid{grid-template-columns:1fr}}
.result-card{background:#0d0d0f;border:1px solid var(--line2);border-radius:12px;overflow:hidden;text-align:center}
.result-card img{width:100%;display:block;aspect-ratio:3/4;object-fit:cover}
.result-card .foot{padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.result-card .lbl{font-size:12px;font-weight:600;color:var(--txt);letter-spacing:.04em;text-transform:uppercase}
.result-card a{font-size:11px;color:var(--gold);text-decoration:none;border:1px solid rgba(244,180,0,.3);
padding:5px 11px;border-radius:7px;font-weight:600;transition:all .14s}
.result-card a:hover{background:rgba(244,180,0,.1)}
.notice{font-size:11.5px;color:var(--mut);margin-top:14px;line-height:1.55;text-align:center}
#err-msg{color:#ff8a82;font-size:13px;margin-top:12px;display:none}
#gen-status{color:var(--mut);font-size:13px;margin-top:10px;display:none}
</style></head><body>
<header>
  <div class="dot"></div>
  <h1>Tranzzie — Virtual Try-On</h1>
  <span class="sp"></span>
  <a href="/">← Studio</a>
</header>
<main>
  <div class="card">
    <h2>Upload Eyeglasses Photo</h2>
    <p class="sub">Upload a clear product photo of the eyeglasses frame. The AI will check if the shot is usable, then generate photos of a woman and man wearing that exact frame — so you can show customers how it looks when worn.</p>
    <div class="upload-area" id="drop-zone">
      <input type="file" id="photo-input" accept="image/*">
      <div class="icon">🕶️</div>
      <b>Click to upload or drag & drop</b>
      <span>JPG, PNG, WEBP — max 15 MB. Frame must be clearly visible.</span>
    </div>
    <div id="preview-wrap">
      <img id="preview-img" src="" alt="preview">
      <div id="val-badge"></div>
      <div id="desc-box"></div>
    </div>
    <div id="err-msg"></div>
    <p style="margin:18px 0 0">
      <button class="go" id="gen-btn" disabled>Generate Try-On Photos</button>
    </p>
    <div id="gen-status"></div>
  </div>

  <div id="results-section" style="display:none">
    <div class="card">
      <h2>Generated Try-On Photos</h2>
      <p class="sub">AI-generated previews — frame design may vary slightly. For illustration purposes only.</p>
      <div class="results-grid" id="results-grid"></div>
      <p class="notice">⚠ These are AI-generated images. The frame shape and style are approximated from your reference photo. Always verify with the actual product before confirming with customers.</p>
    </div>
  </div>
</main>

<script>
const $=s=>document.querySelector(s);
let validToken=null, validMime=null, validDesc=null;

function setBadge(state, text) {
  const b=$('#val-badge');
  if(!b) return;
  if(!state){ b.innerHTML=''; return; }
  b.innerHTML='<span class="badge '+state+'">'+text+'</span>';
}
function setErr(msg) {
  const e=$('#err-msg'); if(!e) return;
  e.textContent=msg||''; e.style.display=msg?'block':'none';
}
function setGenStatus(msg) {
  const s=$('#gen-status'); if(!s) return;
  s.innerHTML=msg||''; s.style.display=msg?'block':'none';
}

async function validate(file) {
  validToken=null; validDesc=null;
  $('#gen-btn').disabled=true;
  setBadge('checking','<span class="spinner"></span> Checking image…');
  setErr('');
  const fd=new FormData(); fd.append('photo', file);
  try {
    const r=await fetch('/api/tryon/validate',{method:'POST',body:fd});
    const d=await r.json();
    if(!r.ok||d.error){ setBadge('bad','✗ '+( d.error||'Error')); setErr(d.error||'Validation error.'); return; }
    if(!d.valid){
      setBadge('bad','✗ Not a clear glasses photo');
      setErr(d.reason||'Please upload a clearer photo of the frame.');
      return;
    }
    setBadge('ok','✓ Clear shot detected');
    validToken=d.token; validMime=d.mime; validDesc=d.description||'';
    if(validDesc){ $('#desc-box').textContent='Frame detected: '+validDesc; $('#desc-box').style.display='block'; }
    $('#gen-btn').disabled=false;
  } catch(e){ setBadge('bad','✗ Error'); setErr('Could not reach server. Try again.'); }
}

$('#photo-input').onchange=e=>{
  const f=e.target.files[0]; if(!f) return;
  const url=URL.createObjectURL(f);
  $('#preview-img').src=url;
  $('#preview-wrap').style.display='block';
  $('#results-section').style.display='none';
  $('#results-grid').innerHTML='';
  setBadge('',''); $('#desc-box').style.display='none'; $('#desc-box').textContent='';
  setGenStatus('');
  validate(f);
};

const dz=$('#drop-zone');
dz.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('over');});
dz.addEventListener('dragleave',()=>dz.classList.remove('over'));
dz.addEventListener('drop',e=>{
  e.preventDefault(); dz.classList.remove('over');
  const f=e.dataTransfer.files[0]; if(!f||!/^image\\//.test(f.type)) return;
  const dt=new DataTransfer(); dt.items.add(f);
  $('#photo-input').files=dt.files;
  const url=URL.createObjectURL(f);
  $('#preview-img').src=url;
  $('#preview-wrap').style.display='block';
  $('#results-section').style.display='none';
  setBadge('',''); $('#desc-box').style.display='none'; setGenStatus('');
  validate(f);
});

$('#gen-btn').onclick=async()=>{
  if(!validToken) return;
  $('#gen-btn').disabled=true;
  setErr('');
  setGenStatus('<span class="spinner"></span> Generating photos… this takes 20–40 seconds.');
  try {
    const r=await fetch('/api/tryon/generate',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:validToken, description:validDesc})
    });
    const d=await r.json();
    if(!r.ok||d.error){ setErr(d.error||'Generation failed.'); setGenStatus(''); $('#gen-btn').disabled=false; return; }
    setGenStatus('');
    $('#results-section').style.display='block';
    $('#results-grid').innerHTML=(d.results||[]).map(item=>{
      const fname=(item.gender==='woman'?'female':'male')+'-model.png';
      return '<div class="result-card">'
        +'<img src="'+item.dataUrl+'" alt="'+item.label+'">'
        +'<div class="foot">'
        +'<span class="lbl">'+item.label+'</span>'
        +'<a href="'+item.dataUrl+'" download="'+fname+'">Download</a>'
        +'</div></div>';
    }).join('');
    $('#results-section').scrollIntoView({behavior:'smooth',block:'start'});
    $('#gen-btn').disabled=false;
  } catch(e){ setErr('Network error. Try again.'); setGenStatus(''); $('#gen-btn').disabled=false; }
};
</script></body></html>`;
