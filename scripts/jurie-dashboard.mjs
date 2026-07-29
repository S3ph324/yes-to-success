#!/usr/bin/env node
// Multi-client Quote Poster Studio (Jurie + Tranzzie).
//
// Self-contained control surface for OUR clients only. It does NOT import or
// touch the John Calub server/dashboard. Pick a client → create/choose a
// Brand Kit, a Topic brief, and a Character → Generate → review + download
// posters for manual posting. Autoposting is shown but intentionally inert.
//
//   npm run jurie:dashboard      then open http://localhost:4317
//
// Env: JURIE_DASHBOARD_PORT (default 4317).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import multer from "multer";
import path from "node:path";
import url from "node:url";
import heicConvert from "heic-convert";
import { GoogleGenAI } from "@google/genai";
import { applyGcpEnv } from "./lib/client.mjs";
import { registerTryonRoutes } from "./tryon-routes.mjs";
import { registerEyeglassAngleRoutes } from "./eyeglasses-angles-routes.mjs";
import { hackFormat } from "./lib/format-hacker.mjs";

// iPhone photos default to HEIC/HEIF, which (a) browsers other than Safari
// cannot render in <img> — previews show as broken/black squares — and
// (b) some downstream consumers mis-handle. Convert any HEIC/HEIF upload to
// JPEG right after multer saves it, in place, so everything downstream
// (dashboard previews, Gemini references, gallery thumbnails) just sees a
// normal universally-supported JPEG. Pure-JS/WASM (libheif-js) — no native
// build step, safe in the Linux container.
async function convertHeicInPlace(absPath) {
  if (!/\.hei[cf]$/i.test(absPath)) return absPath;
  try {
    const input = await fs.readFile(absPath);
    const out = await heicConvert({ buffer: input, format: "JPEG", quality: 0.9 });
    const jpgPath = absPath.replace(/\.hei[cf]$/i, ".jpg");
    await fs.writeFile(jpgPath, Buffer.from(out));
    await fs.unlink(absPath).catch(() => {});
    return jpgPath;
  } catch (err) {
    console.warn(`  HEIC convert failed for ${path.basename(absPath)}: ${err?.message || err}`);
    return absPath; // fall back to the original — better than losing the upload
  }
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const HOSTED = process.env.HOSTED === "1";
// When hosting, batch outputs go here (a writable Railway volume) instead of
// the local Mac client folders. Per-client = EXPORT_BASE/<clientId>; b-roll =
// EXPORT_BASE/broll.
const EXPORT_BASE = process.env.EXPORT_BASE || "";

// ── Persistent data directory ──────────────────────────────────────────────
// Dockerfile.studio does `COPY . .`, so on every redeploy EVERYTHING under
// /app gets reset to the git-committed snapshot — except whatever Railway
// volume is mounted (at EXPORT_BASE). config/*.json (brand kits, characters,
// eyeglasses frames, topic briefs, the Buffer approval/scheduling queue) and
// uploaded photos/logos under public/ were being read & written at in-image
// paths (projectRoot/config, projectRoot/public), so anything created or
// changed at runtime silently reverted to the checked-in defaults on the next
// ship. Redirect both to a subdirectory of the persistent volume instead —
// seeded once from the repo defaults — so runtime writes survive redeploys.
// (Falls back to the repo paths when EXPORT_BASE is unset, i.e. local dev.)
const PERSIST_BASE = EXPORT_BASE
  ? path.join(EXPORT_BASE, "_studio-data")
  : projectRoot;
const cfgDir = path.join(PERSIST_BASE, "config");
const publicDir = path.join(PERSIST_BASE, "public");

// One-time migration: copy git-committed defaults into the persistent
// location so existing presets/characters/brand-kits keep working after the
// very first boot on the new layout. Never overwrites anything that already
// exists there — later runtime writes (new eyeglasses frames, edited briefs,
// queue updates, etc.) must win over the repo snapshot on subsequent boots.
async function seedPersistentData() {
  if (!EXPORT_BASE) return; // local dev — already reading/writing repo paths directly
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });
  const cfgNames = [
    "clients.json",
    "brand-presets.json",
    "characters.json",
    "eyeglasses.json",
    "briefs.json",
  ];
  for (const name of cfgNames) {
    const dest = path.join(cfgDir, name);
    try {
      await fs.access(dest);
      continue; // already migrated / runtime-written — keep it
    } catch {
      /* not present yet — seed from repo default below */
    }
    try {
      await fs.copyFile(path.join(projectRoot, "config", name), dest);
    } catch {
      /* repo has no default for this file — fine, readCfg() falls back */
    }
  }
  for (const sub of ["characters", "eyeglasses", "brand", "poster-styles"]) {
    const dest = path.join(publicDir, sub);
    try {
      await fs.access(dest);
      continue;
    } catch {
      /* not present yet — seed from repo default below */
    }
    try {
      await fs.cp(path.join(projectRoot, "public", sub), dest, {
        recursive: true,
      });
    } catch {
      /* nothing checked in for this subdir — fine */
    }
  }
}
await seedPersistentData();

// Shown in the header as a deploy signal — bump package.json on each change.
let VERSION = "?";
try {
  VERSION = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
} catch {
  /* leave "?" */
}

// SERVER_EPOCH kept for any future server-side use; the client now generates its
// own per-page-load token (Date.now) for image URLs so it never reuses a URL
// the browser might have cached during a downtime window.
const SERVER_EPOCH = Math.floor(Date.now() / 1000).toString(36);

const PORT = parseInt(
  process.env.PORT || process.env.JURIE_DASHBOARD_PORT || "4317",
  10,
);

const app = express();
app.set("trust proxy", true);
// 16 MB ceiling so the Format Hacker can accept a base64-encoded ad screenshot
// in a JSON body (a 2–4 MB image is ~3–6 MB of base64). Other routes send tiny
// JSON, so the higher cap is harmless for a single-user private studio.
app.use(express.json({ limit: "16mb" }));

// ── Single-user login gate ────────────────────────────────────────────────
// One account only. Username defaults to "admin1"; the password is checked
// against env DASH_PASS (plaintext, set in Railway for best security) OR, if
// that's unset, a committed SHA-256 HASH so it works out of the box WITHOUT
// putting the real password in this public repo. Override either via env.
const AUTH_USER = (process.env.DASH_USER || "Jurie").trim();
const AUTH_PASS = process.env.DASH_PASS || ""; // optional plaintext override
const AUTH_PASS_HASH = (process.env.DASH_PASS_HASH || "a472960de7918b89f4fb873d323032ca25008c070a442b78eb65766a87cf56a9").toLowerCase();
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const passOk = (pass) => {
  const a = AUTH_PASS ? Buffer.from(pass || "") : Buffer.from(sha256(pass || ""));
  const b = AUTH_PASS ? Buffer.from(AUTH_PASS) : Buffer.from(AUTH_PASS_HASH);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const SESSION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// Stateless signed-cookie sessions backed by a secret PERSISTED on the volume,
// so a login survives server restarts / redeploys (there's no in-memory store
// to wipe). Override with env DASH_SECRET.
let SESSION_SECRET = process.env.DASH_SECRET || "";
if (!SESSION_SECRET) {
  const secretFile = path.join(PERSIST_BASE, ".session-secret");
  try {
    if (existsSync(secretFile)) SESSION_SECRET = readFileSync(secretFile, "utf-8").trim();
    if (!SESSION_SECRET) {
      SESSION_SECRET = crypto.randomBytes(32).toString("hex");
      try { mkdirSync(path.dirname(secretFile), { recursive: true }); } catch { /* exists */ }
      writeFileSync(secretFile, SESSION_SECRET, { mode: 0o600 });
    }
  } catch { SESSION_SECRET = crypto.randomBytes(32).toString("hex"); /* last resort, per-process */ }
}
const signSession = (expiry) =>
  `${expiry}.${crypto.createHmac("sha256", SESSION_SECRET).update(String(expiry)).digest("hex")}`;
const verifySession = (tok) => {
  if (!tok) return false;
  const dot = tok.lastIndexOf(".");
  if (dot < 1) return false;
  const payload = tok.slice(0, dot);
  const sig = tok.slice(dot + 1);
  const expiry = parseInt(payload, 10);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const readCookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );
const isAuthed = (req) => verifySession(readCookies(req).dash_session);

const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>
:root{--bg:#0b0b0d;--panel:#141417;--line:#26262b;--txt:#f3f3f5;--mut:#9a9aa2;--gold:#F5C13B}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 0%,#1a1a1f 0%,#0b0b0d 60%);font-family:'Archivo',system-ui,Arial,sans-serif;color:var(--txt)}
.box{width:340px;max-width:90vw;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:30px 28px}
h1{margin:0 0 4px;font-size:17px;letter-spacing:.02em}p{margin:0 0 20px;color:var(--mut);font-size:12.5px}
label{display:block;font-size:11px;color:var(--mut);margin:14px 0 6px;letter-spacing:.08em;text-transform:uppercase}
input{width:100%;background:#0e0e11;border:1px solid var(--line);color:var(--txt);border-radius:9px;padding:12px 13px;font:inherit;outline:none}
input:focus{border-color:var(--gold)}
button{width:100%;margin-top:22px;background:var(--gold);color:#15120a;border:0;font-weight:800;letter-spacing:.02em;padding:13px;border-radius:9px;cursor:pointer;font:inherit;font-weight:800}
button:disabled{opacity:.5;cursor:not-allowed}
.err{color:#ff6b6b;font-size:12.5px;margin-top:14px;min-height:16px}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:18px;font-weight:800;letter-spacing:.22em;font-size:12px;color:var(--gold)}
.brand i{width:7px;height:7px;border-radius:50%;background:var(--gold);font-style:normal}
</style></head><body>
<form class="box" onsubmit="return go(event)">
<div class="brand"><i></i> QUOTE POSTER STUDIO</div>
<h1>Sign in</h1><p>This studio is private.</p>
<label>Username</label><input id="u" autocomplete="username" autofocus>
<label>Password</label><input id="p" type="password" autocomplete="current-password">
<button id="b" type="submit">Sign in</button>
<div class="err" id="e"></div>
</form>
<script>
async function go(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e');b.disabled=true;e.textContent='';
try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});
if(r.ok){location.href='/';return false}var j=await r.json().catch(function(){return{}});e.textContent=j.error||'Invalid username or password';}
catch(_){e.textContent='Network error. Try again.';}b.disabled=false;return false;}
</script></body></html>`;

// Public endpoints (no auth): health check + the login submit + login page.
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (String(user || "").trim() === AUTH_USER && passOk(pass)) {
    const t = signSession(Date.now() + SESSION_MS);
    res.cookie("dash_session", t, { httpOnly: true, sameSite: "lax", secure: !!process.env.HOSTED, maxAge: SESSION_MS, path: "/" });
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: "Invalid username or password" });
});
app.post("/api/logout", (_req, res) => {
  res.clearCookie("dash_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/login", (_q, res) => res.type("html").send(LOGIN_PAGE));

// Gate everything else behind the session.
app.use((req, res, next) => {
  if (req.path === "/healthz" || req.path === "/login" || req.path === "/api/login" || req.path === "/api/logout") return next();
  if (isAuthed(req)) return next();
  if (req.method === "GET" && (req.path === "/" || !req.path.startsWith("/api/"))) {
    return res.type("html").send(LOGIN_PAGE);
  }
  return res.status(401).json({ error: "Sign in required." });
});

// Serve rendered poster PNGs via static middleware on Railway (EXPORT_BASE set).
// This avoids calling getClient() on every image request — 171 simultaneous
// reads from the Railway volume saturate I/O and return 400s for most images.
// Local dev falls through to the per-client route further down.
// SECURITY: EXPORT_BASE also holds _studio-data/ (client configs, queue files
// with Buffer tokens). Only let through the exact poster URL shape —
// /<clientId>/<stamp>/<file>.png — and nothing else.
if (EXPORT_BASE) {
  app.use("/posters", (req, res, next) => {
    let p;
    try { p = decodeURIComponent(req.path); } catch { return res.status(404).end(); }
    if (!/^\/[a-z0-9_-]+\/[\w.\- ]+\/[\w.\- ]+\.png$/i.test(p) || p.includes("/_") || p.includes(".."))
      return res.status(404).end();
    next();
  });
  app.use("/posters", express.static(EXPORT_BASE, { maxAge: 0, etag: true, dotfiles: "deny" }));
}

// ── Cost guardrails — public/no-login, so these protect the GCP bill ──────
const CAP_DAY = parseInt(process.env.STUDIO_DAILY_CAP || "40", 10);
const CAP_IP_HR = parseInt(process.env.STUDIO_IP_PER_HOUR || "4", 10);
let dayKey = "";
let dayCount = 0;
const ipHits = new Map();
// Returns true if allowed; otherwise writes a 429/503 and returns false.
// Only call once per real generation, AFTER input validation.
const guard = (req, res) => {
  if (process.env.STUDIO_KILL === "1") {
    res.status(503).json({ error: "Generation is temporarily disabled." });
    return false;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
    ipHits.clear();
  }
  if (dayCount >= CAP_DAY) {
    res.status(429).json({
      error: `Daily generation cap reached (${CAP_DAY}). Try again tomorrow.`,
    });
    return false;
  }
  const ip = String(req.ip || req.headers["x-forwarded-for"] || "anon")
    .split(",")[0]
    .trim();
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= CAP_IP_HR) {
    res.status(429).json({
      error: `Rate limit: max ${CAP_IP_HR} generations/hour per visitor.`,
    });
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount += 1;
  return true;
};

const readCfg = async (name, fb) => {
  try {
    return JSON.parse(await fs.readFile(path.join(cfgDir, name), "utf-8"));
  } catch {
    return fb;
  }
};
// Per-file write mutex (same pattern as writeQueue below): serialises
// concurrent read-modify-write cycles so e.g. two simultaneous photo uploads
// don't clobber each other's characters.json update.
const _cfgWriteMutex = new Map();
const writeCfg = (name, data) => {
  const prev = _cfgWriteMutex.get(name) || Promise.resolve();
  const next = prev.then(() =>
    fs.writeFile(path.join(cfgDir, name), JSON.stringify(data, null, 2)),
  );
  _cfgWriteMutex.set(name, next.catch(() => {}));
  return next;
};

// One-time migration: any eyeglasses reference photos uploaded BEFORE the
// HEIC→JPEG conversion was wired into the upload route are still sitting on
// disk as raw .heic/.heif — which previews as a broken/black square in every
// browser but Safari. Walk the existing config once at boot, convert any
// stragglers in place, and rewrite their paths in eyeglasses.json.
async function migrateHeicEyeglassPhotos() {
  let all;
  try {
    all = await readCfg("eyeglasses.json", []);
  } catch {
    return;
  }
  if (!Array.isArray(all) || !all.length) return;
  let changed = false;
  for (const g of all) {
    if (!Array.isArray(g.photos)) continue;
    for (let i = 0; i < g.photos.length; i++) {
      const rel = g.photos[i];
      if (!/\.hei[cf]$/i.test(rel)) continue;
      const abs = path.join(publicDir, rel);
      try {
        await fs.access(abs);
      } catch {
        continue; // file already gone — leave the record alone
      }
      const convertedAbs = await convertHeicInPlace(abs);
      if (convertedAbs !== abs) {
        g.photos[i] = rel.replace(/\.hei[cf]$/i, ".jpg");
        changed = true;
        console.log(`  migrated HEIC reference photo → ${g.photos[i]}`);
      }
    }
  }
  if (changed) await writeCfg("eyeglasses.json", all);
}
await migrateHeicEyeglassPhotos();

const getClients = () => readCfg("clients.json", []);
const getClient = async (id) =>
  (await getClients()).find((c) => c.id === id) || null;

// ── Queue helpers ─────────────────────────────────────────────────────────
// clientId is sanitized here (not at each call site) so a hostile value like
// "../../etc/x" can never escape cfgDir via the queue filename.
const queuePath  = (clientId) =>
  path.join(cfgDir, `queue-${String(clientId || "").replace(/[^a-z0-9_-]/gi, "")}.json`);
const readQueue  = async (clientId) => {
  try { return JSON.parse(await fs.readFile(queuePath(clientId), "utf-8")); }
  catch { return []; }
};
// Per-client write-queue: serialises concurrent writeQueue calls so that
// two simultaneous requests (e.g. rapid approve/decline taps) never clobber
// each other's write. Each client gets its own promise chain.
const _qWriteMutex = new Map();
const writeQueue = (clientId, data) => {
  const prev = _qWriteMutex.get(clientId) || Promise.resolve();
  const next = prev.then(() =>
    fs.writeFile(queuePath(clientId), JSON.stringify(data, null, 2)),
  );
  _qWriteMutex.set(clientId, next.catch(() => {}));
  return next;
};

// Serialises the WHOLE read-modify-write cycle per client. The write-only
// mutex above prevents corrupted files but not lost updates: two interleaved
// handlers (a fast approve tap racing the job-completion auto-queue, or the
// retention prune) could both read, then the second write discarded the
// first's change. The mutator gets the current queue; return the new queue
// to persist it, or undefined to skip the write. Returns the mutator result.
const _qUpdateLocks = new Map();
const updateQueue = (clientId, mutator) => {
  const key = String(clientId || "");
  const run = async () => {
    const queue = await readQueue(key);
    const out = await mutator(queue);
    if (out !== undefined) await writeQueue(key, out);
    return out;
  };
  const prev = _qUpdateLocks.get(key) || Promise.resolve();
  const next = prev.then(run, run);
  _qUpdateLocks.set(key, next.then(() => {}, () => {}));
  return next;
};

async function addBatchToQueue(clientId, batchDir, stamp) {
  try {
    const pngs = (await fs.readdir(batchDir)).filter(f => f.endsWith(".png")).sort();
    let captText = "";
    try { captText = await fs.readFile(path.join(batchDir, "captions.txt"), "utf-8"); } catch {}
    // Map captions by their #N index, and posters by the NN in the filename
    // (client-NN-slug.png) — positional zip silently shifted every caption
    // after a failed/deleted poster onto the wrong image.
    const capByIdx = {};
    const capList = [];
    for (const block of captText.split(/^-{20,}\s*$/m)) {
      const m = block.match(/^\s*#(\d+)\s*([\s\S]*)$/);
      const text = (m ? m[2] : block).trim();
      if (!text) continue;
      capList.push(text);
      if (m) capByIdx[parseInt(m[1], 10)] = text;
    }
    const posters = pngs.map((filename, i) => {
      const fm = filename.match(/^[a-z0-9_]+-(\d+)-/i);
      const caption = fm
        ? (capByIdx[parseInt(fm[1], 10)] || "")
        : (capList[i] || "");
      return { filename, caption, status: "pending" };
    });
    const entry = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stamp, clientId,
      createdAt: new Date().toISOString(),
      posters, sentAt: null, scheduledStart: null, spacingMinutes: 60,
    };
    await updateQueue(clientId, (queue) => {
      queue.unshift(entry);
      if (queue.length > 30) queue.splice(30);
      return queue;
    });
    return entry;
  } catch (err) {
    console.warn("addBatchToQueue error:", err.message);
    return null;
  }
}

// Buffer GraphQL call used by the send endpoint.
const BUFFER_CHANNEL = {
  tranzzie: () => process.env.BUFFER_TRANZZIE_CHANNEL || "6a1fb490c687a22dd4554170",
  jurie:    () => process.env.BUFFER_JURIE_CHANNEL    || "6a1fb490c687a22dd455416f",
};
const STUDIO_URL = () =>
  (process.env.STUDIO_PUBLIC_URL || "https://jurie-automation-production-5045.up.railway.app").replace(/\/$/, "");

// Buffer GraphQL API — updated for new schema (June 2026).
// Key changes from old API:
//   channelIds[] → channelId (singular)
//   mediaUrls[]  → metadata.facebook.linkAttachment.url
//   scheduledAt  → dueAt
//   new required: schedulingType, mode, assets: []
//   response: inline fragment ... on PostActionSuccess
async function bufferPost(channelId, imageUrl, text, dueAt) {
  const r = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.BUFFER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `mutation CP($i:CreatePostInput!){createPost(input:$i){
        ... on PostActionSuccess{post{id status dueAt}}
        ... on InvalidInputError{message}
        ... on UnexpectedError{message}
        ... on LimitReachedError{message}
      }}`,
      variables: {
        i: {
          channelId,
          schedulingType: "automatic",
          mode: "customScheduled",
          dueAt,
          text,
          assets: [],
          metadata: {
            facebook: {
              type: "post",
              linkAttachment: { url: imageUrl },
            },
          },
        },
      },
    }),
  });
  const json = await r.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
  const result = json.data?.createPost;
  if (result?.message) throw new Error(result.message); // error union types
  return result?.post;
}

// ── Queue API routes ──────────────────────────────────────────────────────
app.get("/api/queue", async (req, res) => {
  const c = await getClient(req.query.client);
  if (!c) return res.json([]);
  res.json(await readQueue(c.id));
});

app.post("/api/queue/review", async (req, res) => {
  const { client, queueId, decisions } = req.body || {};
  const VALID_STATUS = ["approved", "declined", "posted", "pending"];
  const found = await updateQueue(client, (queue) => {
    const entry = queue.find(e => e.id === queueId);
    if (!entry) return undefined; // no write
    for (const { filename, status } of (decisions || [])) {
      if (!VALID_STATUS.includes(status)) continue;
      const p = (entry.posters || []).find(x => x.filename === filename);
      if (p) p.status = status;
    }
    return queue;
  });
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

// ── Posting strategy definitions (Manila time, UTC+8) ────────────────────
// hours[] = Manila local hours to post each day.
const POST_STRATEGIES = {
  light:    { label: "Light — 2 posts/day",            hours: [9, 19] },
  standard: { label: "Standard — 3 posts/day",         hours: [9, 13, 19] },
  active:   { label: "Active — 5 posts/day",           hours: [9, 11, 13, 17, 20] },
};
const MANILA_UTC_OFFSET = 8; // UTC+8

// Build an array of UTC ISO timestamps by filling strategy time-slots day by day.
// startDate = "YYYY-MM-DD" in Manila local time.
function buildPostSchedule(strategy, startDate, count) {
  const hours = (POST_STRATEGIES[strategy] || POST_STRATEGIES.standard).hours;
  const [y, m, d] = startDate.split("-").map(Number);
  const timestamps = [];
  let dayOffset = 0;
  while (timestamps.length < count) {
    for (const h of hours) {
      if (timestamps.length >= count) break;
      // Convert Manila local time to UTC
      const utcH = h - MANILA_UTC_OFFSET;
      // Date.UTC handles negative hours and day rollover automatically
      timestamps.push(new Date(Date.UTC(y, m - 1, d + dayOffset, utcH, 0, 0)).toISOString());
    }
    dayOffset++;
  }
  return timestamps;
}

app.post("/api/queue/send", async (req, res) => {
  const { client, queueId, strategy, startDate } = req.body || {};
  const clientCfg = await getClient(client);
  if (!clientCfg) return res.status(400).json({ error: "Unknown client" });
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "BUFFER_API_KEY not configured" });
  const channelId = BUFFER_CHANNEL[client]?.();
  if (!channelId) return res.status(500).json({ error: `No Buffer channel for ${client}` });

  // Snapshot read — the slow Buffer calls must NOT hold the queue lock
  // (approve taps would stall behind them). Results are merged onto the
  // freshest queue in a short locked update afterwards.
  const queue0 = await readQueue(client);
  const entry0 = queue0.find(e => e.id === queueId);
  if (!entry0) return res.status(404).json({ error: "Queue entry not found" });
  const approved = entry0.posters.filter(p => p.status === "approved");
  if (!approved.length) return res.status(400).json({ error: "No approved posters to send" });

  // Build the schedule using strategy slots
  const sd = startDate || new Date().toISOString().slice(0, 10);
  const timestamps = buildPostSchedule(strategy || "standard", sd, approved.length);
  const studioUrl = STUDIO_URL();
  let sent = 0, failed = 0;
  const bufferPostIds = [];
  const sentFiles = [];
  const errors = [];

  for (let i = 0; i < approved.length; i++) {
    const p = approved[i];
    const imageUrl = `${studioUrl}/posters/${client}/${encodeURIComponent(entry0.stamp)}/${encodeURIComponent(p.filename)}`;
    try {
      const post = await bufferPost(channelId, imageUrl, p.caption, timestamps[i]);
      sentFiles.push(p.filename);
      if (post?.id) bufferPostIds.push(post.id);
      sent++;
    } catch (err) {
      console.warn(`Buffer send failed ${p.filename}:`, err.message);
      // Surface WHY in the response — failures were invisible outside
      // Railway logs, so a broken key/channel looked like a silent shrug.
      errors.push({ filename: p.filename, error: String(err.message || err).slice(0, 300) });
      failed++;
    }
    if (i < approved.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  await updateQueue(client, (queue) => {
    const entry = queue.find(e => e.id === queueId);
    if (!entry) return undefined; // entry pruned mid-send — nothing to record
    for (const fn of sentFiles) {
      const p = (entry.posters || []).find(x => x.filename === fn);
      if (p) p.status = "sent";
    }
    entry.sentAt = new Date().toISOString();
    entry.strategy = strategy || "standard";
    entry.startDate = sd;
    entry.bufferPostIds = bufferPostIds;
    return queue;
  });
  res.json({ ok: true, sent, failed, errors, timestamps, bufferPostIds });
});

app.delete("/api/queue/:queueId", async (req, res) => {
  const { client } = req.query;
  await updateQueue(client, (queue) =>
    queue.filter(e => e.id !== req.params.queueId),
  );
  res.json({ ok: true });
});

// Cancel scheduled Buffer posts for a queue entry (delete them from Buffer).
app.post("/api/queue/cancel", async (req, res) => {
  const { client, queueId } = req.body || {};
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "BUFFER_API_KEY not configured" });
  // Snapshot read — slow Buffer deletes run unlocked; status reset merges in
  // a short locked update afterwards.
  const queue0 = await readQueue(client);
  const entry0 = queue0.find(e => e.id === queueId);
  if (!entry0) return res.status(404).json({ error: "Queue entry not found" });
  const postIds = entry0.bufferPostIds || [];
  if (!postIds.length) return res.status(400).json({ error: "No Buffer post IDs stored — cannot cancel" });

  let cancelled = 0, failed = 0;
  for (const postId of postIds) {
    try {
      const r = await fetch("https://api.buffer.com", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `mutation DP($i:DeletePostInput!){deletePost(input:$i){__typename}}`,
          variables: { i: { id: postId } },
        }),
      });
      const json = await r.json();
      if (json.errors?.length) throw new Error(json.errors[0].message);
      cancelled++;
    } catch (err) {
      console.warn(`Cancel Buffer post ${postId}:`, err.message);
      failed++;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  // Reset poster statuses back to approved so user can re-send
  await updateQueue(client, (queue) => {
    const entry = queue.find(e => e.id === queueId);
    if (!entry) return undefined;
    for (const p of (entry.posters || [])) {
      if (p.status === "sent") p.status = "approved";
    }
    entry.sentAt = null;
    entry.bufferPostIds = [];
    return queue;
  });
  res.json({ ok: true, cancelled, failed });
});

// ── Clients ───────────────────────────────────────────────────────────────
app.get("/api/clients", async (_q, res) =>
  res.json(
    (await getClients()).map((c) => ({
      id: c.id,
      label: c.label,
      characterId: c.characterId || "",
    })),
  ),
);

// Serve a character reference photo for the Generate preview.
// Uploaded photo/logo/poster filenames all carry a Date.now() prefix from
// multer (see photoStore/glassPhotoStore/logoStore below), so a given URL's
// bytes never change — safe to let the browser cache them aggressively
// instead of revalidating on every tab switch (the slow part users feel).
const ASSET_CACHE = { maxAge: "7d", immutable: true };
// Poster images are user-generated content — NOT immutable. Using immutable on
// these caused browsers to permanently cache partial/broken responses when the
// render was still writing the file on first load, and a normal refresh could
// never fix it (browsers honour immutable strictly). 24h max-age + ETag lets
// the browser revalidate efficiently without serving stale broken content.


// Serve poster style preset images — committed read-only assets, serve from
// the in-image repo path (projectRoot) so they're always available on Railway
// without depending on the persistent volume being seeded.
app.get("/poster-styles/:file", (req, res) => {
  const file = String(req.params.file || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!file) return res.status(400).end();
  const fp = path.join(projectRoot, "public", "poster-styles", file);
  res.sendFile(fp, { maxAge: "7d" }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get("/api/charphoto", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("characters/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "characters")))
    return res.status(400).end();
  res.sendFile(fp, ASSET_CACHE, (err) => {
    // Missing file must be a plain 404 — without this callback Express
    // emits an HTML 500 that browsers cache for 7 days (immutable).
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Serve a brand-kit logo for preview.
app.get("/api/brandlogo", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("brand/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "brand")))
    return res.status(400).end();
  res.sendFile(fp, ASSET_CACHE, (err) => {
    // Missing file must be a plain 404 — without this callback Express
    // emits an HTML 500 that browsers cache for 7 days (immutable).
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ── Brand Kits (brand-presets.json, filtered to the client) ───────────────
app.get("/api/brand", async (req, res) => {
  const all = await readCfg("brand-presets.json", []);
  res.json(all.filter((p) => p.client === req.query.client));
});
app.post("/api/brand", async (req, res) => {
  const p = req.body;
  if (!p?.id || !p?.client)
    return res.status(400).json({ error: "id and client required" });
  const all = await readCfg("brand-presets.json", []);
  const i = all.findIndex((x) => x.id === p.id);
  if (i === -1) all.push(p);
  else all[i] = { ...all[i], ...p };
  await writeCfg("brand-presets.json", all);
  res.json(p);
});
app.delete("/api/brand/:id", async (req, res) => {
  const { id } = req.params;
  const { client } = req.query;
  const all = await readCfg("brand-presets.json", []);
  const i = all.findIndex((x) => x.id === id && x.client === client);
  if (i === -1) return res.status(404).json({ error: "Brand kit not found" });
  const [removed] = all.splice(i, 1);
  await writeCfg("brand-presets.json", all);
  if (removed.logoSrc) {
    const fp = path.join(publicDir, removed.logoSrc);
    if (fp.startsWith(path.join(publicDir, "brand"))) await fs.unlink(fp).catch(() => {});
  }
  res.json({ ok: true });
});

// ── Topics / Briefs (briefs.json, filtered to the client) ─────────────────
app.get("/api/briefs", async (req, res) => {
  const all = await readCfg("briefs.json", []);
  res.json(all.filter((b) => b.client === req.query.client));
});
app.post("/api/briefs", async (req, res) => {
  const b = req.body;
  if (!b?.id || !b?.client)
    return res.status(400).json({ error: "id and client required" });
  if (typeof b.topics === "string")
    b.topics = b.topics
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
  const all = await readCfg("briefs.json", []);
  const i = all.findIndex((x) => x.id === b.id);
  if (i === -1) all.push(b);
  else all[i] = { ...all[i], ...b };
  await writeCfg("briefs.json", all);
  res.json(b);
});

// ── Characters (characters.json, filtered to the client) ──────────────────
app.get("/api/characters", async (req, res) => {
  const all = await readCfg("characters.json", []);
  res.json(
    req.query.client
      ? all.filter((c) => c.client === req.query.client)
      : all,
  );
});
app.post("/api/characters", async (req, res) => {
  const c = req.body;
  if (!c?.id || !c?.client)
    return res.status(400).json({ error: "id and client required" });
  const all = await readCfg("characters.json", []);
  const i = all.findIndex((x) => x.id === c.id);
  if (i === -1) all.push({ photos: [], enabled: true, ...c });
  else all[i] = { ...all[i], ...c };
  await writeCfg("characters.json", all);
  res.json(c);
});
app.delete("/api/characters/:id", async (req, res) => {
  const { id } = req.params;
  const { client } = req.query;
  const all = await readCfg("characters.json", []);
  const i = all.findIndex((x) => x.id === id && x.client === client);
  if (i === -1) return res.status(404).json({ error: "Character not found" });
  const [removed] = all.splice(i, 1);
  await writeCfg("characters.json", all);
  for (const p of removed.photos || []) {
    const fp = path.join(publicDir, p);
    if (fp.startsWith(path.join(publicDir, "characters"))) await fs.unlink(fp).catch(() => {});
  }
  res.json({ ok: true });
});

// Sanitize a client id before it's used as a path segment — anything that
// isn't a plain slug becomes "misc" (blocks ../ traversal via ?client=).
const safeClientSeg = (v) =>
  /^[a-z0-9_-]+$/i.test(String(v || "")) ? String(v) : "misc";

const photoStore = multer.diskStorage({
  destination: async (req, _f, cb) => {
    const client = safeClientSeg(req.query.client);
    const d = path.join(publicDir, "characters", client);
    await fs.mkdir(d, { recursive: true });
    cb(null, d);
  },
  filename: (_r, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
const uploadPhoto = multer({ storage: photoStore });
app.post(
  "/api/characters/photo",
  uploadPhoto.array("photo", 8),
  async (req, res) => {
    const { charId } = req.query;
    const client = safeClientSeg(req.query.client);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });
    // Convert any HEIC/HEIF uploads (iPhone default) to JPEG in place so
    // previews render in every browser, not just Safari — same as eyeglasses.
    const finalNames = await Promise.all(
      files.map(async (f) => {
        const converted = await convertHeicInPlace(f.path);
        return path.basename(converted);
      }),
    );
    const paths = finalNames.map((name) =>
      path.posix.join("characters", client, name),
    );
    const all = await readCfg("characters.json", []);
    const ch = all.find((x) => x.id === charId);
    if (ch) {
      ch.photos = ch.photos || [];
      ch.photos.push(...paths);
      await writeCfg("characters.json", all);
    }
    res.json({ ok: true, paths });
  },
);

// ── Eyeglasses assets (eyeglasses.json, Tranzzie-only for now) ────────────
// Mirrors the Characters pattern above: a config-driven asset list with
// reference photos, used by the eyeglasses-showcase pipeline in place of a
// character. Starts empty — created from the Eyeglasses tab.
app.get("/api/eyeglasses", async (req, res) => {
  const all = await readCfg("eyeglasses.json", []);
  res.json(
    req.query.client
      ? all.filter((g) => g.client === req.query.client)
      : all,
  );
});
app.post("/api/eyeglasses", async (req, res) => {
  const g = req.body;
  if (!g?.id || !g?.client)
    return res.status(400).json({ error: "id and client required" });
  const all = await readCfg("eyeglasses.json", []);
  const i = all.findIndex((x) => x.id === g.id);
  if (i === -1) all.push({ photos: [], enabled: true, ...g });
  else all[i] = { ...all[i], ...g };
  await writeCfg("eyeglasses.json", all);
  res.json(g);
});
app.delete("/api/eyeglasses/:id", async (req, res) => {
  const { id } = req.params;
  const { client } = req.query;
  const all = await readCfg("eyeglasses.json", []);
  const i = all.findIndex((x) => x.id === id && x.client === client);
  if (i === -1) return res.status(404).json({ error: "Frame not found" });
  const [removed] = all.splice(i, 1);
  await writeCfg("eyeglasses.json", all);
  for (const p of removed.photos || []) {
    const fp = path.join(publicDir, p);
    if (fp.startsWith(path.join(publicDir, "eyeglasses"))) await fs.unlink(fp).catch(() => {});
  }
  res.json({ ok: true });
});

// Remove a single reference photo from an eyeglasses asset.
app.delete("/api/eyeglasses/:id/photo", async (req, res) => {
  const { id } = req.params;
  const { client, photoPath } = req.query;
  if (!photoPath) return res.status(400).json({ error: "photoPath required" });
  const all = await readCfg("eyeglasses.json", []);
  const g = all.find((x) => x.id === id && x.client === client);
  if (!g) return res.status(404).json({ error: "Frame not found" });
  g.photos = (g.photos || []).filter((p) => p !== photoPath);
  await writeCfg("eyeglasses.json", all);
  const fp = path.join(publicDir, photoPath);
  if (fp.startsWith(path.join(publicDir, "eyeglasses"))) await fs.unlink(fp).catch(() => {});
  res.json({ ok: true });
});

const glassPhotoStore = multer.diskStorage({
  destination: async (req, _f, cb) => {
    const client = safeClientSeg(req.query.client);
    const d = path.join(publicDir, "eyeglasses", client);
    await fs.mkdir(d, { recursive: true });
    cb(null, d);
  },
  filename: (_r, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
const uploadGlassPhoto = multer({ storage: glassPhotoStore });
app.post(
  "/api/eyeglasses/photo",
  uploadGlassPhoto.array("photo", 8),
  async (req, res) => {
    const { glassesId } = req.query;
    const client = safeClientSeg(req.query.client);
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });
    // Convert any HEIC/HEIF uploads (iPhone default) to JPEG in place so
    // dashboard previews render in every browser, not just Safari.
    const finalNames = await Promise.all(
      files.map(async (f) => {
        const converted = await convertHeicInPlace(f.path);
        return path.basename(converted);
      }),
    );
    const paths = finalNames.map((name) =>
      path.posix.join("eyeglasses", client, name),
    );
    const all = await readCfg("eyeglasses.json", []);
    const g = all.find((x) => x.id === glassesId);
    if (g) {
      g.photos = g.photos || [];
      g.photos.push(...paths);
      await writeCfg("eyeglasses.json", all);
    }
    res.json({ ok: true, paths });
  },
);

// Serve an eyeglasses reference photo for previews (Generate tab + Eyeglasses tab).
app.get("/api/glassesphoto", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("eyeglasses/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "eyeglasses")))
    return res.status(400).end();
  res.sendFile(fp, ASSET_CACHE, (err) => {
    // Missing file must be a plain 404 — without this callback Express
    // emits an HTML 500 that browsers cache for 7 days (immutable).
    if (err && !res.headersSent) res.status(404).end();
  });
});

const logoStore = multer.diskStorage({
  destination: async (_r, _f, cb) => {
    const d = path.join(publicDir, "brand");
    await fs.mkdir(d, { recursive: true });
    cb(null, d);
  },
  filename: (_r, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
app.post(
  "/api/brand/logo",
  multer({ storage: logoStore }).single("logo"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    res.json({ ok: true, path: path.posix.join("brand", req.file.filename) });
  },
);

// ── Generate (one job at a time) ──────────────────────────────────────────
let job = null;
let jobTimer = null; // auto-kill timer — prevents permanent lock on hung Gemini calls
const JOB_TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes max per job

// A job is only REALLY running if its child process is still alive. If the child
// already exited / was killed but the lock wasn't cleared (a crash, a missed
// 'exit' event, a server hiccup), the lock is STALE — reap it so it can never
// permanently block new jobs. This is the durable fix for "a job is already
// running" sticking even when nothing is actually running.
function jobActuallyRunning() {
  if (!job?.running) return false;
  const ch = job.child;
  if (ch && (ch.exitCode !== null || ch.signalCode !== null || ch.killed)) {
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
    job.running = false;
    log("⚠ Cleared a stale job lock — the previous job had already exited.");
    return false;
  }
  return true; // genuinely running (or child not attached yet — brief spawn window)
}

// ── Generation queue ────────────────────────────────────────────────────────
// Generate requests submitted while a batch is running wait here and start
// automatically (FIFO) when the current job finishes — fire-and-forget
// batching from the Generate tab.
const GEN_QUEUE_MAX = 5;
const genQueue = []; // [{ id, label, spec }]

// Force-clear a stuck lock (called by the UI "Unlock" button). Also drops any
// queued generations — "Unlock" means "full reset".
app.post("/api/clear-job", (_q, res) => {
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
  if (job?.child) { try { job.child.kill("SIGTERM"); } catch {} }
  if (job) { job.running = false; job.code = -99; }
  genQueue.length = 0;
  res.json({ ok: true });
});

// Drop all queued (not-yet-started) generations. The running batch continues.
app.post("/api/genqueue/clear", (_q, res) => {
  const dropped = genQueue.length;
  genQueue.length = 0;
  if (dropped) log(`🗑 Cleared ${dropped} queued generation(s).`);
  res.json({ ok: true, dropped });
});

const sse = new Set();
const log = (line) => {
  if (!job) return;
  job.log.push(line);
  if (job.log.length > 3000) job.log.shift();
  for (const r of sse) r.write(`data: ${JSON.stringify(line)}\n\n`);
};
app.get("/api/log", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  for (const l of job?.log || []) r2(res, l);
  function r2(rr, l) {
    rr.write(`data: ${JSON.stringify(l)}\n\n`);
  }
  sse.add(res);
  req.on("close", () => sse.delete(res));
});
app.get("/api/status", (_q, res) =>
  res.json({
    running: !!job?.running,
    client: job?.client || "",
    code: job?.code ?? null,
    queued: genQueue.length,
    queuedLabels: genQueue.map((q) => q.label),
  }),
);
// Per-batch one-off reference photos uploaded from the Generate tab.
// Saved to out/extra-refs (gitignored); their absolute paths are passed to
// the pipeline via DASHBOARD_EXTRA_REFS and override the character's saved
// photos for that batch only.
const extraRefUpload = multer({
  storage: multer.diskStorage({
    destination: async (_r, _f, cb) => {
      const d = path.join(projectRoot, "out", "extra-refs");
      await fs.mkdir(d, { recursive: true });
      cb(null, d);
    },
    filename: (_r, file, cb) =>
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.originalname.replace(/[^\w.\-]/g, "_")}`,
      ),
  }),
});

app.post("/api/generate", extraRefUpload.fields([
  { name: "extraRef", maxCount: 8 },
  { name: "styleRef", maxCount: 1 },
  { name: "shopPhoto", maxCount: 10 },
  { name: "adviceAvatar", maxCount: 1 },
  { name: "brandPhoto", maxCount: 6 },
  // Studio Builder varieties — multer.fields() needs fixed names, so the UI
  // assigns each variety row an index (max 8 varieties × 6 photos).
  ...Array.from({ length: 8 }, (_, i) => ({ name: `variantPhotos_${i}`, maxCount: 6 })),
]), async (req, res) => {
  const {
    client,
    topic,
    count,
    briefId,
    brandPresetId,
    characterId,
    useLogo,
    includeCta,
    bufferAutopost,
    posterType,
    eyeglassesId,
    eyeglassesStyle,
    eyeglassesModelStyle,
    aspectDist,
    aiHeadline,
    stylePreset,
    promo,
    // TikTok Shop product listing
    shopSpecs,
    shopProduct,
    shopColor,
    shopMaterial,
    shopAspect,
    adviceSeries,
    adviceTheme,
  } = req.body || {};
  const c = await getClient(client);
  if (!c) return res.status(400).json({ error: "Unknown client" });
  const t = String(topic || "").trim().slice(0, 200);
  let n = parseInt(count, 10);
  if (!Number.isFinite(n)) n = 8;
  n = Math.max(1, Math.min(200, n));
  const filesMap = req.files || {};
  // TikTok Shop product listing — Tranzzie-only; uploads product photos and
  // composites brand cards (no AI image gen, no topic).
  const isShop = client === "tranzzie" && posterType === "shop";
  // Topic is required for main/quote posters; optional for eyeglasses showcase
  // and shop (those use product inputs instead of a topic).
  const isEyeglassesBatch = client === "tranzzie" && posterType === "eyeglasses";
  // Jurie advice/tweet posters — text-only cards, topic optional (generator
  // rotates the brief topics when none is given).
  const isAdvice = client === "jurie" && (posterType === "advice" || posterType === "tweet");
  // Brand-a-Photo — Tranzzie-only; one uploaded photo + text/logo, no topic.
  const isBrand = client === "tranzzie" && posterType === "brandphoto";
  if (!t && !isEyeglassesBatch && !isShop && !isAdvice && !isBrand) return res.status(400).json({ error: "Topic is required." });
  // Studio Builder plan (Virtual Photography Studio). Validated BEFORE the
  // cost guard so a bad request never burns a rate-limit slot.
  let shopPlanReq = null;
  let shopVarietiesMeta = [];
  const SHOP_SHOT_TYPES = ["hero", "simple", "model", "closeup", "feature", "group", "specs"];
  if (isShop && req.body?.shopPlan) {
    try { shopPlanReq = JSON.parse(req.body.shopPlan); } catch { shopPlanReq = null; }
    if (!shopPlanReq) return res.status(400).json({ error: "Invalid studio plan." });
    const seen = new Set();
    for (const v of (Array.isArray(shopPlanReq.varieties) ? shopPlanReq.varieties : []).slice(0, 8)) {
      const name = String(v?.name || "").trim().slice(0, 30);
      const field = String(v?.field || "");
      if (!name || !/^variantPhotos_[0-7]$/.test(field) || seen.has(field)) continue;
      seen.add(field);
      if (!(filesMap[field] || []).length) continue;
      shopVarietiesMeta.push({ name, field });
    }
    if (!shopVarietiesMeta.length)
      return res.status(400).json({ error: "Add at least one variety with a name and photos." });
    const shots = {};
    for (const ty of SHOP_SHOT_TYPES) shots[ty] = Math.max(0, Math.min(6, parseInt(shopPlanReq?.shots?.[ty], 10) || 0));
    shots.specs = Math.min(1, shots.specs);
    if (shopVarietiesMeta.length < 2) shots.group = 0;
    const per = shots.hero + shots.simple + shots.model + shots.closeup + shots.feature;
    const totalAi = (shopPlanReq.identicalSets ? per * shopVarietiesMeta.length : per) + shots.group;
    if (totalAi < 1 && !shots.specs)
      return res.status(400).json({ error: "Pick at least one shot in the shot menu." });
    if (totalAi > 12)
      return res.status(400).json({ error: `That's ${totalAi} AI shots — max 12 per batch (job time limit). Reduce quantities or varieties.` });
    shopPlanReq._shots = shots;
    shopPlanReq._totalAi = totalAi;
  } else if (isShop && !(filesMap.shopPhoto || []).length) {
    return res.status(400).json({ error: "Upload at least one product photo." });
  }
  // Brand-a-Photo validation (before the cost guard so a bad request is free).
  let brandPlanReq = null;
  if (isBrand) {
    try { brandPlanReq = JSON.parse(req.body?.brandPlan || "null"); } catch { brandPlanReq = null; }
    if (!brandPlanReq) return res.status(400).json({ error: "Invalid brand-card settings." });
    if (!(filesMap.brandPhoto || []).length) return res.status(400).json({ error: "Upload a photo first." });
    if ((brandPlanReq.textMode === "ai" ? "ai" : "own") === "own" && !String(brandPlanReq.tagline || "").trim())
      return res.status(400).json({ error: "Write a tagline, or switch to 'Let AI suggest'." });
  }
  if (!guard(req, res)) return;

  const extraRefPaths = (filesMap.extraRef || []).map((f) => f.path);
  const styleRefPath  = (filesMap.styleRef  || [])[0]?.path || "";
  // Shop product photos — convert any HEIC (iPhone) to JPEG so Remotion reads them.
  let shopPhotoPaths = [];
  let shopPlanEnv = "";
  if (isShop && shopPlanReq) {
    const varieties = [];
    for (const vm of shopVarietiesMeta) {
      const photos = await Promise.all(
        (filesMap[vm.field] || []).map((f) => convertHeicInPlace(f.path).catch(() => f.path)),
      );
      varieties.push({ name: vm.name, photos });
    }
    shopPlanEnv = JSON.stringify({
      varieties,
      shots: shopPlanReq._shots,
      identicalSets: !!shopPlanReq.identicalSets,
      modelNote: String(shopPlanReq.modelNote || "").trim().slice(0, 160),
    });
  } else if (isShop) {
    shopPhotoPaths = await Promise.all(
      (filesMap.shopPhoto || []).map((f) => convertHeicInPlace(f.path).catch(() => f.path)),
    );
  }
  // Brand-a-Photo: resolve the uploaded photo(s) + normalize the plan.
  let brandPlanEnv = "";
  if (isBrand && brandPlanReq) {
    const bps = (filesMap.brandPhoto || []).slice(0, 6);
    const photos = await Promise.all(bps.map((f) => convertHeicInPlace(f.path).catch(() => f.path)));
    // 2+ reference photos only help the AI re-shoot (multiple angles to model
    // the frame accurately) — original/cleanup only ever use one photo, so
    // force re-shoot server-side too (defense in depth vs. the UI's forcing).
    const requestedTreatment = ["original", "cleanup", "reshoot"].includes(brandPlanReq.treatment) ? brandPlanReq.treatment : "original";
    brandPlanEnv = JSON.stringify({
      photo: photos[0] || "",
      photos,
      treatment: photos.length > 1 ? "reshoot" : requestedTreatment,
      textMode: brandPlanReq.textMode === "ai" ? "ai" : "own",
      tagline: String(brandPlanReq.tagline || "").slice(0, 140),
      productName: String(brandPlanReq.productName || "").slice(0, 40),
      showLogo: brandPlanReq.showLogo !== false,
      layout: ["minimal", "banner", "editorial", "badge"].includes(brandPlanReq.layout) ? brandPlanReq.layout : "minimal",
      aspect: ["1:1", "4:5", "9:16", "all"].includes(brandPlanReq.aspect) ? brandPlanReq.aspect : "4:5",
    });
  }

  // Eyeglasses showcase batches are Tranzzie-only and run a separate
  // orchestrator (different content-gen voice + reference-asset source) that
  // still funnels into the same render-batch-jurie.mjs at the end.
  const isEyeglasses = client === "tranzzie" && posterType === "eyeglasses";
  const glassesId = String(eyeglassesId || "");
  const glassesStyle = String(eyeglassesStyle || "showcase");

  const header = isShop
    ? shopPlanEnv
      ? `▶ [${c.label}] Shop studio for "${String(shopProduct || "product").slice(0, 40)}" · ${shopVarietiesMeta.length} variet${shopVarietiesMeta.length === 1 ? "y" : "ies"} · ${shopPlanReq._totalAi} AI shot(s)${shopPlanReq._shots.specs ? " + specs card" : ""}…`
      : `▶ [${c.label}] TikTok Shop cards for "${String(shopProduct || "product").slice(0, 40)}" · ${shopPhotoPaths.length} photo(s)…`
    : isBrand
    ? `▶ [${c.label}] Brand-a-Photo card (${brandPlanReq?.treatment || "original"})…`
    : isAdvice
    ? `▶ [${c.label}] ${n} ${posterType === "tweet" ? "tweet-style" : "advice"} card(s)` + (t ? ` about "${t}"` : "") + "…"
    : `▶ [${c.label}] ${n} ${isEyeglasses ? "eyeglasses showcase " : ""}poster(s) about "${t}"` +
      (isEyeglasses ? ` · frame ${glassesId || "(none selected)"}` : "") +
      (extraRefPaths.length ? ` · ${extraRefPaths.length} extra ref(s)` : "") +
      (useLogo === "1" ? " · with logo" : " · no logo") +
      "…";
  const env = { ...process.env };
  // Pass the persistent-data base path so child scripts read config from the
  // Railway volume (PERSIST_BASE/config/) instead of the Docker-image snapshot.
  if (EXPORT_BASE) {
    env.JURIE_EXPORT_DIR = path.join(EXPORT_BASE, client);
    env.PERSIST_BASE = PERSIST_BASE;
  }
  if (briefId) env.DASHBOARD_BRIEF_ID = briefId;
  if (brandPresetId) env.DASHBOARD_BRAND_PRESET_ID = brandPresetId;
  if (isEyeglasses) {
    env.DASHBOARD_EYEGLASSES_ID = glassesId;
    env.DASHBOARD_EYEGLASSES_STYLE = glassesStyle;
    if (eyeglassesModelStyle) env.DASHBOARD_EYEGLASSES_MODEL_STYLE = String(eyeglassesModelStyle);
  } else if (characterId !== undefined) {
    env.DASHBOARD_CHARACTER_ID = characterId;
  }
  if (useLogo !== "1") env.DASHBOARD_NO_LOGO = "1";
  if (includeCta !== "1") env.DASHBOARD_NO_CTA = "1";
  if (aiHeadline === "1") env.DASHBOARD_AI_HEADLINE = "1";
  if (bufferAutopost === "1") env.BUFFER_AUTOPOST = "1";
  // Jurie photo-quote styles — a Jurie PORTRAIT + quote overlay. Reuse the main
  // quote+background flow (batch-jurie); just switch the render composition and
  // generate a clean portrait instead of a busy scene.
  if (client === "jurie" && (posterType === "photo" || posterType === "mono")) {
    env.DASHBOARD_RENDER_STYLE = posterType;   // "photo" | "mono"
    env.DASHBOARD_PORTRAIT_MODE = posterType;
  }
  // Jurie advice/tweet posters — text-only cards via the advice generator.
  if (isAdvice) {
    env.DASHBOARD_ADVICE_FORMAT = posterType; // "advice" | "tweet"
    // Card theme — user-chosen (default dark); stops the AI from randomly
    // producing light/white cards.
    env.DASHBOARD_ADVICE_THEME = adviceTheme === "light" ? "light" : "dark";
    if (adviceSeries) env.DASHBOARD_ADVICE_SERIES = String(adviceSeries).slice(0, 28);
    // Optional custom profile photo for the cards (HEIC → JPEG).
    const avatarFile = (filesMap.adviceAvatar || [])[0];
    if (avatarFile) {
      const avPath = await convertHeicInPlace(avatarFile.path).catch(() => avatarFile.path);
      env.DASHBOARD_ADVICE_AVATAR = avPath;
    }
  }
  if (extraRefPaths.length)
    env.DASHBOARD_EXTRA_REFS = JSON.stringify(extraRefPaths);
  if (styleRefPath)
    env.DASHBOARD_STYLE_REF_PATH = styleRefPath;
  // Which poster style template was picked (e.g. "03-type-overlay") — the
  // renderer maps this to a matching overlay type voice. "custom" for manual
  // style-ref uploads; unset → layout-based rotation.
  if (stylePreset) env.DASHBOARD_STYLE_PRESET = String(stylePreset).slice(0, 64);
  // User-entered promotion (e.g. "35% OFF until June 30") — rendered verbatim
  // as a poster badge; the AI never invents promos on its own.
  if (promo) env.DASHBOARD_PROMO = String(promo).slice(0, 40);
  if (aspectDist) env.DASHBOARD_ASPECT_DIST = String(aspectDist);
  // TikTok Shop product-listing inputs for render-shop-tranzzie.mjs.
  if (isShop) {
    if (shopPlanEnv) env.DASHBOARD_SHOP_PLAN = shopPlanEnv; // studio mode
    env.DASHBOARD_SHOP_PHOTOS = JSON.stringify(shopPhotoPaths);
    let specArr = [];
    try { specArr = JSON.parse(shopSpecs || "[]"); } catch {}
    if (!Array.isArray(specArr)) specArr = String(shopSpecs || "").split(",").filter(Boolean);
    env.DASHBOARD_SHOP_SPECS = JSON.stringify(specArr);
    if (shopProduct) env.DASHBOARD_SHOP_PRODUCT = String(shopProduct).slice(0, 40);
    if (shopColor) env.DASHBOARD_SHOP_COLOR = String(shopColor).slice(0, 30);
    if (shopMaterial) env.DASHBOARD_SHOP_MATERIAL = String(shopMaterial).slice(0, 30);
    // TikTok Shop product listings are always square — no other aspect option.
    env.DASHBOARD_SHOP_ASPECT = "1:1";
  }
  if (isBrand && brandPlanEnv) env.DASHBOARD_BRANDCARD_PLAN = brandPlanEnv;
  env.JURIE_NO_OPEN = "1";
  const spec = {
    client,
    clientCfg: c,
    header,
    args: isShop
      ? ["scripts/render-shop-tranzzie.mjs"]
      : isBrand
        ? ["scripts/render-brandcard-tranzzie.mjs"]
        : isEyeglasses
          ? ["scripts/batch-eyeglasses-tranzzie.mjs", String(n), t]
          : ["scripts/batch-jurie.mjs", "--client", client, String(n), t],
    env,
  };
  const label = isShop
    ? `${c.label} · Shop · "${String(shopProduct || "product").slice(0, 30)}"`
    : isBrand
    ? `${c.label} · Brand card`
    : `${c.label} · ${n} poster(s)` + (t ? ` · "${t.slice(0, 40)}"` : "");
  // Busy → queue the request instead of rejecting it; it starts automatically
  // when the current batch finishes.
  if (jobActuallyRunning()) {
    if (genQueue.length >= GEN_QUEUE_MAX)
      return res.status(429).json({ error: `Generation queue is full (${GEN_QUEUE_MAX} waiting). Try again later.` });
    genQueue.push({ id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label, spec });
    log(`⏳ Queued: ${label} — position ${genQueue.length} in line.`);
    return res.json({ ok: true, queued: true, position: genQueue.length });
  }
  startGenJob(spec);
  res.json({ ok: true, queued: false });
});

// Brand-a-Photo — 4 tagline ideas to pick from (instead of committing to one
// AI-written line sight-unseen). A direct Gemini call, not a spawned job —
// fast, no render, no job queue involved.
app.post("/api/brandcard/taglines", async (req, res) => {
  const { productName, hint } = req.body || {};
  applyGcpEnv();
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT;
  const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  if (!gcpProject) return res.status(400).json({ error: "No GCP project configured for AI taglines." });
  try {
    const voice = await fs.readFile(path.join(projectRoot, "scripts", "voice-profile-tranzzie.md"), "utf-8").catch(() => "");
    const ai = new GoogleGenAI({ vertexai: true, project: gcpProject, location: gcpLocation });
    const hintTxt = String(hint || "").trim().slice(0, 140);
    const nameTxt = String(productName || "").trim().slice(0, 40);
    const extra = (hintTxt ? `\nHint / topic to build on: "${hintTxt}".` : "") + (nameTxt ? `\nFrame name: "${nameTxt}".` : "");
    const resp = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text:
        "Write 4 DIFFERENT short marketing taglines (captions) for a Tranzzie Eyeglasses " +
        "product poster — each max ~10 words, punchy, warm, benefit-led. Eyewear / eye-comfort " +
        "themed. Brand-safe: describe FEATURES and comfort, never a medical cure or guarantee. " +
        "No hashtags, no emojis, no quotation marks, no brand name, no numbering. " +
        "Return ONLY the 4 taglines, one per line." + extra }] }],
      config: { systemInstruction: voice || "You write for a friendly Filipino optical clinic, Tranzzie Eyeglasses.", temperature: 1.0 },
    });
    const lines = String(resp.text || "")
      .split("\n")
      .map((l) => l.trim().replace(/^[-*\d.)\s]+/, "").replace(/^["']|["']$/g, "").trim())
      .filter(Boolean)
      .slice(0, 4);
    if (!lines.length) return res.status(502).json({ error: "AI returned no taglines — try again." });
    res.json({ taglines: lines });
  } catch (e) {
    res.status(502).json({ error: `AI tagline request failed: ${(e?.message || e)?.toString().slice(0, 160)}` });
  }
});

// Spawn one generation batch and wire its lifecycle. When it exits, the next
// queued spec (if any) starts automatically.
function startGenJob(spec) {
  const { client, clientCfg, header, args, env } = spec;
  job = { running: true, client, log: [], code: null };
  log(header);
  // Free volume space before the run (ENOSPC mid-render kills posters) and
  // surface what's left so low-disk failures stop being a mystery.
  const preflight = (async () => {
    if (!EXPORT_BASE) return;
    // Only prunes if the user opted in via STUDIO_KEEP_BATCHES; otherwise no-op.
    const pruned = await pruneOldBatches(clientCfg);
    if (pruned)
      log(`🧹 Pruned ${pruned} old batch folder(s) — keeping the ${KEEP_BATCHES} newest (STUDIO_KEEP_BATCHES).`);
    // We do NOT auto-delete export batches to reclaim space anymore. Just
    // surface the disk situation. The warning is RELATIVE to the volume's total
    // size — a tiny volume (e.g. 0.45 GB) must not false-alarm "low disk" when
    // it's actually nearly empty (the old fixed 0.5 GB bar was bigger than the
    // whole volume, so it warned every time).
    let freeGB = null, totalGB = null;
    try {
      const st = await fs.statfs(EXPORT_BASE);
      const bs = Number(st.bsize);
      freeGB = (Number(st.bavail) * bs) / 1e9;
      totalGB = (Number(st.blocks) * bs) / 1e9;
    } catch { /* statfs unsupported */ }
    if (freeGB !== null) {
      log(`💾 Volume: ${freeGB.toFixed(2)} GB free of ${(totalGB || 0).toFixed(2)} GB`);
      const lowBar = Math.max(0.08, (totalGB || 0) * 0.12); // ~12% free, min 80 MB
      if (freeGB < lowBar)
        log("⚠ Volume nearly full — delete old batches in the Batches tab, or increase the Railway volume size. (Your batches are NOT auto-deleted.)");
      // HARD FLOOR — with effectively zero space the render is guaranteed to
      // ENOSPC *after* burning the whole Gemini budget (this happened: 8/8
      // shots generated, then every card write failed). Fail fast BEFORE the
      // child spawns so no AI quota is spent. We still never auto-delete —
      // freeing space stays the user's call.
      const minFree = Math.max(0.02, parseFloat(process.env.STUDIO_MIN_FREE_GB || "0.05") || 0.05);
      if (freeGB < minFree) {
        log(`✗ Volume is effectively FULL (${Math.round(freeGB * 1024)} MB free — need at least ${Math.round(minFree * 1024)} MB). Aborting BEFORE any AI generation so your image quota is not wasted.`);
        log("  Free up space first — delete old batches in the Batches tab, or grow the Railway volume (click the volume → Live Resize) — then run this batch again.");
        // Mark aborted; the .then() below skips the spawn and chains the queue.
        // (Chaining HERE would race: startGenJob reassigns `job`, and the
        // .then() would then see the new job as running and spawn this one.)
        job.running = false;
        job.code = 1;
        job.abortedPreflight = true;
      }
    }
  })();
  preflight.catch(() => {}).then(() => {
    if (!job?.running) {
      // Preflight aborted (disk full): advance the queue like a normal exit
      // would — each queued batch gets its own fail-fast + clear message.
      if (job?.abortedPreflight) {
        const nxt = genQueue.shift();
        if (nxt) {
          log(`▶ Starting queued batch: ${nxt.label} (${genQueue.length} more waiting)…`);
          try { startGenJob(nxt.spec); }
          catch (e) { log(`✗ Queued batch failed to start: ${e.message}`); }
        }
      }
      return; // otherwise: cleared while pruning — keep old behavior
    }
    const child = spawn("node", args, { cwd: projectRoot, env });
    job.child = child;
    const onData = (b) =>
      String(b)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach(log);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    // Auto-kill if job hangs for more than 12 minutes (e.g. stalled Gemini call).
    if (jobTimer) clearTimeout(jobTimer);
    jobTimer = setTimeout(() => {
      if (job?.running) {
        log("⚠ Job timed out after 12 min — killing process. You can generate again.");
        try { child.kill("SIGTERM"); } catch {}
        job.running = false;
        job.code = -1;
        jobTimer = null;
      }
    }, JOB_TIMEOUT_MS);
    child.on("exit", async (code) => {
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
      job.running = false;
      job.code = code;
      if (code === 0) {
        // Verify files were actually written — batch can exit 0 on silent Gemini failures.
        let written = 0;
        try {
          const expDir = clientExportDir(clientCfg);
          const stamps = (await fs.readdir(expDir)).filter(safeStamp).sort().reverse();
          if (stamps[0]) {
            written = (await fs.readdir(path.join(expDir, stamps[0])))
              .filter((f) => f.endsWith(".png")).length;
          }
        } catch { /* filesystem unavailable — still show done */ }
        if (written > 0) {
          log(`✓ Done — ${written} poster(s) ready. Added to Queue for review.`);
          // Auto-add to queue for approval before posting.
          try {
            const expDir = clientExportDir(clientCfg);
            const stamps2 = (await fs.readdir(expDir)).filter(safeStamp).sort().reverse();
            if (stamps2[0]) {
              await addBatchToQueue(client, path.join(expDir, stamps2[0]), stamps2[0]);
              log("📋 Batch added to Queue tab — review and schedule from there.");
            }
          } catch (qErr) { console.warn("Queue add error:", qErr.message); }
        } else {
          log("✓ Done. Check Batches tab (no PNGs found — Gemini may have had an error above).");
        }
      } else {
        log(`✗ Exited (${code}). Check the log above for the error.`);
      }
      // Chain the next queued generation (regardless of this one's outcome).
      const nxt = genQueue.shift();
      if (nxt) {
        log(`▶ Starting queued batch: ${nxt.label} (${genQueue.length} more waiting)…`);
        try { startGenJob(nxt.spec); }
        catch (e) { log(`✗ Queued batch failed to start: ${e.message}`); }
      }
    });
  });
}

// ── Batches / posters (per client export dir) ─────────────────────────────
const safeStamp = (s) => /^[0-9T:\-]+$/.test(s);
const clientExportDir = (c) =>
  EXPORT_BASE ? path.join(EXPORT_BASE, c.id) : c.exportDir;

// ── Volume retention ───────────────────────────────────────────────────────
// Every batch lands in <exportDir>/<stamp>/ and used to stay forever — big
// test batches eventually filled the Railway volume and renders died with
// ENOSPC mid-write. Before each generate run, keep only the newest N batch
// folders per client. The queue auto-prunes entries whose folder is gone.
// Auto-retention is OFF by default — we NEVER silently delete a user's export
// batches. (An earlier version auto-deleted old batches across clients to free
// disk, which destroyed batch history.) A user who explicitly wants a cap can
// set STUDIO_KEEP_BATCHES=N to keep only the newest N per client. 0/unset = keep
// everything; disk pressure is surfaced as a warning instead.
const KEEP_BATCHES = Math.max(0, parseInt(process.env.STUDIO_KEEP_BATCHES || "0", 10) || 0);
async function pruneOldBatches(clientCfg) {
  if (KEEP_BATCHES <= 0) return 0; // retention disabled — never auto-delete
  try {
    const base = clientExportDir(clientCfg);
    const stamps = (await fs.readdir(base))
      .filter(safeStamp)
      .sort()
      .reverse();
    const doomed = stamps.slice(KEEP_BATCHES);
    for (const name of doomed) {
      await fs.rm(path.join(base, name), { recursive: true, force: true }).catch(() => {});
    }
    // Drop queue entries that pointed at the deleted batches — otherwise the
    // Queue tab shows 404 images and "Send to Buffer" schedules posts whose
    // image URL no longer resolves.
    if (doomed.length) {
      const doomedSet = new Set(doomed);
      await updateQueue(clientCfg.id, (queue) => {
        const kept = queue.filter((e) => !doomedSet.has(e.stamp));
        return kept.length !== queue.length ? kept : undefined;
      });
    }
    return doomed.length;
  } catch {
    return 0; // export dir may not exist yet — nothing to prune
  }
}

// Free GB available on the export volume (null if statfs is unsupported).
async function exportFreeGB() {
  try {
    const st = await fs.statfs(EXPORT_BASE);
    return (Number(st.bavail) * Number(st.bsize)) / 1e9;
  } catch {
    return null;
  }
}

// Recursively sum file sizes under a path (bytes). Bounded; ignores errors.
async function dirSizeBytes(p) {
  let total = 0;
  let ents;
  try { ents = await fs.readdir(p, { withFileTypes: true }); } catch { return 0; }
  for (const e of ents) {
    const fp = path.join(p, e.name);
    try {
      if (e.isDirectory()) total += await dirSizeBytes(fp);
      else { const st = await fs.stat(fp); total += st.size; }
    } catch { /* skip */ }
  }
  return total;
}

// READ-ONLY disk inspector — reports volume free/total + a size breakdown of
// every top-level dir under EXPORT_BASE (and one level into _studio-data) so we
// can see what's actually using the space. Deletes nothing.
app.get("/api/debug/disk", async (_req, res) => {
  if (!EXPORT_BASE) return res.json({ error: "no EXPORT_BASE (local dev)" });
  const out = { freeGB: null, totalGB: null, usedGB: null, items: [] };
  try {
    const st = await fs.statfs(EXPORT_BASE);
    const bs = Number(st.bsize);
    out.freeGB = +((Number(st.bavail) * bs) / 1e9).toFixed(3);
    out.totalGB = +((Number(st.blocks) * bs) / 1e9).toFixed(3);
    out.usedGB = +(((Number(st.blocks) - Number(st.bfree)) * bs) / 1e9).toFixed(3);
  } catch { /* statfs unsupported */ }
  const mb = (b) => +(b / 1e6).toFixed(1);
  const add = async (label, p) => out.items.push({ path: label, sizeMB: mb(await dirSizeBytes(p)) });
  try {
    for (const e of await fs.readdir(EXPORT_BASE, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = path.join(EXPORT_BASE, e.name);
      if (e.name === "_studio-data") {
        // break studio-data down one more level (config vs public/uploads)
        for (const s of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) {
          if (s.isDirectory()) await add(`_studio-data/${s.name}`, path.join(p, s.name));
        }
      } else {
        const stamps = (await fs.readdir(p).catch(() => [])).filter(safeStamp);
        out.items.push({ path: e.name, sizeMB: mb(await dirSizeBytes(p)), batchCount: stamps.length });
      }
    }
  } catch (e) { out.error = e.message; }
  out.items.sort((a, b) => b.sizeMB - a.sizeMB);
  res.json(out);
});


app.get("/api/batches", async (req, res) => {
  const c = await getClient(req.query.client);
  if (!c) return res.json([]);
  const baseDir = clientExportDir(c);
  let stamps = [];
  try {
    stamps = (await fs.readdir(baseDir))
      .filter(safeStamp)
      .sort()
      .reverse();
  } catch {
    return res.json([]);
  }
  // Read every batch dir in parallel instead of one-at-a-time — with 18+
  // batches this was the main slow part of opening the Batches tab (each
  // readdir+readFile round-trip to the volume serialized after the last).
  // Promise.all preserves the stamps[] order (newest-first).
  const out = (
    await Promise.all(
      stamps.map(async (stamp) => {
        const dir = path.join(baseDir, stamp);
        let files = [];
        try {
          files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
        } catch {
          return null;
        }
        let captions = "";
        try {
          captions = await fs.readFile(path.join(dir, "captions.txt"), "utf-8");
        } catch {
          /* none */
        }
        return { stamp, count: files.length, files, captions };
      }),
    )
  ).filter(Boolean);
  // Attach per-poster queue statuses so the Batches tab can show approve/posted badges.
  try {
    const queue = await readQueue(c.id);
    const statusMap = {};
    for (const entry of queue) {
      for (const p of entry.posters) {
        statusMap[`${entry.stamp}/${p.filename}`] = p.status;
      }
    }
    for (const batch of out) {
      batch.statuses = {};
      for (const f of batch.files) {
        const s = statusMap[`${batch.stamp}/${f}`];
        if (s) batch.statuses[f] = s;
      }
    }
  } catch { /* statuses optional */ }
  res.json(out);
});

// ── Poster tagging — approve / decline / mark-as-posted from Batches tab ──
app.post("/api/poster/tag", async (req, res) => {
  const { client, stamp, filename, status } = req.body || {};
  const valid = ["approved", "declined", "posted", "pending"];
  if (!client || !stamp || !filename || !valid.includes(status))
    return res.status(400).json({ error: "Invalid params" });
  const clientCfg = await getClient(client);
  if (!clientCfg) return res.status(400).json({ error: "Unknown client" });

  let fsErr = null;
  await updateQueue(client, async (queue) => {
    let entry = queue.find(e => e.stamp === stamp);
    if (!entry) {
      // Create a queue entry for this batch on the fly.
      try {
        const batchDir = path.join(clientExportDir(clientCfg), stamp);
        const pngs = (await fs.readdir(batchDir)).filter(f => f.endsWith(".png")).sort();
        let captText = "";
        try { captText = await fs.readFile(path.join(batchDir, "captions.txt"), "utf-8"); } catch {}
        // Index-based caption mapping — same as addBatchToQueue (positional zip
        // shifted captions after any failed/deleted poster).
        const capByIdx = {};
        const capList = [];
        for (const block of captText.split(/^-{20,}\s*$/m)) {
          const m = block.match(/^\s*#(\d+)\s*([\s\S]*)$/);
          const text = (m ? m[2] : block).trim();
          if (!text) continue;
          capList.push(text);
          if (m) capByIdx[parseInt(m[1], 10)] = text;
        }
        entry = {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          stamp, clientId: client,
          createdAt: new Date().toISOString(),
          posters: pngs.map((fn, i) => {
            const fm = fn.match(/^[a-z0-9_]+-(\d+)-/i);
            const caption = fm ? (capByIdx[parseInt(fm[1], 10)] || "") : (capList[i] || "");
            return { filename: fn, caption, status: "pending" };
          }),
          sentAt: null, scheduledStart: null, spacingMinutes: 60,
        };
        queue.unshift(entry);
      } catch (err) {
        fsErr = err;
        return undefined; // no write
      }
    }
    let poster = entry.posters.find(p => p.filename === filename);
    if (!poster) {
      poster = { filename, caption: "", status };
      entry.posters.push(poster);
    } else {
      poster.status = status;
    }
    return queue;
  });
  if (fsErr) return res.status(500).json({ error: "Could not read batch: " + fsErr.message });
  res.json({ ok: true, status });
});
app.get("/posters/:client/:stamp/:file", async (req, res) => {
  const { client, stamp, file } = req.params;
  const c = await getClient(client);
  if (!c || !safeStamp(stamp) || !/^[\w.\- ]+\.png$/.test(file))
    return res.status(400).end();
  const cBase = clientExportDir(c);
  const fp = path.join(cBase, stamp, file);
  if (!fp.startsWith(path.join(cBase, stamp)))
    return res.status(400).end();
  if (req.query.dl)
    res.set("Content-Disposition", `attachment; filename="${file}"`);
  // No-store: browser must always fetch fresh. Combined with the per-page-load
  // ?t= buster in the client, this prevents any broken-response caching.
  if (!req.query.dl) res.set("Cache-Control", "no-store");
  res.sendFile(fp, {}, (err) => {
    if (err && !res.headersSent) {
      console.warn(`[poster] ${err.code || err.message} – ${fp}`);
      res.status(404).end();
    }
  });
});
// DELETE a single poster PNG from a batch
app.delete("/api/poster", async (req, res) => {
  const { client, stamp, file } = req.query;
  const c = await getClient(client);
  if (!c || !safeStamp(stamp) || !/^[\w.\- ]+\.png$/.test(file))
    return res.status(400).json({ error: "bad request" });
  const fp = path.join(clientExportDir(c), stamp, file);
  if (!fp.startsWith(clientExportDir(c))) return res.status(400).json({ error: "bad path" });
  try { await fs.unlink(fp); res.json({ ok: true }); }
  catch { res.status(404).json({ error: "File not found" }); }
});

// DELETE an entire batch folder (also removes any matching queue entry to avoid
// orphaned pointers that show broken images in the Queue tab).
app.delete("/api/batch", async (req, res) => {
  const { client, stamp } = req.query;
  const c = await getClient(client);
  if (!c || !safeStamp(stamp)) return res.status(400).json({ error: "bad request" });
  const dir = path.join(clientExportDir(c), stamp);
  if (!dir.startsWith(clientExportDir(c))) return res.status(400).json({ error: "bad path" });
  try {
    await fs.rm(dir, { recursive: true, force: true });
    // Remove any queue entry that references this stamp so the Queue tab
    // doesn't show broken image links after the batch folder is gone.
    try {
      await updateQueue(c.id, (queue) => {
        const pruned = queue.filter(e => e.stamp !== stamp);
        return pruned.length !== queue.length ? pruned : undefined;
      });
    } catch { /* queue cleanup is best-effort */ }
    res.json({ ok: true });
  } catch { res.status(404).json({ error: "Batch not found" }); }
});

app.post("/api/reveal", async (req, res) => {
  const c = await getClient(req.body?.client);
  if (!c) return res.status(400).json({ error: "bad client" });
  if (HOSTED || process.platform !== "darwin")
    return res.json({ ok: true, hosted: true });
  const stamp = String(req.body?.stamp || "");
  const base = clientExportDir(c);
  const target = safeStamp(stamp) ? path.join(base, stamp) : base;
  spawn("open", [target], { stdio: "ignore" });
  res.json({ ok: true });
});

// ── B-Roll maker ──────────────────────────────────────────────────────────
const BROLL_BASE = EXPORT_BASE
  ? path.join(EXPORT_BASE, "broll")
  : path.join(projectRoot, "..", "..", "brolls", "generated");

// Ensure the ephemeral working JSON exists in out/ for the staged frames/
// character steps, restoring it from the persistent volume copy if a container
// restart wiped out/. Returns the out/ path (stem stays unique per set so frame
// filenames don't collide) or null if the set can't be found anywhere.
async function ensureSetInOut(stamp) {
  const outPath = path.join(projectRoot, "out", `broll-${stamp}.json`);
  try { await fs.access(outPath); return outPath; } catch { /* missing — try to restore */ }
  const vpath = path.join(BROLL_BASE, stamp, "analyzed.json");
  try {
    await fs.access(vpath);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.copyFile(vpath, outPath);
    return outPath;
  } catch { return null; }
}
const brollUpload = multer({
  storage: multer.diskStorage({
    destination: async (_r, _f, cb) => {
      const d = path.join(projectRoot, "out", "broll-uploads");
      await fs.mkdir(d, { recursive: true });
      cb(null, d);
    },
    filename: (_r, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
  // 100 MB per upload — Railway's edge proxy reliably accepts bodies up to
  // ~120 MB but drops bigger ones with no JSON response, which surfaces as
  // "Failed" with no detail in the browser. Hard-stop here so the user sees
  // a clean rejection instead. Gemini handles ≤19 MB inline; bigger files
  // go through the Files API.
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Custom multer wrapper so file-size errors come back as a clean JSON 400
// instead of bubbling up as an HTML 500.
const brollVideoUpload = (req, res, next) => {
  brollUpload.single("video")(req, res, (err) => {
    if (err) {
      const code = err.code || "UPLOAD_ERROR";
      const msg =
        code === "LIMIT_FILE_SIZE"
          ? "Video too large (max 100 MB). Trim to a shorter clip or compress."
          : `Upload failed (${code}): ${err.message || String(err)}`;
      console.warn(`broll upload err: ${code} — ${err.message || err}`);
      return res.status(400).json({ error: msg });
    }
    next();
  });
};

app.post(
  "/api/broll/generate",
  brollVideoUpload,
  async (req, res) => {
    if (job?.running)
      return res.status(409).json({ error: "A job is already running." });
    const aspect = req.body?.aspect === "16:9" ? "16:9" : "9:16";
    let n = parseInt(req.body?.count, 10);
    if (!Number.isFinite(n)) n = 8;
    n = Math.max(1, Math.min(40, n));
    const characterId = String(req.body?.characterId || "");
    const scriptText = String(req.body?.script || "").trim();
    // Video uploads now work on hosted — Gemini analyzes the video directly
    // (sees frames + hears audio), no ffmpeg/whisperx required.
    const args = [
      "scripts/broll-batch.mjs",
      "--aspect",
      aspect,
      "--count",
      String(n),
    ];
    if (characterId && characterId !== "none")
      args.push("--character", characterId);
    let scriptFile = null;
    if (req.file) {
      args.push("--video", req.file.path);
    } else if (scriptText.length > 10) {
      scriptFile = path.join(
        projectRoot,
        "out",
        `broll-input-${Date.now()}.txt`,
      );
      await fs.writeFile(scriptFile, scriptText);
      args.push("--script", scriptFile);
    } else {
      return res
        .status(400)
        .json({ error: "Provide a script (10+ chars) or a video file." });
    }
    if (!guard(req, res)) {
      // Rate-limited after upload — clean up temp files so disk doesn't fill up.
      if (req.file) fs.unlink(req.file.path).catch(() => {});
      if (scriptFile) fs.unlink(scriptFile).catch(() => {});
      return;
    }
    job = { running: true, client: "broll", log: [], code: null };
    log(
      `▶ B-Roll: ${n} shot(s), ${aspect}` +
        (characterId && characterId !== "none"
          ? `, character ${characterId}`
          : "") +
        (req.file ? " (from video)" : " (from script)") +
        "…",
    );
    const env = { ...process.env, BROLL_EXPORT_DIR: BROLL_BASE };
    const child = spawn("node", args, { cwd: projectRoot, env });
    job.child = child;
    const onData = (b) =>
      String(b).split(/\r?\n/).filter(Boolean).forEach(log);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    if (jobTimer) clearTimeout(jobTimer);
    jobTimer = setTimeout(() => {
      if (job?.running) {
        log("⚠ B-Roll job timed out after 12 min — killing process. You can generate again.");
        try { child.kill("SIGTERM"); } catch {}
        job.running = false;
        job.code = -1;
        jobTimer = null;
      }
    }, JOB_TIMEOUT_MS);
    child.on("exit", (code) => {
      if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
      job.running = false;
      job.code = code;
      log(code === 0 ? "✓ Done. Refresh B-Roll sets." : `✗ Exited (${code}). Check the log above for the error.`);
    });
    res.json({ ok: true });
  },
);

// ── Format Hacker ─────────────────────────────────────────────────────────
// Deconstruct a viral ad (screenshot | pasted URL | auto-discovered breakdown)
// with Gemini multimodal, then adapt it into 2 client-voiced video storyboards.
// Runs INLINE (a single awaited Gemini call) — deliberately NOT routed through
// the SSE `job` singleton, so the B-Roll/Video queue is never blocked by it.
app.post("/api/hack-format", async (req, res) => {
  const client = req.body?.client === "tranzzie" ? "tranzzie" : "jurie";
  const method = String(req.body?.method || "").trim();
  if (!["image", "url", "auto"].includes(method))
    return res.status(400).json({ error: "Pick an input method." });
  const image = typeof req.body?.image === "string" ? req.body.image : "";
  const mimeType = String(req.body?.mimeType || "image/png");
  const url = String(req.body?.url || "").trim();
  const topic = String(req.body?.topic || "").trim().slice(0, 200);
  if (method === "image" && image.length < 32)
    return res.status(400).json({ error: "Upload a screenshot of the ad first." });
  if (method === "url" && !/^https?:\/\//i.test(url))
    return res.status(400).json({ error: "Paste a valid http(s) link." });
  if (!guard(req, res)) return; // daily/hourly cost cap — this is a paid Gemini call
  try {
    const out = await hackFormat({ client, method, imageBase64: image, mimeType, url, topic });
    res.json({ ok: true, ...out });
  } catch (e) {
    log(`✗ Format Hacker: ${e?.message || e}`);
    res.status(502).json({ error: e?.message || "Format Hacker failed. Try again." });
  }
});

// ── Staged B-Roll flow (analyze → review → frames) ────────────────────────
// Run a SEQUENCE of node B-Roll scripts as ONE job, streaming logs over the
// shared SSE channel. Stops on the first non-zero exit. (analyze = 1 step;
// frames + deliverable = 2 steps.) Mirrors the one-shot job lifecycle above.
function startBrollSteps(steps, label) {
  job = { running: true, client: "broll", log: [], code: null };
  log(label);
  const env = { ...process.env, BROLL_EXPORT_DIR: BROLL_BASE };
  const onData = (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(log);
  let i = 0;
  const finish = (code) => {
    if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
    job.running = false;
    job.code = code;
    log(code === 0 ? "✓ Done." : `✗ Exited (${code}). Check the log above for the error.`);
  };
  const runNext = () => {
    if (i >= steps.length) return finish(0);
    const child = spawn("node", steps[i], { cwd: projectRoot, env });
    job.child = child;
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (code !== 0) return finish(code);
      i += 1;
      runNext();
    });
  };
  if (jobTimer) clearTimeout(jobTimer);
  jobTimer = setTimeout(() => {
    if (job?.running) {
      log("⚠ B-Roll job timed out after 12 min — killing process. You can try again.");
      try { job.child?.kill("SIGTERM"); } catch {}
      job.running = false;
      job.code = -1;
      jobTimer = null;
    }
  }, JOB_TIMEOUT_MS);
  runNext();
}

// Stage 1 — analyze only: idea | script | video → storyboard json in out/.
// The dashboard pins the stamp so it can reference the set across stages.
app.post("/api/broll/analyze", brollVideoUpload, async (req, res) => {
  if (jobActuallyRunning())
    return res.status(409).json({ error: "A job is already running. If it seems stuck, hit Unlock to reset." });
  const aspect = req.body?.aspect === "16:9" ? "16:9" : "9:16";
  let n = parseInt(req.body?.count, 10);
  if (!Number.isFinite(n)) n = 8;
  n = Math.max(1, Math.min(40, n));
  const idea = String(req.body?.idea || "").trim();
  const scriptText = String(req.body?.script || "").trim();
  // mode: "story" (full narrative video) routes to the story director; default
  // "broll" (cutaways). Same staged pipeline either way.
  const mode = req.body?.mode === "story" ? "story" : "broll";
  // The selected character MUST reach analyze — without it every run is
  // charMode "none" (no protagonist, object-only scenes that read like b-roll).
  const characterId = String(req.body?.characterId || "").trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const args = ["scripts/broll-analyze.mjs", "--aspect", aspect, "--count", String(n), "--stamp", stamp];
  if (mode === "story") args.push("--mode", "story");
  if (characterId && characterId !== "none") args.push("--character", characterId);
  let tmpFile = null;
  let kind = "source";
  if (req.file) {
    args.push("--video", req.file.path);
    kind = "video";
  } else if (idea.length >= 4) {
    tmpFile = path.join(projectRoot, "out", `broll-idea-${Date.now()}.txt`);
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, idea);
    args.push("--idea", tmpFile);
    kind = "idea";
  } else if (scriptText.length > 10) {
    tmpFile = path.join(projectRoot, "out", `broll-input-${Date.now()}.txt`);
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, scriptText);
    args.push("--script", tmpFile);
    kind = "script";
  } else {
    return res.status(400).json({ error: "Provide an idea, a script (10+ chars), or a video." });
  }
  if (!guard(req, res)) {
    if (req.file) fs.unlink(req.file.path).catch(() => {});
    if (tmpFile) fs.unlink(tmpFile).catch(() => {});
    return;
  }
  startBrollSteps([args], `▶ ${mode === "story" ? "Video" : "B-Roll"}: analyzing ${kind} → ${n} scene(s), ${aspect}…`);
  res.json({ ok: true, stamp });
});

// Hydrate a set (storyboard) — prefer the working json in out/, then the volume
// copy (survives restarts), then a delivered manifest.
app.get("/api/broll/set/:stamp", async (req, res) => {
  const stamp = String(req.params.stamp || "");
  if (!safeStamp(stamp)) return res.status(400).json({ error: "bad stamp" });
  for (const p of [
    path.join(projectRoot, "out", `broll-${stamp}.json`),
    path.join(BROLL_BASE, stamp, "analyzed.json"),
    path.join(BROLL_BASE, stamp, "manifest.json"),
  ]) {
    try {
      return res.json(JSON.parse(await fs.readFile(p, "utf-8")));
    } catch {
      /* try next */
    }
  }
  res.status(404).json({ error: "set not found" });
});

// Stage 3 — generate first frames for an analyzed set, then build the
// deliverable so the finished set shows up in SETS.
app.post("/api/broll/frames", async (req, res) => {
  if (jobActuallyRunning())
    return res.status(409).json({ error: "A job is already running. If it seems stuck, hit Unlock to reset." });
  const stamp = String(req.query.stamp || req.body?.stamp || "");
  if (!safeStamp(stamp)) return res.status(400).json({ error: "bad stamp" });
  // Restore the working JSON from the volume if a restart wiped out/.
  const jsonPath = await ensureSetInOut(stamp);
  if (!jsonPath) {
    return res.status(404).json({ error: "Analyzed set not found — run analyze first." });
  }
  if (!guard(req, res)) return;
  startBrollSteps(
    [
      ["scripts/broll-frames.mjs", jsonPath],
      ["scripts/broll-deliverable.mjs", jsonPath],
    ],
    `▶ B-Roll: generating first frames for ${stamp}…`,
  );
  res.json({ ok: true, stamp });
});

// Stage 2 — generate a consistent CHARACTER for a set from uploaded reference
// photos. Refs are staged under public/broll-characters/<stamp>/refs/, then
// broll-character.mjs renders character.png and records meta.sessionCharacter.
const brollCharStore = multer.diskStorage({
  destination: async (req, _f, cb) => {
    const stamp = String(req.query.stamp || "");
    if (!safeStamp(stamp)) return cb(new Error("bad stamp"), "");
    const d = path.join(projectRoot, "public", "broll-characters", stamp, "refs");
    try { await fs.mkdir(d, { recursive: true }); cb(null, d); } catch (e) { cb(e, ""); }
  },
  filename: (_r, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
const brollCharUpload = multer({ storage: brollCharStore, limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/broll/character", brollCharUpload.array("ref", 6), async (req, res) => {
  if (jobActuallyRunning())
    return res.status(409).json({ error: "A job is already running. If it seems stuck, hit Unlock to reset." });
  const stamp = String(req.query.stamp || "");
  if (!safeStamp(stamp)) return res.status(400).json({ error: "bad stamp" });
  // Restore the working JSON from the volume if a restart wiped out/, so
  // broll-character (which reads out/broll-<stamp>.json) can find the set.
  const jsonPath = await ensureSetInOut(stamp);
  if (!jsonPath) {
    return res.status(404).json({ error: "Analyzed set not found — run analyze first." });
  }
  let aspect = "9:16";
  try {
    aspect = (JSON.parse(await fs.readFile(jsonPath, "utf-8")).meta || {}).aspect || "9:16";
  } catch { /* keep default aspect */ }
  // Convert any HEIC (iPhone) refs in place so the model + previews can read them.
  for (const f of req.files || []) await convertHeicInPlace(f.path).catch(() => {});
  const refsDir = path.join(projectRoot, "public", "broll-characters", stamp, "refs");
  let have = [];
  try { have = (await fs.readdir(refsDir)).filter((f) => /\.(png|jpe?g|webp|heic|heif)$/i.test(f)); } catch { /* none */ }
  // Reference photos are OPTIONAL — with none, the AI invents ONE consistent
  // character from the typed description and/or the storyboard context.
  const desc = String(req.body?.description || "").trim().slice(0, 600);
  if (!guard(req, res)) return;
  const charArgs = ["scripts/broll-character.mjs", "--stamp", stamp, "--aspect", aspect];
  if (desc) charArgs.push("--desc", desc);
  startBrollSteps(
    [charArgs],
    `▶ ${stamp}: generating character ${have.length ? `(${have.length} ref photo${have.length === 1 ? "" : "s"})` : (desc ? "(from description)" : "(to fit the story)")}…`,
  );
  res.json({ ok: true, stamp });
});

// Serve a generated character / its reference previews (image-tree, ephemeral).
app.get("/broll-char/:stamp/:file", (req, res) => {
  const { stamp, file } = req.params;
  if (!safeStamp(stamp) || !/^[\w.\-]+\.(png|jpe?g|webp)$/i.test(file))
    return res.status(400).end();
  const base = path.join(projectRoot, "public", "broll-characters", stamp);
  const fp = path.join(base, file);
  if (!fp.startsWith(base)) return res.status(400).end();
  res.sendFile(fp, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

app.get("/api/broll/sets", async (_q, res) => {
  let stamps = [];
  try {
    stamps = (await fs.readdir(BROLL_BASE))
      .filter(safeStamp)
      .sort()
      .reverse();
  } catch {
    return res.json([]);
  }
  const out = [];
  for (const stamp of stamps) {
    const dir = path.join(BROLL_BASE, stamp);
    let man = null;
    try {
      man = JSON.parse(
        await fs.readFile(path.join(dir, "manifest.json"), "utf-8"),
      );
    } catch {
      continue;
    }
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      /* none */
    }
    const shots = (man.shots || []).map((s) => ({
      n: s.n,
      title: s.title,
      beat: s.beat,
      timecode: s.timecode,
      usesCharacter: s.usesCharacter,
      imagePrompt: s.imagePrompt,
      videoPrompt: s.videoPrompt,
      picked: !!s.picked,
      hasFrame: files.includes(`shot-${String(s.n).padStart(2, "0")}.png`),
    }));
    out.push({
      stamp,
      meta: man.meta || {},
      shots,
      hasHtml: files.includes("broll.html"),
    });
  }
  res.json(out);
});

app.get("/broll-asset/:stamp/:file", (req, res) => {
  const { stamp, file } = req.params;
  if (
    !safeStamp(stamp) ||
    !/^(shot-\d+\.png|broll\.html|manifest\.json)$/.test(file)
  )
    return res.status(400).end();
  const fp = path.join(BROLL_BASE, stamp, file);
  if (!fp.startsWith(path.join(BROLL_BASE, stamp)))
    return res.status(400).end();
  if (req.query.dl)
    res.set("Content-Disposition", `attachment; filename="${file}"`);
  res.sendFile(fp, ASSET_CACHE, (err) => {
    // Missing file must be a plain 404 — without this callback Express
    // emits an HTML 500 that browsers cache for 7 days (immutable).
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.post("/api/broll/pick", async (req, res) => {
  const stamp = String(req.body?.stamp || "");
  const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];
  if (!safeStamp(stamp)) return res.status(400).json({ error: "bad stamp" });
  const manPath = path.join(BROLL_BASE, stamp, "manifest.json");
  let man;
  try {
    man = JSON.parse(await fs.readFile(manPath, "utf-8"));
  } catch {
    return res.status(404).json({ error: "set not found" });
  }
  for (const s of man.shots || []) s.picked = picks.includes(s.n);
  await fs.writeFile(manPath, JSON.stringify(man, null, 2));
  // Mirror picks to the working out/ json so a future Veo run honors them.
  try {
    const created = man.meta?.createdAt;
    if (created) {
      const wp = path.join(projectRoot, "out", `broll-${created}.json`);
      const w = JSON.parse(await fs.readFile(wp, "utf-8"));
      for (const s of w.shots || []) s.picked = picks.includes(s.n);
      await fs.writeFile(wp, JSON.stringify(w, null, 2));
    }
  } catch {
    /* working json may be gone — manifest is the source of truth */
  }
  res.json({ ok: true, picked: picks.length });
});

// Zip + stream all PNGs in a folder (batch download).
const sendZip = async (dir, zipName, res) => {
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png"));
  } catch {
    return res.status(404).json({ error: "not found" });
  }
  if (!files.length) return res.status(404).json({ error: "no images" });
  const tmp = path.join("/tmp", `dl-${Date.now()}-${zipName}`);
  const zp = spawn("zip", ["-j", "-q", tmp, ...files], { cwd: dir });
  let responded = false;
  zp.on("error", () => {
    if (responded) return; responded = true;
    res.status(500).json({ error: "zip not available on server" });
  });
  zp.on("close", (code) => {
    if (responded) return; responded = true;
    if (code !== 0)
      return res.status(500).json({ error: "zip failed" });
    res.download(tmp, zipName, () => fs.unlink(tmp).catch(() => {}));
  });
};

app.get("/api/batch-zip", async (req, res) => {
  const c = await getClient(req.query.client);
  const stamp = String(req.query.stamp || "");
  if (!c || !safeStamp(stamp))
    return res.status(400).json({ error: "bad request" });
  await sendZip(
    path.join(clientExportDir(c), stamp),
    `${c.id}-${stamp}.zip`,
    res,
  );
});

app.get("/api/broll/zip", async (req, res) => {
  const stamp = String(req.query.stamp || "");
  if (!safeStamp(stamp))
    return res.status(400).json({ error: "bad request" });
  await sendZip(path.join(BROLL_BASE, stamp), `broll-${stamp}.zip`, res);
});

app.get("/api/env", (_q, res) =>
  res.json({
    hosted: HOSTED,
    dailyCap: CAP_DAY,
    ipPerHour: CAP_IP_HR,
    version: VERSION,
  }),
);
app.get("/healthz", (_q, res) => res.json({ ok: true }));
// Diagnostic: check if poster files are reachable from the server's perspective.
// Call: /api/debug/posters?client=tranzzie  — returns paths + stat results.
app.get("/api/debug/posters", async (req, res) => {
  const c = await getClient(req.query.client);
  if (!c) return res.status(400).json({ error: "unknown client" });
  const baseDir = clientExportDir(c);
  const report = { client: c.id, baseDir, batches: [] };
  let stamps = [];
  try { stamps = (await fs.readdir(baseDir)).filter(safeStamp).sort().reverse().slice(0, 3); }
  catch (err) { report.baseDirError = err.message; return res.json(report); }
  for (const stamp of stamps) {
    const entry = { stamp, files: [] };
    let files = [];
    try { files = (await fs.readdir(path.join(baseDir, stamp))).filter(f => f.endsWith(".png")).slice(0, 2); }
    catch (err) { entry.error = err.message; report.batches.push(entry); continue; }
    for (const f of files) {
      const fp = path.join(baseDir, stamp, f);
      let size = null, err = null;
      try { const st = await fs.stat(fp); size = st.size; }
      catch (e) { err = e.message; }
      entry.files.push({ file: f, path: fp, size, err });
    }
    report.batches.push(entry);
  }
  res.json(report);
});
app.get("/", (_q, res) => {
  res.set("Cache-Control", "no-store");
  res.type("html").send(PAGE);
});

// ── Try-On sub-site (/tryon) ──────────────────────────────────────────────
registerTryonRoutes(app, { EXPORT_BASE, guard });

// ── Eyeglasses reference-set generator (Eyeglasses tab) ───────────────────
registerEyeglassAngleRoutes(app, { guard });

app.listen(PORT, async () => {
  console.log(`\n  Quote Poster Studio → http://localhost:${PORT}\n  Try-On         → http://localhost:${PORT}/tryon\n`);
  // Boot-time sanity log: print export dirs for each client so Railway logs
  // immediately show whether the persistent volume is mounted where expected.
  console.log(`  EXPORT_BASE     : ${EXPORT_BASE || "(local dev)"}`);
  const clients = await readCfg("clients.json", []);
  for (const c of clients) {
    const dir = clientExportDir(c);
    let stat = "?";
    try { await fs.access(dir); stat = "✓ accessible"; } catch { stat = "✗ NOT FOUND"; }
    console.log(`  Export dir [${c.id}]: ${dir}  ${stat}`);
  }
});

// ── UI ────────────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quote Poster Studio</title><style>
:root{--gold:#E8B64A;--gold2:#ffe27a;--red:#E0564B;--bg:#0a0a0b;--bg2:#0d0d10;--panel:#121214;
--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.14);--txt:#ededee;--mut:#7f7f87}
*{box-sizing:border-box}::selection{background:var(--gold);color:#15120a}
body{margin:0;background:var(--bg);color:var(--txt);
font-family:'Montserrat',system-ui,-apple-system,Arial,sans-serif;
-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:8px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.18)}
header{position:sticky;top:0;z-index:20;padding:18px 32px;border-bottom:1px solid var(--line);
display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:var(--bg)}
header b{font-size:14px;font-weight:600;letter-spacing:.26em;color:var(--mut)}
header b i{color:var(--txt);font-style:normal}header .sp{flex:1}
select,input,textarea{background:transparent;border:1px solid var(--line2);color:var(--txt);
border-radius:8px;padding:10px 13px;font:inherit;transition:border-color .15s;outline:none}
select:focus,input:focus,textarea:focus{border-color:var(--gold)}
select:hover,input:hover,textarea:hover{border-color:rgba(255,255,255,.24)}
textarea{width:100%;min-height:92px;resize:vertical}
main{max-width:1080px;margin:0 auto;padding:34px 32px 64px}
nav{display:flex;gap:26px;margin:0 0 30px;border-bottom:1px solid var(--line);flex-wrap:wrap}
nav button{background:0;border:0;color:var(--mut);padding:0 2px 14px;cursor:pointer;font:inherit;
font-size:13px;letter-spacing:.02em;position:relative;transition:color .15s}
nav button:hover{color:var(--txt)}
nav button.on{color:var(--txt);font-weight:600}
nav button.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;
background:var(--gold);border-radius:2px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
padding:26px;margin-bottom:18px}
h2{margin:0 0 18px;font-size:11px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--mut)}
label{display:block;font-size:12px;color:var(--mut);margin:14px 0 6px}
.row{display:flex;gap:16px;flex-wrap:wrap}.row>div{flex:1;min-width:160px}
button{transition:opacity .15s,border-color .15s,color .15s}
button.go{background:var(--gold);color:#15120a;border:0;font-weight:700;letter-spacing:.01em;
padding:12px 24px;border-radius:8px;cursor:pointer}
button.go:hover{opacity:.88}button.go:disabled{opacity:.4;cursor:not-allowed}
button.sec{background:0;border:1px solid var(--line2);color:var(--mut);padding:10px 16px;
border-radius:8px;cursor:pointer;font-size:13px}
button.sec:hover{border-color:var(--gold);color:var(--txt)}
pre{background:#0d0d0f;border:1px solid var(--line);border-radius:10px;padding:15px;max-height:240px;
overflow:auto;font-size:12px;line-height:1.6;white-space:pre-wrap;color:#b9b9bf}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
figure{margin:0;min-width:0;background:#0d0d0f;border:1px solid var(--line);border-radius:12px;overflow:hidden;
position:relative;transition:border-color .2s}
figure:hover{border-color:var(--line2)}
/* Fixed thumbnail height keeps layout compact even while images are loading */
.poster-thumb{height:160px;overflow:hidden;background:#0d0d0f}
.poster-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dl,.cp{position:absolute;top:9px;background:rgba(0,0,0,.6);color:#fff;
border:1px solid rgba(255,255,255,.2);text-decoration:none;font-size:11px;font-weight:600;
padding:6px 11px;border-radius:7px;opacity:0;transition:opacity .18s,background .15s;
backdrop-filter:blur(4px);cursor:pointer;font-family:inherit}
.dl{right:9px}.cp{left:9px}
figure:hover .dl,figure:hover .cp{opacity:1}
.dl:hover,.cp:hover{background:var(--gold);color:#15120a;border-color:var(--gold)}
figcaption{display:none;padding:12px 13px;font-size:11px;line-height:1.55;color:var(--mut);
white-space:pre-wrap;max-height:112px;overflow:auto}
.muted{color:var(--mut);font-size:13px}
.ps-badge{position:absolute;top:8px;left:8px;font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px;letter-spacing:.04em;pointer-events:none;z-index:2}
.ps-actions{display:flex;flex-direction:column;gap:4px;padding:6px 8px 8px;background:#0d0d0f}
.ps-row{display:flex;gap:4px}
.ps-btn{flex:1;font-size:11px;font-weight:600;padding:7px 4px;border-radius:6px;cursor:pointer;border:1px solid var(--line2);background:transparent;color:var(--mut);transition:all .14s;white-space:nowrap;text-align:center}
.ps-btn-secondary{font-size:10px;padding:5px 4px;color:var(--mut);opacity:.7}
.ps-btn:hover{border-color:var(--gold);color:var(--txt)}
.ps-btn.ps-on-gold{border-color:var(--gold);color:var(--gold);background:rgba(232,182,74,.1)}
.ps-btn.ps-on-green{border-color:#3cb454;color:#3cb454;background:rgba(60,180,84,.1)}
.ps-btn.ps-on-red{border-color:var(--red);color:var(--red);background:rgba(224,86,75,.1)}
/* ── UX improvements ── */
.workflow-strip{display:flex;align-items:center;gap:0;margin:0 0 28px;background:var(--panel);
border:1px solid var(--line);border-radius:12px;overflow:hidden}
.wf-step{flex:1;padding:13px 16px;display:flex;align-items:center;gap:10px;font-size:13px}
.wf-step+.wf-step{border-left:1px solid var(--line)}
.wf-num{width:24px;height:24px;border-radius:50%;background:var(--line2);color:var(--mut);
font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.wf-step.wf-active .wf-num{background:var(--gold);color:#15120a}
.wf-step.wf-active .wf-label{color:var(--txt)}
.wf-label{font-size:12px;font-weight:600;color:var(--mut)}
.wf-sub{font-size:11px;color:var(--mut);margin-top:1px;line-height:1.3}
.callout{padding:14px 16px;border-radius:10px;margin-bottom:16px;font-size:13px;line-height:1.5}
.callout-info{background:rgba(232,182,74,.08);border:1px solid rgba(232,182,74,.2);color:var(--txt)}
.callout-tip{background:rgba(60,180,84,.07);border:1px solid rgba(60,180,84,.2);color:var(--txt)}
.adv-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--mut);
padding:11px 0;border:0;background:0;font:inherit;letter-spacing:.01em;transition:color .14s;width:100%}
.adv-toggle:hover{color:var(--txt)}
.adv-toggle::before{content:"▶";font-size:9px;transition:transform .2s;flex-shrink:0}
.adv-toggle.open::before{transform:rotate(90deg)}
.adv-body{display:none;padding-top:4px}
.adv-body.open{display:block}
.nav-badge{display:inline-flex;align-items:center;justify-content:center;
background:var(--red);color:#fff;font-size:9px;font-weight:700;
min-width:16px;height:16px;border-radius:999px;padding:0 4px;margin-left:5px;vertical-align:middle}
nav button .nav-badge{position:relative;top:-1px}
.section-label{font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;
color:var(--mut);margin:20px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.section-label:first-child{margin-top:0}
/* ── Mobile responsive ─────────────────────────────────── */
@media(max-width:640px){
  header{padding:14px 16px 12px;gap:10px}
  header h1{font-size:12px;letter-spacing:.16em}
  header b{font-size:11px}
  main{padding:20px 14px 56px}
  nav{gap:0;overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch;
    padding-bottom:1px;margin-bottom:20px;scrollbar-width:none}
  nav::-webkit-scrollbar{display:none}
  nav button{padding:0 10px 12px;font-size:12px;white-space:nowrap;flex-shrink:0}
  .workflow-strip{flex-direction:column;border-radius:10px}
  .wf-step{padding:10px 14px}
  .wf-step+.wf-step{border-left:0!important;border-top:1px solid var(--line)}
  .card{padding:18px 16px;border-radius:12px}
  h2{font-size:10px}
  .row{flex-direction:column;gap:10px}
  .row>div{min-width:0!important;flex:1 1 auto!important}
  .grid{grid-template-columns:repeat(3,1fr);gap:10px}
  .result-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .bx-head{flex-direction:column;align-items:flex-start;gap:10px}
  .bx-row{flex-direction:column;align-items:flex-start;gap:8px}
  button.go{width:100%;padding:14px}
  .opts-grid{grid-template-columns:1fr 1fr}
  .ps-btn{font-size:10px;padding:6px 4px}
  input[type=number]{width:100%!important}
  #g_count{width:100%!important}
}
@media(max-width:420px){
  .grid{grid-template-columns:1fr}
  .result-grid{grid-template-columns:1fr}
  .opts-grid{grid-template-columns:1fr}
}
.item{border:1px solid var(--line);border-radius:10px;padding:15px;margin-bottom:10px;
transition:border-color .15s}.item:hover{border-color:var(--line2)}
.pill{font-size:11px;color:var(--mut);border:1px solid var(--line2);padding:3px 10px;
border-radius:999px;margin-left:8px;font-weight:500}
.disabled{opacity:.42;pointer-events:none}
.sw{display:flex;gap:9px;align-items:center;font-size:13px;color:var(--mut)}
.bx-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:8px}
.bx-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bx-tools input{min-width:240px}
.bx-row{display:flex;justify-content:space-between;align-items:center;gap:10px}
#toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%) translateY(14px);
background:#1a1a1d;border:1px solid var(--line2);color:var(--txt);padding:12px 20px;border-radius:10px;
font-size:13px;opacity:0;pointer-events:none;transition:.22s;z-index:60}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.bad{border-color:var(--red);color:#ffd9d6}
/* — typography pass — */
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",
Roboto,system-ui,sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.006em;
text-rendering:optimizeLegibility;font-feature-settings:"kern","liga","calt"}
b,strong{font-weight:600}
header b{font-size:13px;font-weight:600;letter-spacing:.24em}
header b i{font-weight:600;letter-spacing:.24em}
nav button{font-size:13px;font-weight:500;letter-spacing:.01em}
nav button.on{font-weight:600}
h2{font-size:11px;font-weight:600;letter-spacing:.165em}
label{font-size:11.5px;font-weight:500;letter-spacing:.01em}
.row>div>label:first-child{margin-top:0}
input,select,textarea{font-size:13.5px;letter-spacing:-.003em}
button.go{font-size:13.5px;font-weight:600;letter-spacing:.012em}
button.sec{font-weight:500;letter-spacing:.005em}
.pill{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
font-variant-numeric:tabular-nums}
.muted{font-size:12.5px;line-height:1.55}
figcaption{font-size:11.5px;line-height:1.62;letter-spacing:-.003em}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
font-size:11.5px;line-height:1.62;letter-spacing:0;color:#a8a8af}
#g_pct{font-variant-numeric:tabular-nums;letter-spacing:.02em}
#toast{font-size:13px;letter-spacing:.004em}
h1,h2,h3{font-feature-settings:"kern","liga"}
/* — UI polish v0.15 — */
:root{--gold-hi:#FFE27A;--panel-hi:#16161a;--line-bright:rgba(255,255,255,.22);--txt-dim:#b9b9bf}
body{background:radial-gradient(ellipse 55% 35% at 0% 0%,rgba(232,182,74,.07) 0%,rgba(232,182,74,.02) 50%,transparent 100%),var(--bg)}
header{padding:20px 32px}
header b{font-size:13px;letter-spacing:.26em;display:flex;align-items:center;gap:11px}
header b::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--gold);
box-shadow:0 0 10px rgba(232,182,74,.55)}
nav{margin-bottom:30px;gap:28px}
nav button{padding:0 2px 16px;font-size:13.5px;font-weight:500}
nav button.on::after{height:2px;border-radius:2px}
.card{padding:28px 30px;margin-bottom:22px;border-radius:14px;transition:border-color .2s}
h2{font-size:11px;letter-spacing:.18em;margin-bottom:20px}
label{font-size:11.5px;letter-spacing:.02em;margin:14px 0 7px;color:var(--mut)}
.row{gap:18px}
input,select,textarea{padding:11px 14px;border-radius:9px;background:#0e0e10;
transition:border-color .15s,box-shadow .15s,background .15s}
input:focus,select:focus,textarea:focus{border-color:var(--gold);
box-shadow:0 0 0 3px rgba(232,182,74,.13);outline:none}
input:hover:not(:focus),select:hover:not(:focus),textarea:hover:not(:focus){border-color:var(--line-bright)}
button{transition:all .15s ease}
button.go{padding:13px 26px;border-radius:10px;font-size:13.5px;font-weight:600;letter-spacing:.02em;
box-shadow:0 1px 0 rgba(255,255,255,.14) inset,0 0 0 1px rgba(0,0,0,.12)}
button.go:hover:not(:disabled){transform:translateY(-1px);
box-shadow:0 6px 18px rgba(232,182,74,.28),0 1px 0 rgba(255,255,255,.18) inset}
button.go:active:not(:disabled){transform:translateY(0)}
button.sec{padding:9px 15px;border-radius:8px;font-size:12.5px;background:transparent}
button.sec:hover{border-color:var(--gold);color:var(--txt);background:rgba(232,182,74,.06)}
.item{padding:14px 16px;border-radius:11px;background:rgba(255,255,255,.015);
transition:border-color .15s,background .15s,transform .15s}
.item:hover{border-color:var(--line-bright);background:rgba(255,255,255,.035)}
.pill{font-size:10px;font-weight:600;letter-spacing:.08em;padding:3px 9px;
background:rgba(255,255,255,.04)}
.muted{color:var(--mut);font-size:12.5px;line-height:1.55}
figure{border-radius:13px;transition:transform .2s,border-color .2s}
figure:hover{transform:translateY(-2px);border-color:var(--line-bright)}
figcaption{font-size:11.5px;line-height:1.62}
#toast{padding:13px 20px;border-radius:11px;font-size:13px;
background:rgba(20,20,22,.95);backdrop-filter:blur(10px);
box-shadow:0 8px 32px rgba(0,0,0,.45),0 0 0 1px var(--line-bright)}
pre{padding:16px 18px;font-size:11.5px;line-height:1.65;border-radius:10px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.08);border-radius:6px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.2)}
/* progress bar */
#g_prog>div:first-child{background:#0a0a0b;border:1px solid var(--line);
border-radius:999px;overflow:hidden;height:7px}
#g_bar{background:linear-gradient(90deg,var(--gold),var(--gold-hi))!important;
transition:width .5s cubic-bezier(.2,.7,.3,1)!important;
box-shadow:0 0 12px rgba(232,182,74,.3) inset}
#g_pct{font-variant-numeric:tabular-nums;letter-spacing:.05em;font-size:11px;
color:var(--mut);margin-top:9px}
/* file + color + range inputs */
input[type=file]{background:rgba(255,255,255,.02);border:1px dashed var(--line-bright);
padding:13px;color:var(--mut);cursor:pointer;font-size:12.5px;width:100%}
input[type=file]:hover{border-color:var(--gold);color:var(--txt);background:rgba(232,182,74,.04)}
input[type=file]::-webkit-file-upload-button{background:transparent;border:0;color:var(--mut);
margin-right:14px;font:inherit;cursor:pointer;font-weight:500}
input[type=file]:hover::-webkit-file-upload-button{color:var(--gold)}
input[type=color]{padding:2px;border-radius:7px;background:transparent;cursor:pointer;
border:1px solid var(--line-bright)}
input[type=color]:hover{border-color:var(--gold)}
input[type=range]{padding:0;background:transparent;height:22px;cursor:pointer;-webkit-appearance:none;width:100%}
input[type=range]::-webkit-slider-runnable-track{height:4px;background:var(--line-bright);border-radius:4px}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;
border-radius:50%;background:var(--gold);cursor:grab;margin-top:-6px;
border:2px solid var(--bg);box-shadow:0 2px 8px rgba(232,182,74,.4)}
input[type=range]:hover::-webkit-slider-thumb{background:var(--gold-hi)}
input[type=range]:active::-webkit-slider-thumb{cursor:grabbing;transform:scale(1.08)}
input[type=checkbox]{accent-color:var(--gold);cursor:pointer}
/* small reusable visual primitives used in the brand-kit / character lists */
.swatchrow{display:flex;gap:5px;margin-top:4px}
.swatchrow span{width:18px;height:18px;border-radius:5px;border:1px solid var(--line-bright);
box-shadow:0 1px 4px rgba(0,0,0,.35) inset}
.thumb{width:54px;height:54px;border-radius:9px;border:1px solid var(--line-bright);
object-fit:cover;flex:0 0 54px;background:#0d0d0f}
.thumb.ph{display:flex;align-items:center;justify-content:center;color:var(--mut);
font-size:9px;letter-spacing:.06em;text-transform:uppercase}
/* — UI overhaul v0.16 — sidebar layout + premium buttons — */
:root{--gold-deep:#D9A02E;--line-soft:rgba(255,255,255,.04)}
/* Header: stickier, subtle gradient, frosted */
header{padding:16px 32px;background:linear-gradient(180deg,rgba(20,20,22,.92),rgba(10,10,11,.86));
backdrop-filter:blur(14px) saturate(130%);-webkit-backdrop-filter:blur(14px) saturate(130%);
border-bottom:1px solid var(--line-bright)}
header b{font-size:12px;letter-spacing:.32em;color:var(--mut)}
header b i{color:var(--gold);font-weight:700}
header b::before{box-shadow:0 0 14px rgba(232,182,74,.7),0 0 2px rgba(232,182,74,1)}
header .sw{font-size:12px;letter-spacing:.04em;color:var(--mut);text-transform:uppercase;font-weight:600}
header .sw select{min-width:170px;font-size:13px;letter-spacing:.005em;text-transform:none;
font-weight:500;color:var(--txt)}
/* Sidebar layout */
main{max-width:1320px;display:grid;grid-template-columns:220px 1fr;gap:44px;
padding:36px 40px 80px;align-items:start}
nav{flex-direction:column;border:0;margin:0;gap:3px;align-self:start;
position:sticky;top:78px;padding:6px 0;flex-wrap:nowrap}
nav button{width:100%;text-align:left;padding:11px 14px;border-radius:9px;font-size:13.5px;
color:var(--mut);border:1px solid transparent;letter-spacing:.005em;font-weight:500;
display:flex;align-items:center;gap:10px}
nav button:hover{background:rgba(255,255,255,.04);color:var(--txt)}
nav button.on{background:linear-gradient(180deg,rgba(232,182,74,.14),rgba(232,182,74,.05));
color:var(--gold-hi);border-color:rgba(232,182,74,.24);font-weight:600;
box-shadow:0 1px 0 rgba(255,255,255,.05) inset}
nav button.on::after,nav button::after{display:none!important}
nav button::before{content:"";width:4px;height:4px;border-radius:50%;background:currentColor;
opacity:.32;flex-shrink:0}
nav button.on::before{opacity:1;background:var(--gold);box-shadow:0 0 8px rgba(232,182,74,.7)}
@media(max-width:880px){
main{grid-template-columns:1fr;gap:22px;padding:24px 20px 80px}
nav{flex-direction:row;flex-wrap:wrap;border-bottom:1px solid var(--line);
padding:0 0 14px;position:static;gap:6px}
nav button{width:auto}
}
/* Cards: soft top highlight, gradient surface */
.card{background:linear-gradient(180deg,#15151a 0%,#101013 100%);
border:1px solid var(--line-bright);position:relative;overflow:hidden;
box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 1px 2px rgba(0,0,0,.4)}
.card::before{content:"";position:absolute;left:24px;right:24px;top:0;height:1px;
background:linear-gradient(90deg,transparent,rgba(255,255,255,.13),transparent)}
.card.disabled::before{display:none}
/* h2 with brand-dot */
h2{display:flex;align-items:center;gap:11px;color:var(--txt)}
h2::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--gold);
box-shadow:0 0 9px rgba(232,182,74,.55)}
/* Premium primary button — gradient, deep shadow, active depress */
button.go{background:linear-gradient(180deg,#F5C66A 0%,var(--gold) 52%,var(--gold-deep) 100%);
color:#1a1306;padding:13px 28px;border-radius:11px;
border:1px solid rgba(0,0,0,.22);
text-shadow:0 1px 0 rgba(255,255,255,.24);
font-weight:700;letter-spacing:.018em;
box-shadow:0 1px 0 rgba(255,255,255,.38) inset,
0 -1px 0 rgba(0,0,0,.2) inset,
0 1px 2px rgba(0,0,0,.32),
0 10px 22px -10px rgba(232,182,74,.55)}
button.go:hover:not(:disabled){transform:translateY(-1.5px);
box-shadow:0 1px 0 rgba(255,255,255,.46) inset,
0 -1px 0 rgba(0,0,0,.2) inset,
0 2px 5px rgba(0,0,0,.36),
0 16px 32px -12px rgba(232,182,74,.72)}
button.go:active:not(:disabled){transform:translateY(0);
box-shadow:0 1px 1px rgba(0,0,0,.5) inset,0 1px 0 rgba(255,255,255,.15) inset}
/* Refined secondary button */
button.sec{background:rgba(255,255,255,.04);border:1px solid var(--line-bright);
color:var(--txt);padding:10px 16px;border-radius:9px;font-weight:500;
letter-spacing:.005em;font-size:12.5px}
button.sec:hover{background:rgba(255,255,255,.08);border-color:var(--gold);
color:var(--gold-hi);transform:translateY(-1px)}
button.sec:active{transform:translateY(0);background:rgba(255,255,255,.05)}
/* Inputs */
input,select,textarea{background:#0d0d10;border-color:var(--line-bright);font-weight:500}
input:focus,select:focus,textarea:focus{
box-shadow:0 0 0 3px rgba(232,182,74,.18),0 1px 0 rgba(255,255,255,.04) inset;
background:#0f0f12}
/* Pills with surface */
.pill{background:rgba(255,255,255,.05);color:var(--txt);
border:1px solid var(--line-bright);font-weight:600}
/* Items */
.item{background:rgba(255,255,255,.022);border:1px solid var(--line-bright);border-radius:11px}
.item:hover{background:rgba(255,255,255,.05);border-color:rgba(232,182,74,.22)}
/* Thumb hover ring */
.thumb{transition:border-color .15s,transform .15s}
.thumb:hover{border-color:var(--gold)}
/* Posters tile */
figure{background:#0a0a0c;border-color:var(--line-bright);
box-shadow:0 1px 0 rgba(255,255,255,.04) inset,0 6px 16px -8px rgba(0,0,0,.55)}
figure:hover{transform:translateY(-3px);
box-shadow:0 1px 0 rgba(255,255,255,.06) inset,
0 14px 28px -10px rgba(0,0,0,.65),
0 0 0 1px rgba(232,182,74,.22)}
.dl,.cp{font-weight:600;letter-spacing:.05em;text-transform:uppercase;font-size:10px;
padding:7px 11px;border-radius:8px}
/* Toast */
#toast{background:rgba(16,16,18,.92);border:1px solid var(--line-bright);
box-shadow:0 24px 50px -20px rgba(0,0,0,.72),0 0 0 1px rgba(255,255,255,.04)}
/* Eyeglasses angle-generator drop zone */
.ea-drop{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;
text-align:center;padding:34px 20px;border:1.5px dashed var(--line2);border-radius:12px;cursor:pointer;
transition:border-color .15s,background .15s;background:rgba(255,255,255,.015)}
.ea-drop:hover,.ea-drop.over{border-color:var(--gold);background:rgba(232,182,74,.05)}
.ea-drop b{font-size:14px;margin-bottom:2px}
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:13px;height:13px;border:2px solid rgba(232,182,74,.3);
border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;
vertical-align:middle;margin-right:7px}
/* Eyeglasses poster style cards */
.esty-card{display:flex;flex-direction:column;gap:6px;padding:11px 13px;border-radius:10px;
cursor:pointer;font-size:13px;transition:border-color .15s,background .15s;border:1px solid var(--line)}
.esty-subcard{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:9px;
cursor:pointer;font-size:13px;transition:border-color .15s,background .15s;border:1px solid var(--line)}
/* Image-preview style cards (visual style + model shoot) */
.esty-img-card{display:flex;flex-direction:column;border-radius:9px;overflow:hidden;cursor:pointer;
font-size:13px;transition:border-color .15s,box-shadow .15s;border:1.5px solid var(--line);background:var(--bg2)}
.esty-img-card:hover{border-color:var(--line2)}
.esty-img-card .eic-thumb{width:100%;height:330px;object-fit:contain;object-position:center;display:block;background:#1a1a1e}
.esty-img-card .eic-body{display:flex;align-items:flex-start;gap:7px;padding:8px 10px}
.esty-img-card .eic-body input{width:auto;flex-shrink:0;margin:3px 0 0;accent-color:var(--gold)}
.esty-img-card .eic-body b{font-size:12px;display:block;margin-bottom:1px}
.esty-img-card .eic-body .muted{font-size:10.5px;line-height:1.35}
</style></head><body>
<header><b>QUOTE&nbsp;POSTER&nbsp;<i>STUDIO</i></b>
<span class="pill" title="deployed version">v${VERSION}</span><span class="sp"></span>
<div class="sw">Client <select id="client"></select></div>
<span class="pill">manual posting</span> <a href="/tryon" style="font-size:11px;color:var(--mut);text-decoration:none;border:1px solid var(--line2);padding:4px 10px;border-radius:6px;margin-left:4px;transition:color .14s,border-color .14s" onmouseover="this.style.color=\'var(--gold)\';this.style.borderColor=\'var(--gold)\'" onmouseout="this.style.color=\'var(--mut)\';this.style.borderColor=\'var(--line2)\'">🕶️ Try-On</a> <a href="#" onclick="fetch('/api/logout',{method:'POST'}).then(function(){location.href='/login'});return false" style="font-size:11px;color:var(--mut);text-decoration:none;border:1px solid var(--line2);padding:4px 10px;border-radius:6px;margin-left:4px;transition:color .14s,border-color .14s" onmouseover="this.style.color='#ff6b6b';this.style.borderColor='#ff6b6b'" onmouseout="this.style.color='var(--mut)';this.style.borderColor='var(--line2)'">Log out</a></header>
<div id="toast"></div>
<main>
<nav id="nav"></nav>
<div id="view"></div>
</main>
<script>
// Per-page-load image cache-buster. Generated client-side so it is ALWAYS
// unique — even if the browser cached an old copy of this HTML page, the
// token changes on every visit and forces a fresh image fetch.
const _SE=Date.now().toString(36);
const $=s=>document.querySelector(s);
// -- GET-response cache: makes tab switching feel instant ----------------
// Every view re-fetches its config endpoints (briefs/brands/characters/
// eyeglasses/batches/queue/...) on EVERY switch -- that is up to 5 parallel
// round trips plus a full innerHTML rebuild each time, which is what made
// switching tabs feel slow and laggy. Cache parsed JSON for a short window
// (in-flight promises are shared too, so viewGenerate's 5 parallel calls
// collapse into 1 reused promise on a warm cache), and wipe the whole
// cache the instant ANY mutation (non-GET request) lands successfully --
// that covers every save/generate/approve/delete/cancel site for free,
// without threading manual invalidation through ~15 call sites.
const _apiCache=new Map();
const API_TTL=20000;
if(!window.__qpsFetchWrapped){
  window.__qpsFetchWrapped=true;
  const _rawFetch=window.fetch.bind(window);
  window.fetch=(u,o)=>{
    const method=((o&&o.method)||'GET').toUpperCase();
    const p=_rawFetch(u,o);
    if(method!=='GET')p.then(r=>{if(r&&r.ok)_apiCache.clear();},()=>{});
    return p;
  };
}
function toast(msg,bad){const t=$('#toast');if(!t)return;t.textContent=msg;
  t.className='show'+(bad?' bad':'');clearTimeout(t._h);
  t._h=setTimeout(()=>{t.className='';},2800);}
let CLIENT=localStorage.getItem('qps_client')||'';
let TAB='generate';
const api=(u,o)=>{
  const method=((o&&o.method)||'GET').toUpperCase();
  if(method!=='GET')return fetch(u,o).then(r=>r.json());
  const hit=_apiCache.get(u);
  if(hit&&(Date.now()-hit.t)<API_TTL)return hit.p;
  const p=fetch(u,o).then(r=>r.json());
  // Don't cache while CLIENT is still empty (boot race) — an empty-client
  // response would poison the cache and serve stale data for 20s after CLIENT
  // resolves. Also don't cache error responses.
  if(CLIENT||!u.includes('client='))_apiCache.set(u,{t:Date.now(),p});
  p.catch(()=>_apiCache.delete(u));
  return p;
};
// Convert folder stamp "2026-05-17T09-38" → "May 17, 2026 · 9:38 AM"
// Manual formatter — no toLocaleString so it's identical everywhere.
const _MON=['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtStamp(s){
  const m=s.match(/^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})/);
  if(!m)return s;
  const yr=+m[1],mo=+m[2]-1,dy=+m[3],hr=+m[4],mn=+m[5];
  const h=hr%12||12,ap=hr<12?'AM':'PM';
  return _MON[mo]+' '+dy+', '+yr+' \xb7 '+h+':'+(mn<10?'0':'')+mn+' '+ap;}
// ── Tiny IndexedDB key/value store ────────────────────────────────────────
// Switching tabs re-renders the whole view, so form state has to be saved
// somewhere. localStorage covers text, but it CANNOT hold File objects —
// IndexedDB structured-clones them, so it is the only way to remember photos
// the user already uploaded. Every call is best-effort: if IDB is unavailable
// (private mode, quota), persistence silently degrades instead of throwing.
const _IDB_NAME='qps_state',_IDB_STORE='kv';
let _idbP=null;
function idbOpen(){
  if(_idbP)return _idbP;
  _idbP=new Promise((res,rej)=>{
    let rq;try{rq=indexedDB.open(_IDB_NAME,1);}catch(e){rej(e);return;}
    rq.onupgradeneeded=()=>{const db=rq.result;
      if(!db.objectStoreNames.contains(_IDB_STORE))db.createObjectStore(_IDB_STORE);};
    rq.onsuccess=()=>res(rq.result);
    rq.onerror=()=>rej(rq.error);
  });
  _idbP.catch(()=>{_idbP=null;});
  return _idbP;
}
async function idbSet(key,val){
  try{const db=await idbOpen();
    await new Promise((res,rej)=>{const tx=db.transaction(_IDB_STORE,'readwrite');
      tx.objectStore(_IDB_STORE).put(val,key);
      tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error);});
  }catch(_){/* best-effort */}
}
async function idbGet(key){
  try{const db=await idbOpen();
    return await new Promise((res,rej)=>{const tx=db.transaction(_IDB_STORE,'readonly');
      const rq=tx.objectStore(_IDB_STORE).get(key);
      rq.onsuccess=()=>res(rq.result);rq.onerror=()=>rej(rq.error);});
  }catch(_){return undefined;}
}
function goBatches(){TAB='batches';render();}
function toggleAdv(){const b=document.getElementById('adv-btn'),d=document.getElementById('adv-body');if(b)b.classList.toggle('open');if(d)d.classList.toggle('open');}
async function buildNav(){
  const tabs=[['generate','⚡ Generate'],['batches','📂 Batches'],['queue','✅ Queue'],['broll','🎬 B-Roll'],['video','🎥 Video'],['hacker','💡 Format Hacker'],['brand','🎨 Brand'],['topics','📝 Topics'],['chars','👤 Characters']];
  if(CLIENT==='tranzzie')tabs.push(['glasses','\\ud83d\\udd76\\ufe0f Eyeglasses']);
  // Show pending count badge on Queue tab
  let qBadge='';
  try{const q=await api('/api/queue?client='+CLIENT);const pending=q.filter(e=>!e.sentAt);if(pending.length)qBadge='<span class="nav-badge">'+pending.length+'</span>';}catch{}
  $('#nav').innerHTML=tabs.map(([k,l])=>'<button data-t="'+k+'">'+l+(k==='queue'?qBadge:'')+'</button>').join('');
  document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{TAB=b.dataset.t;render();});
  // If the previously-active tab doesn't exist for this client (e.g. left
  // "glasses" while switching away from tranzzie), fall back to Generate.
  if(!tabs.find(([k])=>k===TAB))TAB='generate';
}
async function boot(){
  const cs=await api('/api/clients');
  $('#client').innerHTML=cs.map(c=>'<option value="'+c.id+'">'+c.label+'</option>').join('');
  if(!cs.find(c=>c.id===CLIENT))CLIENT=cs[0]?.id||'';
  $('#client').value=CLIENT;
  $('#client').onchange=async e=>{CLIENT=e.target.value;localStorage.setItem('qps_client',CLIENT);await buildNav();render();};
  await buildNav();
  render();
}
function setNav(){document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===TAB));}
async function render(){
  setNav();
  if(TAB==='generate')return viewGenerate();
  if(TAB==='brand')return viewBrand();
  if(TAB==='topics')return viewTopics();
  if(TAB==='chars')return viewChars();
  if(TAB==='glasses')return viewGlasses();
  if(TAB==='batches')return viewBatches();
  if(TAB==='queue')return viewQueue();
  if(TAB==='broll')return viewBroll();
  if(TAB==='video')return viewBroll('story');
  if(TAB==='hacker')return viewHacker();
}
let es;
async function viewGenerate(){
  // Brand-a-Photo "Regenerate" support — the photos + plan of the last
  // successful brand-card submission, kept in memory so a retry doesn't
  // require re-uploading (File objects stay valid blobs for reuse).
  let bcLastSubmit=null;
  const [briefs,brands,chars,cls,glasses]=await Promise.all([
    api('/api/briefs?client='+CLIENT),
    api('/api/brand?client='+CLIENT),
    api('/api/characters?client='+CLIENT),
    api('/api/clients'),
    api('/api/eyeglasses?client='+CLIENT),
  ]);
  const defChar=(cls.find(c=>c.id===CLIENT)||{}).characterId||'';
  const photoOf={};chars.forEach(c=>{photoOf[c.id]=(c.photos&&c.photos[0])||'';});
  const charOpts='<option value="">— none (scene only) —</option>'
   +chars.map(c=>{const n=(c.photos||[]).length;
     return '<option value="'+c.id+'"'+(c.id===defChar?' selected':'')+'>'
      +c.name+' ('+n+' photo'+(n===1?'':'s')+')</option>';}).join('');
  // Eyeglasses showcase mode is Tranzzie-only for now.
  const showEyeglasses=CLIENT==='tranzzie';
  const showAdvice=CLIENT==='jurie';
  const glassPhotoOf={};glasses.forEach(g=>{glassPhotoOf[g.id]=(g.photos&&g.photos[0])||'';});
  const glassOpts=glasses.length
   ?glasses.map(g=>{const n=(g.photos||[]).length;
      return '<option value="'+g.id+'">'+g.name+' ('+n+' photo'+(n===1?'':'s')+')</option>';}).join('')
   :'<option value="">— add a frame in the 🕶️ Eyeglasses tab —</option>';
  // Aspect-ratio mix: shared ratio list + a distinct accent color per ratio
  // (drives the slider accent, card border, and the stacked-bar segments).
  const AR_RATIOS=['1:1','4:5','9:16'];
  const AR_COLORS={'1:1':'#5BA3D0','4:5':'#E8B64A','9:16':'#E0564B'};
  // ── Workflow strip
  const wfHtml='<div class="workflow-strip">'
   +'<div class="wf-step wf-active"><div class="wf-num">1</div><div><div class="wf-label">Generate</div><div class="wf-sub">Type a topic, hit Generate</div></div></div>'
   +'<div class="wf-step"><div class="wf-num">2</div><div><div class="wf-label">Review in Queue</div><div class="wf-sub">Approve or decline each poster</div></div></div>'
   +'<div class="wf-step"><div class="wf-num">3</div><div><div class="wf-label">Schedule to Buffer</div><div class="wf-sub">Pick a strategy → posts automatically</div></div></div>'
   +'</div>';

  $('#view').innerHTML=wfHtml
   +'<div class="card">'
   +(showEyeglasses
     ?('<div class="section-label">Poster type</div>'
       +'<div class="row" style="gap:10px;margin-bottom:18px">'
       +'<label class="ptype-card" data-pt="main" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--gold);border-radius:10px;background:rgba(232,182,74,.04);transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="main" checked style="width:auto;margin:3px 0 0;accent-color:var(--gold)">'
       +'<span><b>Main style</b><br><span class="muted" style="font-size:11px">Quote posters \\u2014 topic, branding, character</span></span></label>'
       +'<label class="ptype-card" data-pt="eyeglasses" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="eyeglasses" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83d\\udd76\\ufe0f Eyeglasses showcase</b><br><span class="muted" style="font-size:11px">Product-first posters built around a frame</span></span></label>'
       +'<label class="ptype-card" data-pt="shop" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="shop" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83d\\udecd\\ufe0f TikTok Shop</b><br><span class="muted" style="font-size:11px">Upload product photos \\u2192 a set of listing cards</span></span></label>'
       +'<label class="ptype-card" data-pt="brandphoto" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="brandphoto" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83d\\uddbc\\ufe0f Brand a Photo</b><br><span class="muted" style="font-size:11px">One photo \\u2192 text + logo, your layout</span></span></label>'
       +'</div>')
     :showAdvice
     ?('<div class="section-label">Poster type</div>'
       +'<div class="row" style="gap:10px;margin-bottom:14px">'
       +'<label class="ptype-card" data-pt="main" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--gold);border-radius:10px;background:rgba(232,182,74,.04);transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="main" checked style="width:auto;margin:3px 0 0;accent-color:var(--gold)">'
       +'<span><b>Quote poster</b><br><span class="muted" style="font-size:11px">Cinematic photo + Taglish hook \\u2192 payoff</span></span></label>'
       +'<label class="ptype-card" data-pt="advice" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="advice" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83d\\udca1 Advice card</b><br><span class="muted" style="font-size:11px">Dark text card: hook \\u2192 tips \\u2192 payoff</span></span></label>'
       +'<label class="ptype-card" data-pt="tweet" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="tweet" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83d\\udc26 Tweet style</b><br><span class="muted" style="font-size:11px">X/Twitter screenshot of an advice post</span></span></label>'
       +'</div>'
       +'<div class="row" style="gap:10px;margin-bottom:14px">'
       +'<label class="ptype-card" data-pt="photo" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="photo" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83d\\udcf8 Photo quote</b><br><span class="muted" style="font-size:11px">Your portrait + a floating tweet card</span></span></label>'
       +'<label class="ptype-card" data-pt="mono" style="flex:1;display:flex;gap:10px;align-items:flex-start;cursor:pointer;padding:12px 14px;border:1px solid var(--line);border-radius:10px;transition:border-color .15s,background .15s">'
       +'<input type="radio" name="g_ptype" value="mono" style="width:auto;margin:3px 0 0">'
       +'<span><b>\\ud83c\\udf11 Mono quote</b><br><span class="muted" style="font-size:11px">B&amp;W portrait + centred serif quote</span></span></label>'
       +'</div>'
       +'<div id="advice_box" style="display:none;margin-bottom:18px">'
       +'<div class="row" style="gap:16px;align-items:flex-start">'
       +'<div><label style="font-size:11px;display:block;margin-bottom:5px">Series label <span class="muted">(footer streak, e.g. "Working Smart")</span></label>'
       +'<input id="advice_series" maxlength="28" placeholder="Working Smart" style="width:240px;padding:11px 14px"></div>'
       +'<div><label style="font-size:11px;display:block;margin-bottom:5px">Profile photo <span class="muted">(optional \\u2014 defaults to Jurie)</span></label>'
       +'<div style="display:flex;align-items:center;gap:10px">'
       +'<div id="advice_avatar_prev" style="width:48px;height:48px;border-radius:50%;overflow:hidden;border:1px solid var(--line2);background:#0d0d0f;background-size:cover;background-position:center"></div>'
       +'<label class="sec" style="cursor:pointer;position:relative;font-size:12px;padding:8px 12px">Upload<input type="file" id="advice_avatar" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>'
       +'</div></div>'
       +'<div><label style="font-size:11px;display:block;margin-bottom:5px">Card theme</label>'
       +'<select id="advice_theme" style="width:130px;padding:11px 14px"><option value="dark">Dark</option><option value="light">Light</option></select></div>'
       +'</div></div>')
     :'')
   // ── Primary form ──
   +'<div id="g_section_label" class="section-label">What do you want to post about?</div>'
   +'<div class="row" style="gap:12px;margin-bottom:18px">'
   // Topic — shown for Main style posters
   +'<div id="g_topic_cell" style="flex:1"><input id="g_topic" placeholder="e.g. why regular eye check-ups matter" style="width:100%;font-size:15px;padding:14px 16px"></div>'
   // Headline idea — shown for Eyeglasses posters (optional)
   +'<div id="ea_headline_cell" style="flex:1;display:none"><input id="ea_headline" placeholder="Optional headline idea (e.g. See Clearly. Live Boldly.)" style="width:100%;font-size:15px;padding:14px 16px"></div>'
   // Promotion — shown for Eyeglasses posters (optional); rendered verbatim
   // as a badge on the poster, never invented by the AI.
   +'<div id="ea_promo_cell" style="flex:1;display:none"><input id="ea_promo" maxlength="40" placeholder="Optional promo (e.g. 35% OFF until June 30)" style="width:100%;font-size:15px;padding:14px 16px"></div>'
   +'</div>'
   // ── TikTok Shop panel — Virtual Photography Studio ────────────────────────
   +'<div id="shop_box" style="display:none;margin-bottom:18px;padding:16px 18px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:12px">'
   +'<div class="section-label" style="margin:0 0 6px">Frame varieties (colorways)</div>'
   +'<p class="muted" style="margin:0 0 10px;font-size:11px">Each variety is ONE colorway of the same frame model with its own reference photos (1\\u20136 each; plain, well-lit shots work best). The AI re-shoots <b>your exact frame</b> in commercial scenes \\u2014 square 1:1 for TikTok Shop. Your uploads are reference-only and never posted.</p>'
   +'<div id="shv_list"></div>'
   +'<button type="button" class="sec" id="shv_add" style="margin-top:2px">\\uff0b Add variety</button>'
   +'<div class="section-label" style="margin:18px 0 8px">Shot menu <span class="muted" style="font-size:11px;text-transform:none;letter-spacing:0">(pick how many of each)</span></div>'
   +'<div id="shm_list"></div>'
   +'<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px">'
   +'<label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" id="shv_identical" style="width:auto;margin:0;accent-color:var(--gold)"> Render identical sets <span class="muted" style="font-size:11px">(full shot menu per variety)</span></label>'
   +'<span id="shm_math" class="muted" style="font-size:12px;margin-left:auto"></span>'
   +'</div>'
   +'<div id="shm_modelnote" style="display:none;margin-top:12px"><label style="font-size:11px;display:block;margin-bottom:5px">Model look (optional)</label>'
   +'<input id="shop_modelnote" maxlength="160" placeholder="e.g. a stylish Filipina in her 30s, office attire \\u2014 leave blank to rotate defaults" style="width:100%;padding:12px 14px"></div>'
   +'<div class="row" style="gap:12px;margin-top:16px">'
   +'<div style="flex:1"><label style="font-size:11px;display:block;margin-bottom:5px">Product / model name</label><input id="shop_product" maxlength="40" placeholder="e.g. Aria" style="width:100%;padding:12px 14px"></div>'
   +'<div style="flex:1"><label style="font-size:11px;display:block;margin-bottom:5px">Material / finish</label><input id="shop_material" maxlength="30" placeholder="e.g. Lightweight Metal" style="width:100%;padding:12px 14px"></div>'
   +'</div>'
   +'<div class="section-label" style="margin:16px 0 8px">Lens specs <span class="muted" style="font-size:11px;text-transform:none;letter-spacing:0">(shown as feature icons + a spec card)</span></div>'
   +'<div id="shop_specs" style="display:flex;flex-wrap:wrap;gap:8px">'
   +[['anti_rad','Anti-Radiation / Blue Light'],['uv400','UV400 / UV Protection'],['photochromic','Photochromic'],['polarized','Polarized'],['anti_glare','Anti-Glare'],['anti_scratch','Anti-Scratch']]
       .map(s=>'<label class="spec-chip" style="display:inline-flex;align-items:center;gap:7px;padding:8px 13px;border:1px solid var(--line2);border-radius:999px;cursor:pointer;font-size:13px"><input type="checkbox" name="shop_spec" value="'+s[0]+'" style="width:auto;margin:0;accent-color:var(--gold)"> '+s[1]+'</label>').join('')
   +'</div>'
   +'<p class="muted" style="margin:16px 0 0;font-size:11px">Cards are <b>square 1:1</b> \\u2014 the format TikTok Shop product listings use.</p>'
   +'</div>'
   // ── Brand-a-Photo panel (shown when poster type = brandphoto) ──────────────
   +'<div id="brandcard_box" style="display:none;margin-bottom:18px;padding:16px 18px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:12px">'
   +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:rgba(255,255,255,.02);border:1px solid var(--line2);border-radius:9px">'
   +'<label class="muted" style="font-size:11px;white-space:nowrap">Card style</label>'
   +'<select id="bc_preset_sel" style="flex:1;min-width:160px;padding:8px 10px;font-size:12.5px"><option value="">\\u2014 none \\u2014</option></select>'
   +'<button type="button" class="sec" id="bc_preset_save" style="font-size:11.5px;padding:7px 12px">\\ud83d\\udcbe Save as preset</button>'
   +'<button type="button" class="sec" id="bc_preset_del" style="font-size:11.5px;padding:7px 12px;display:none">\\u2715 Delete</button>'
   +'<button type="button" class="sec" id="bc_retry_btn" style="font-size:11.5px;padding:7px 12px;display:none;margin-left:auto">\\ud83d\\udd01 Regenerate last</button>'
   +'</div>'
   +'<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;margin-bottom:14px">'
   +'<input type="checkbox" id="bc_batch_toggle" style="width:auto;margin:0;accent-color:var(--gold)"> \\ud83d\\udcda Batch mode <span class="muted" style="font-size:11px">(multiple different frames, one shared style)</span></label>'
   +'<div class="section-label" style="margin:0 0 6px">Photo</div>'
   +'<div id="bc_single_photo">'
   +'<p class="muted" style="margin:0 0 10px;font-size:11px">Upload ONE photo of the eyeglasses. Add a tagline + logo and pick a layout \\u2014 keep the real photo, lightly clean it up, or let AI re-shoot it.</p>'
   +'<label class="ea-drop" id="bc_drop" style="padding:22px 14px;display:block;text-align:center;border:1.5px dashed var(--line2);border-radius:10px;cursor:pointer;position:relative">'
   +'<input type="file" id="bc_photo" accept="image/*" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer">'
   +'<span id="bc_photo_lbl" class="muted" style="font-size:13px">Click or drop 1\\u20136 photos here</span></label>'
   +'<div id="bc_thumb" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"></div>'
   +'<p id="bc_multi_hint" class="muted" style="display:none;margin:8px 0 0;font-size:11px">\\ud83d\\udcf8 Multiple photos detected \\u2014 AI re-shoot is auto-selected so it can use all angles to model the frame more accurately.</p>'
   +'</div>'
   +'<div id="bc_batch_photo" style="display:none">'
   +'<p class="muted" style="margin:0 0 10px;font-size:11px">Each frame below is a SEPARATE card \\u2014 its own photo(s), tagline, and product name. Image treatment, text mode, logo, layout, and aspect (below) apply to all of them.</p>'
   +'<div id="bcb_list"></div>'
   +'<button type="button" class="sec" id="bcb_add" style="margin-top:2px">\\uff0b Add another frame</button>'
   +'</div>'
   +'<div class="section-label" style="margin:16px 0 8px">Image</div>'
   +'<div id="bc_treatment" style="display:flex;flex-wrap:wrap;gap:8px">'
   +[['original','Keep original','Use my photo as-is'],['cleanup','Clean it up','Light AI polish \\u2014 lighting + background'],['reshoot','AI re-shoot','Full studio re-shoot of the frame']]
       .map((t,i)=>'<label class="bc-opt" style="flex:1;min-width:150px;display:block;cursor:pointer;padding:10px 12px;border:1px solid var(--line2);border-radius:9px"><input type="radio" name="bc_treat" value="'+t[0]+'"'+(i===0?' checked':'')+' style="width:auto;margin:0 6px 0 0;accent-color:var(--gold)"><b style="font-size:13px">'+t[1]+'</b><br><span class="muted" style="font-size:11px">'+t[2]+'</span></label>').join('')
   +'</div>'
   +'<div class="section-label" style="margin:16px 0 8px">Text</div>'
   +'<div style="display:flex;gap:14px;margin-bottom:8px">'
   +'<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="radio" name="bc_text" value="own" checked style="width:auto;margin:0;accent-color:var(--gold)"> Write my own</label>'
   +'<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="radio" name="bc_text" value="ai" style="width:auto;margin:0;accent-color:var(--gold)"> Let AI suggest</label>'
   +'</div>'
   +'<div id="bc_single_text">'
   +'<input id="bc_tagline" maxlength="140" placeholder="Your tagline (e.g. Clear vision, all-day comfort)" style="width:100%;padding:12px 14px">'
   +'<p id="bc_tag_hint" class="muted" style="display:none;margin:6px 0 0;font-size:11px">Optional: a topic or hint for the AI (or leave blank).</p>'
   +'<button type="button" class="sec" id="bc_tag_ideas_btn" style="display:none;margin-top:8px;font-size:11.5px;padding:7px 12px">\\u2728 Get 4 tagline ideas</button>'
   +'<div id="bc_tag_ideas" style="display:none;margin-top:8px;flex-wrap:wrap;gap:7px"></div>'
   +'</div>'
   +'<p id="bc_batch_text_note" class="muted" style="display:none;margin:0;font-size:11px">Each frame above has its own tagline (and its own AI hint, if \\u201cLet AI suggest\\u201d is picked).</p>'
   +'<div class="row" style="gap:12px;margin-top:16px;align-items:flex-end">'
   +'<div id="bc_single_product" style="flex:1"><label style="font-size:11px;display:block;margin-bottom:5px">Product / model name (optional)</label><input id="bc_product" maxlength="40" placeholder="e.g. Aria" style="width:100%;padding:12px 14px"></div>'
   +'<div style="flex:0 0 150px"><label style="font-size:11px;display:block;margin-bottom:5px">Aspect</label><select id="bc_aspect" style="width:100%;padding:12px 14px"><option value="4:5">4:5 feed</option><option value="1:1">1:1 square</option><option value="9:16">9:16 story</option><option value="all">\\u2b1a All 3 formats</option></select></div>'
   +'<label style="display:inline-flex;align-items:center;gap:7px;font-size:13px;cursor:pointer;padding-bottom:12px"><input type="checkbox" id="bc_logo" checked style="width:auto;margin:0;accent-color:var(--gold)"> Add logo</label>'
   +'</div>'
   +'<div class="section-label" style="margin:16px 0 8px">Layout</div>'
   +'<div id="bc_layout" style="display:flex;flex-wrap:wrap;gap:10px"></div>'
   +'</div>'
   // ── Advanced toggle (hidden for eyeglasses — settings auto-expand instead) ──
   +'<button class="adv-toggle" id="adv-btn" onclick="toggleAdv()">'
   +'⚙ Advanced settings <span class="muted" style="font-size:11px;margin-left:6px">(topic preset, brand kit, subject, formats)</span></button>'
   +'<div class="adv-body" id="adv-body">'
   +'<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">'
   // Brief + brand kit — shown only for Main style (hidden for eyeglasses)
   +'<div id="g_mainonly_row" class="row" style="margin-bottom:0">'
   +'<div><label>Topic preset</label><select id="g_brief"><option value="">— none —</option>'
   +briefs.map(b=>'<option value="'+b.id+'">'+b.name+'</option>').join('')+'</select>'
   +'<p class="muted" style="margin:5px 0 0;font-size:11px">Loads a saved topic with specific voice notes</p></div>'
   +'<div><label>Brand kit</label><select id="g_brand"><option value="">— default —</option>'
   +brands.map(b=>'<option value="'+b.id+'">'+b.name+'</option>').join('')+'</select>'
   +'<p class="muted" style="margin:5px 0 0;font-size:11px">Colors, logo, and CTA text</p></div></div>'
   +'<div id="g_subjrow"></div>'
   +'<div class="row" style="margin-top:14px;align-items:center">'
   +'<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">'
   +'<label style="display:inline-flex;gap:8px;align-items:center;cursor:pointer;font-size:13px;color:var(--txt);white-space:nowrap;margin:0">'
   +'<input type="checkbox" id="g_logo_on" style="width:auto;margin:0"> Include logo</label>'
   +'<label style="display:inline-flex;gap:8px;align-items:center;cursor:pointer;font-size:13px;color:var(--txt);white-space:nowrap;margin:0">'
   +'<input type="checkbox" id="g_cta_on" checked style="width:auto;margin:0"> Include CTA chip</label>'
   +'<label id="g_aihead_label" style="display:inline-flex;gap:8px;align-items:center;cursor:pointer;font-size:13px;color:var(--txt);white-space:nowrap;margin:0">'
   +'<input type="checkbox" id="g_ai_head" style="width:auto;margin:0"> ✨ AI headline</label>'
   +'</div>'
   +'<div><label style="font-size:11px" id="g_extras_label">Extra reference photos (overrides character for this batch)</label>'
   +'<input id="g_extras" type="file" accept="image/*" multiple></div></div>'
   +'<div id="g_estyle_box" style="display:none;margin-top:16px">'
   // ── Top-level poster style cards ──────────────────────────────────────────
   +'<div style="padding:14px 16px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:10px">'
   +'<div class="section-label" style="margin:0 0 12px">Eyeglasses poster style</div>'
   +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:8px">'
   +'<label class="esty-card" style="border-color:var(--gold);background:rgba(232,182,74,.04)">'
   +'<div style="display:flex;align-items:center;gap:8px"><input type="radio" name="g_estyle" value="showcase" checked style="width:auto;margin:0;accent-color:var(--gold)"><b>Product showcase</b></div>'
   +'<p class="muted" style="margin:0;font-size:11px;line-height:1.4">Frame as the hero \\u2014 styled product photo + tagline</p>'
   +'<span style="align-self:flex-start;font-size:9px;background:var(--gold);color:#15120a;padding:1px 5px;border-radius:4px;font-weight:700">READY</span>'
   +'</label>'
   +'<label class="esty-card">'
   +'<div style="display:flex;align-items:center;gap:8px"><input type="radio" name="g_estyle" value="model" style="width:auto;margin:0;accent-color:var(--gold)"><b>Product + Model</b></div>'
   +'<p class="muted" style="margin:0;font-size:11px;line-height:1.4">Frame worn by an AI-generated model in a lifestyle scene</p>'
   +'<span style="align-self:flex-start;font-size:9px;background:var(--gold);color:#15120a;padding:1px 5px;border-radius:4px;font-weight:700">READY</span>'
   +'</label>'
   +'<label class="esty-card" style="opacity:.42;cursor:not-allowed">'
   +'<div style="display:flex;align-items:center;gap:8px"><input type="radio" name="g_estyle" value="infographic" disabled style="width:auto;margin:0"><b style="color:var(--mut)">Infographic</b></div>'
   +'<p style="margin:0;font-size:11px;line-height:1.4;color:var(--mut)">Feature / benefit breakdown layout</p>'
   +'<span style="align-self:flex-start;font-size:9px;background:var(--line2);color:var(--mut);padding:1px 5px;border-radius:4px">SOON</span>'
   +'</label>'
   +'<label class="esty-card" style="opacity:.42;cursor:not-allowed">'
   +'<div style="display:flex;align-items:center;gap:8px"><input type="radio" name="g_estyle" value="quote" disabled style="width:auto;margin:0"><b style="color:var(--mut)">Quote poster</b></div>'
   +'<p style="margin:0;font-size:11px;line-height:1.4;color:var(--mut)">Testimonial-style with the frame in shot</p>'
   +'<span style="align-self:flex-start;font-size:9px;background:var(--line2);color:var(--mut);padding:1px 5px;border-radius:4px">SOON</span>'
   +'</label>'
   +'</div></div>'
   // ── Poster style preset panel (showcase only) ─────────────────────────────
   +'<div id="ea_psp_box" style="display:block;margin-top:10px;padding:14px 16px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:10px">'
   +'<div class="section-label" style="margin:0 0 6px">Poster style template</div>'
   +'<p class="muted" style="margin:0 0 10px;font-size:11px">Pick a reference poster — the AI generates backgrounds that match its visual language while keeping your eyeglasses as the hero.</p>'
   +(()=>{
     const PSP=[
       {key:'01-dramatic-multiangle', label:'Dramatic multi-angle',  desc:'Dark bg, floating fragments, multiple product angles'},
       {key:'02-minimal-pedestal',    label:'Minimal pedestal',       desc:'Clean white/grey, product on block, spec-style type'},
       {key:'03-type-overlay',        label:'Type overlay flat-lay',  desc:'Bold type layered behind laid-flat frames, warm palette'},
       {key:'04-editorial-props',     label:'Editorial props',        desc:'Off-white, geometric prop staging, elegant copy'},
       {key:'05-glass-panel-spec',    label:'Glass panel spec',       desc:'Frosted acrylic surface, technical spec-sheet aesthetic'},
       {key:'auto',                   label:'Let AI decide',          desc:'Gemini picks the best visual style for each scene'},
     ];
     return '<div id="ea_psp_grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">'
       +PSP.map((p,i)=>
         '<label class="esty-img-card"'+(i===0?' style="border-color:var(--gold)"':'')+' title="'+p.label+'">'
         +(p.key!=='auto'
           ? '<img class="eic-thumb" src="/poster-styles/'+p.key+'.jpg" alt="'+p.label+'" loading="lazy">'
           : '<div class="eic-thumb" style="display:flex;align-items:center;justify-content:center;font-size:28px;opacity:.4;background:#1a1a1f">✦</div>')
         +'<div class="eic-body"><input type="radio" name="g_psp" value="'+p.key+'"'+(i===0?' checked':'')+' style="accent-color:var(--gold)">'
         +'<div><b>'+p.label+'</b><div class="muted">'+p.desc+'</div></div>'
         +'</div></label>'
       ).join('')
       +'</div>';
   })()
   +'<div style="margin-top:10px">'
   +'<details style="font-size:12px;color:var(--mut)"><summary style="cursor:pointer;user-select:none;font-weight:600;color:var(--txt)">📎 Override with your own style reference (optional)</summary>'
   +'<div style="margin-top:8px"><p class="muted" style="margin:0 0 8px;font-size:11px">Drop an image showing the look and feel you want — lighting, composition, color palette. This overrides the template selected above.</p>'
   +'<label class="ea-drop" id="ea_skref_drop" style="padding:18px 14px">'
   +'<input type="file" id="ea_skref_file" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer">'
   +'<span id="ea_skref_lbl" class="muted" style="font-size:12px">Click or drop an image here</span>'
   +'</label>'
   +'<button id="ea_skref_clear" class="sec" style="display:none;margin-top:6px;font-size:11px;padding:4px 10px">✕ Remove</button>'
   +'</div></details>'
   +'</div>'
   +'</div>'
   // ── Model style sub-panel (Product + Model only) ───────────────────────────
   +'<div id="ea_ms_box" style="display:none;margin-top:10px;padding:14px 16px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:10px">'
   +'<div class="section-label" style="margin:0 0 6px">Poster style template</div>'
   +'<p class="muted" style="margin:0 0 10px;font-size:11px">Pick a reference poster — the AI generates a scene with a model wearing your frame that matches this visual style.</p>'
   +(()=>{
     const MS=[
       {v:'model-01-bold-type-overlay', label:'Bold type overlay',   desc:'Giant cropped type behind model, bright studio, high contrast'},
       {v:'model-02-elegant-hold',      label:'Elegant product hold', desc:'Clean bg, model holding frame up, serif headline, cream palette'},
       {v:'model-03-earthy-editorial',  label:'Earthy editorial',     desc:'Textured background, dramatic close-up, earthy tones'},
       {v:'model-04-clean-fresh',       label:'Clean & fresh',        desc:'White bg, minimal, youthful model-worn editorial'},
       {v:'model-05-outdoor-cinematic', label:'Outdoor cinematic',    desc:'Natural light, blue sky, quiet narrative composition'},
       {v:'auto',                       label:'Let AI decide',        desc:'Gemini picks the best style for each poster'},
     ];
     return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px" id="ea_ms_grid">'
       +MS.map((m,i)=>
         '<label class="esty-img-card"'+(i===0?' style="border-color:var(--gold)"':'')+' title="'+m.label+'">'
         +(m.v!=='auto'
           ? '<img class="eic-thumb" src="/poster-styles/'+m.v+'.jpg" alt="'+m.label+'" loading="lazy">'
           : '<div class="eic-thumb" style="display:flex;align-items:center;justify-content:center;font-size:28px;opacity:.4;background:#1a1a1f">✦</div>')
         +'<div class="eic-body"><input type="radio" name="g_mstyle" value="'+m.v+'"'+(i===0?' checked':'')+' style="accent-color:var(--gold)">'
         +'<div><b>'+m.label+'</b><div class="muted">'+m.desc+'</div></div>'
         +'</div></label>'
       ).join('')
       +'</div>';
   })()
   +'<div style="margin-top:10px">'
   +'<details style="font-size:12px;color:var(--mut)"><summary style="cursor:pointer;user-select:none;font-weight:600;color:var(--txt)">📎 Override with your own style reference (optional)</summary>'
   +'<div style="margin-top:8px"><p class="muted" style="margin:0 0 8px;font-size:11px">Drop an image showing the campaign style you want — lighting, composition, color palette. This overrides the template selected above.</p>'
   +'<label class="ea-drop" id="ea_msref_drop" style="padding:18px 14px">'
   +'<input type="file" id="ea_msref_file" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer">'
   +'<span id="ea_msref_lbl" class="muted" style="font-size:12px">Click or drop an image here</span>'
   +'</label>'
   +'<button id="ea_msref_clear" class="sec" style="display:none;margin-top:6px;font-size:11px;padding:4px 10px">✕ Remove</button>'
   +'</div></details>'
   +'</div>'
   +'</div>'
   +'</div>'
   +'<div style="margin-top:16px;padding:14px 16px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:10px">'
   +'<div class="section-label" style="margin:0 0 6px">Aspect ratio mix</div>'
   +'<p class="muted" style="margin:0 0 12px;font-size:11px">Optional \\u2014 split the batch across formats instead of all 4:5. Check the ones you want, then drag a slider \\u2014 the others rebalance automatically so the mix always totals 100%.</p>'
   +'<div id="ar_bar" style="display:flex;height:14px;border-radius:7px;overflow:hidden;margin-bottom:14px;background:#1a1a1d"></div>'
   +'<div style="display:flex;flex-direction:column;gap:10px">'
   +AR_RATIOS.map(r=>{
      const lbl=r==='1:1'?'Square':r==='4:5'?'Portrait':'Story / Reel';
      const on=r==='4:5';
      const col=AR_COLORS[r];
      return '<label class="ar-card" data-ar="'+r+'" style="display:flex;align-items:center;gap:12px;cursor:pointer;font-size:13px;color:var(--txt);padding:10px 12px;border:1px solid '+(on?col:'var(--line)')+';border-radius:9px;background:'+(on?col+'14':'transparent')+'">'
        +'<input type="checkbox" class="ar-chk" data-ar="'+r+'"'+(on?' checked':'')+' style="width:auto;margin:0;accent-color:'+col+'">'
        +'<span style="min-width:128px"><b>'+r+'</b> <span class="muted" style="font-size:11px">'+lbl+'</span></span>'
        +'<input type="range" class="ar-slider" data-ar="'+r+'" min="0" max="100" step="5" value="'+(on?100:0)+'"'+(on?'':' disabled')+' style="flex:1;accent-color:'+col+'">'
        +'<span class="ar-pctval" data-ar="'+r+'" style="min-width:42px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">'+(on?100:0)+'%</span>'
        +'</label>';
     }).join('')
   +'</div>'
   +'<p class="muted" id="ar_prev" style="margin:12px 0 0;font-size:11px"></p>'
   +'</div>'
   +'</div></div>'
   +'<div style="margin:14px 0 0;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap">'
   +'<div style="flex:0 0 110px"><label style="font-size:11px;display:block;margin-bottom:5px">Number of posters</label><input id="g_count" type="number" min="1" max="200" value="8" style="width:100%;text-align:center;font-size:15px;padding:12px 8px"></div>'
   +'<button class="go" id="g_go" style="align-self:flex-end">Generate posters</button>'
   +'<span id="g_qinfo" style="display:none;align-items:center;gap:8px">'
   +'<span class="pill" id="g_qcount" style="background:rgba(232,182,74,.15);color:var(--gold)">⏳ 0 queued</span>'
   +'<button class="sec" id="g_qclear" style="font-size:11px;padding:5px 10px">🗑 Clear queue</button></span>'
   +'<span id="g_unlock" style="display:none"><button class="sec" id="g_unlock_btn" style="border-color:var(--red);color:var(--red)">⚠ Unlock stuck job</button>'
   +'<span class="muted" style="font-size:12px">Another job appears stuck. Click to force-clear the lock.</span></span>'
   +'</div>'
   +'<div id="g_prog" style="display:none;margin:4px 0 14px">'
   +'<div style="height:12px;background:#0a0a0b;border:1px solid var(--line);border-radius:999px;overflow:hidden">'
   +'<div id="g_bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--gold),#ffe27a);transition:width .45s"></div></div>'
   +'<div id="g_pct" class="muted" style="margin-top:6px;font-size:12px">0%</div></div>'
   +'<pre id="g_log" style="display:none"></pre>'
   +'<div id="g_result" style="display:none;margin-top:22px"></div></div>'
   ;
  const logoOf={};brands.forEach(b=>{logoOf[b.id]=b.logoSrc||'';});
  const defBrand=brands[0]?brands[0].id:'';
  function updLogo(){const id=$('#g_brand').value||defBrand,p=logoOf[id],el=$('#g_lprev');
    if(!el)return;
    if(p){el.style.backgroundImage='url(/api/brandlogo?p='+encodeURIComponent(p)+')';el.textContent='';}
    else{el.style.backgroundImage='';el.textContent='no logo';}}
  $('#g_brand').onchange=()=>{updLogo();saveGenSettings();};
  $('#g_brief').onchange=e=>{const b=briefs.find(x=>x.id===e.target.value);if(b&&b.topics&&b.topics[0])$('#g_topic').value=b.topics[0];saveGenSettings();};
  function curPosterType(){
    const r=document.querySelector('input[name="g_ptype"]:checked');
    return r?r.value:'main';
  }
  // Repaints the subject row (Character vs Eyeglasses select), the eyeglasses
  // sub-style box, and the extra-refs label — everything that swaps based on
  // which poster type is selected. Logo preview is shared and repainted too
  // since #g_lprev gets recreated along with the row.
  function paintSubject(){
    const pt=curPosterType();
    const row=$('#g_subjrow');if(!row)return;
    // Advice / tweet / brand-a-photo are photo-or-text only — no character.
    if(pt==='advice'||pt==='tweet'||pt==='brandphoto'){row.innerHTML='';return;}
    if(pt==='eyeglasses'){
      row.innerHTML='<div class="row" style="align-items:flex-start;margin-top:14px">'
        +'<div><label>Eyeglasses</label>'
        +'<select id="g_subject" style="width:100%">'+glassOpts+'</select>'
        +'<p class="muted" style="margin:5px 0 0;font-size:11px">'
        +(glasses.length?'The frame this batch will showcase':'Add a frame in the \\ud83d\\udd76\\ufe0f Eyeglasses tab, then come back')
        +'</p></div>'
        +'<div style="flex:0 0 140px"><label>Preview</label>'
        +'<div id="g_cprev" style="width:140px;height:140px;border:1px solid var(--line);border-radius:10px;background:#101012 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:12px">none</div></div>'
        +'<div style="flex:0 0 120px"><label>Logo</label>'
        +'<div id="g_lprev" style="width:120px;height:120px;border:1px solid var(--line);border-radius:10px;background:#000 center/contain no-repeat;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:11px">none</div></div></div>';
    }else{
      row.innerHTML='<div class="row" style="align-items:flex-start;margin-top:14px">'
        +'<div><label>Character</label>'
        +'<select id="g_subject" style="width:100%">'+charOpts+'</select>'
        +'<p class="muted" style="margin:5px 0 0;font-size:11px">Person generated into the poster background</p></div>'
        +'<div style="flex:0 0 140px"><label>Preview</label>'
        +'<div id="g_cprev" style="width:140px;height:140px;border:1px solid var(--line);border-radius:10px;background:#101012 center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:12px">none</div></div>'
        +'<div style="flex:0 0 120px"><label>Logo</label>'
        +'<div id="g_lprev" style="width:120px;height:120px;border:1px solid var(--line);border-radius:10px;background:#000 center/contain no-repeat;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:11px">none</div></div></div>';
    }
    const map=pt==='eyeglasses'?glassPhotoOf:photoOf;
    const photoApi=pt==='eyeglasses'?'/api/glassesphoto':'/api/charphoto';
    const sel=$('#g_subject');
    function updSubjPrev(){const id=sel.value,p=map[id],el=$('#g_cprev');
      if(p){el.style.backgroundImage='url('+photoApi+'?p='+encodeURIComponent(p)+')';el.textContent='';}
      else{el.style.backgroundImage='';el.textContent=id?'(no photo)':'none';}}
    sel.onchange=()=>{updSubjPrev();saveGenSettings();};updSubjPrev();
    updLogo();
    const ebox=$('#g_estyle_box');if(ebox)ebox.style.display=pt==='eyeglasses'?'block':'none';
    const exLbl=$('#g_extras_label');
    if(exLbl)exLbl.textContent=pt==='eyeglasses'
      ?'Extra reference photos (overrides the eyeglasses asset for this batch)'
      :'Extra reference photos (overrides character for this batch)';
  }
  function syncPtypeCards(){
    document.querySelectorAll('.ptype-card').forEach(el=>{
      const r=el.querySelector('input');
      el.style.borderColor=r.checked?'var(--gold)':'var(--line)';
      el.style.background=r.checked?'rgba(232,182,74,.04)':'transparent';
    });
    const pt = curPosterType();
    const isEye = pt === 'eyeglasses';
    const isShop = pt === 'shop';
    const isBrand = pt === 'brandphoto';
    const isAdv = pt === 'advice' || pt === 'tweet';
    // Advice series field (Jurie advice/tweet).
    const advBox=$('#advice_box');
    if(advBox) advBox.style.display = isAdv ? 'block' : 'none';
    // For advice the topic label reads as an optional angle.
    // Topic vs headline — both hidden in shop mode (product inputs instead).
    const secLbl=$('#g_section_label'), topicCell=$('#g_topic_cell'), hlCell=$('#ea_headline_cell');
    if(secLbl){ secLbl.style.display = (isEye||isShop||isBrand) ? 'none' : ''; secLbl.textContent = isAdv ? 'Topic / angle (optional)' : 'What do you want to post about?'; }
    if(topicCell) topicCell.style.display = (isEye||isShop||isBrand) ? 'none' : '';
    if(hlCell)  hlCell.style.display   = isEye ? '' : 'none';
    const promoCell=$('#ea_promo_cell');
    if(promoCell) promoCell.style.display = isEye ? '' : 'none';
    // Shop panel
    const shopBox=$('#shop_box');
    if(shopBox) shopBox.style.display = isShop ? 'block' : 'none';
    const brandBox=$('#brandcard_box');
    if(brandBox) brandBox.style.display = isBrand ? 'block' : 'none';
    // Brief + brand kit row — hidden for eyeglasses & shop & brand-a-photo
    const mainRow=$('#g_mainonly_row');
    if(mainRow) mainRow.style.display = (isEye||isShop||isBrand) ? 'none' : '';
    // Advanced toggle — hidden for eyeglasses (auto-opens), shop, brand-a-photo
    const advBtn=$('#adv-btn'), advBody=$('#adv-body');
    if(advBtn) advBtn.style.display = (isEye||isShop||isBrand) ? 'none' : '';
    if(advBody) { if(isEye) advBody.classList.add('open'); else advBody.classList.remove('open'); }
    // Eyeglasses style box
    const ebox=$('#g_estyle_box');
    if(ebox) ebox.style.display = isEye ? 'block' : 'none';
    // AI headline toggle — only relevant for eyeglasses showcase posters
    const aihlLbl=$('#g_aihead_label');
    if(aihlLbl) aihlLbl.style.display = isEye ? '' : 'none';
    // Count field is irrelevant for shop (fixed 5-card set)
    const countCell=$('#g_count')?$('#g_count').closest('div'):null;
    if(countCell) countCell.style.opacity = (isShop||isBrand) ? '0.4' : '1';
  }
  document.querySelectorAll('input[name="g_ptype"]').forEach(r=>{
    r.onchange=()=>{syncPtypeCards();paintSubject();saveGenSettings();};
  });
  syncPtypeCards();
  paintSubject();
  // ── TikTok Shop photo preview + spec chips ───────────────────────────────
  // ── TikTok Shop — Virtual Photography Studio wiring ──────────────────────
  const shmDefs=[
    ['hero','Hero Product','Dramatic lighting \\u2014 floating, pedestal, cinematic dark'],
    ['simple','Simple Product','Front-on, pure white catalog background'],
    ['model','Model Shoot','Worn by a photorealistic model (85mm portrait)'],
    ['closeup','Extreme Close-up','Macro details \\u2014 hinges, nose pads, materials'],
    ['feature','Feature / Infographic','Angled lens shot + programmatic tech overlays'],
    ['group','Group Shot','Multiple colorways together (needs 2+ varieties)'],
    ['specs','Specs Card','Text-only lens-features card \\u2014 no AI call'],
  ];
  const shmQty={hero:1,simple:1,model:0,closeup:1,feature:0,group:0,specs:1};
  const shvGlyph='<path d="M10 32c0-5 4-8 9-8s9 3 9 9-4 10-9 10-9-4-9-11zm20 1c0-6 4-9 9-9s9 3 9 8-4 11-9 11-9-4-9-10zM28 30h4" fill="none" stroke="CLR" stroke-width="2.6" stroke-linecap="round"/>';
  function shmThumb(t){
    const wrap=(inner,bg)=>'<svg viewBox="0 0 58 58" width="54" height="54" style="border-radius:9px;background:'+(bg||'#141210')+';border:1px solid var(--line2);flex:none">'+inner+'</svg>';
    const g=c=>shvGlyph.replace('CLR',c);
    if(t==='hero')return wrap('<path d="M29 4L14 27h30z" fill="rgba(244,180,0,.16)"/>'+g('#F4B400'));
    if(t==='simple')return wrap(g('#26221a'),'#f4f2ee');
    if(t==='model')return wrap('<circle cx="29" cy="21" r="11" fill="none" stroke="#8a8a92" stroke-width="2.2"/><path d="M13 52c2-9 8-14 16-14s14 5 16 14" fill="none" stroke="#8a8a92" stroke-width="2.2"/><circle cx="24" cy="21" r="4.2" fill="none" stroke="#F4B400" stroke-width="2"/><circle cx="34" cy="21" r="4.2" fill="none" stroke="#F4B400" stroke-width="2"/><path d="M28 21h2" stroke="#F4B400" stroke-width="2"/>');
    if(t==='closeup')return wrap('<circle cx="26" cy="26" r="14" fill="none" stroke="#F4B400" stroke-width="2.4"/><path d="M36 36l10 10" stroke="#F4B400" stroke-width="3" stroke-linecap="round"/><circle cx="26" cy="26" r="3" fill="#F4B400"/>');
    if(t==='feature')return wrap('<circle cx="27" cy="27" r="8" fill="none" stroke="#e8f4ff" stroke-width="1.5" stroke-dasharray="1 4"/><circle cx="27" cy="27" r="14" fill="none" stroke="#F4B400" stroke-width="1.5" stroke-dasharray="1 5"/><circle cx="27" cy="27" r="2.4" fill="#fff"/><path d="M39 19h11M39 33h11" stroke="#e8f4ff" stroke-width="1.5"/>');
    if(t==='group')return wrap('<g transform="translate(-5,-8) scale(.9)">'+g('#F4B400')+'</g><g transform="translate(9,12) scale(.9)">'+g('#8a8a92')+'</g>');
    return wrap('<path d="M15 16h20M15 26h29M15 36h24M15 46h27" stroke="#F4B400" stroke-width="2.5" stroke-linecap="round"/>');
  }
  function shvCount(){return Array.from(document.querySelectorAll('#shv_list .shv_row')).filter(r=>((r.querySelector('.shv_name')||{}).value||'').trim()&&(((r.querySelector('.shv_files')||{}).files)||[]).length).length;}
  function shmTotal(){
    const per=shmQty.hero+shmQty.simple+shmQty.model+shmQty.closeup+shmQty.feature;
    const v=Math.max(1,shvCount());
    const ident=($('#shv_identical')||{}).checked;
    return (ident?per*v:per)+((shvCount()>=2)?shmQty.group:0);
  }
  function shmPaint(){
    Array.from(document.querySelectorAll('#shm_list .shm_row')).forEach(r=>{
      const t=r.dataset.t;const q=r.querySelector('.shm_q');if(q)q.textContent=shmQty[t];
      if(t==='group')r.style.opacity=shvCount()<2?'.45':'1';
    });
    const mn=$('#shm_modelnote');if(mn)mn.style.display=shmQty.model>0?'':'none';
    const total=shmTotal();const m=$('#shm_math');
    if(m){const ident=($('#shv_identical')||{}).checked;const v=shvCount()||1;
      m.textContent=total+' AI shot(s)'+(shmQty.specs?' + specs card':'')+(ident?' \\u00b7 '+v+' variet'+(v===1?'y':'ies')+' \\u00d7 full menu':'')+' \\u00b7 ~'+Math.max(1,Math.ceil(total*0.7))+' min'+(total>12?' \\u2014 OVER THE 12-SHOT CAP':'');
      m.style.color=total>12?'#ff6b6b':'';}
  }
  function shmRender(){
    $('#shm_list').innerHTML=shmDefs.map(d=>'<div class="shm_row" data-t="'+d[0]+'" style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)">'
      +shmThumb(d[0])
      +'<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:700">'+d[1]+'</div><div class="muted" style="font-size:11.5px">'+d[2]+'</div></div>'
      +'<div style="display:flex;align-items:center;gap:10px"><button type="button" class="sec shm_minus" style="width:34px;padding:6px 0">\\u2212</button>'
      +'<span class="shm_q" style="min-width:18px;text-align:center;font-weight:800">'+shmQty[d[0]]+'</span>'
      +'<button type="button" class="sec shm_plus" style="width:34px;padding:6px 0">\\uff0b</button></div></div>').join('');
    Array.from(document.querySelectorAll('#shm_list .shm_row')).forEach(r=>{
      const t=r.dataset.t;const max=(t==='specs')?1:6;
      r.querySelector('.shm_minus').onclick=()=>{shmQty[t]=Math.max(0,shmQty[t]-1);shmPaint();};
      r.querySelector('.shm_plus').onclick=()=>{if(t==='group'&&shvCount()<2)return toast('Add a second variety (with a name + photos) first',true);shmQty[t]=Math.min(max,shmQty[t]+1);shmPaint();};
    });
    shmPaint();
  }
  function shvWireRow(row){
    const inp=row.querySelector('.shv_files');const lbl=row.querySelector('.shv_lbl');const tw=row.querySelector('.shv_thumbs');const dz=row.querySelector('.shv_drop');
    const paint=()=>{const fs=Array.from(inp.files||[]).slice(0,6);
      lbl.textContent=fs.length?fs.length+' photo(s)':'Click or drop photos';
      tw.innerHTML='';fs.forEach(f=>{const u=URL.createObjectURL(f);const d=document.createElement('div');
        d.style.cssText='width:46px;height:46px;border-radius:7px;overflow:hidden;border:1px solid var(--line2);background:#0d0d0f';
        d.innerHTML='<img src="'+u+'" style="width:100%;height:100%;object-fit:cover">';tw.appendChild(d);});
      shmPaint();};
    inp.onchange=paint;
    row.querySelector('.shv_name').addEventListener('input',shmPaint);
    const hi=on=>{dz.style.borderColor=on?'var(--gold)':'var(--line2)';};
    dz.addEventListener('dragover',e=>{e.preventDefault();hi(true);});
    dz.addEventListener('dragleave',()=>hi(false));
    dz.addEventListener('drop',e=>{e.preventDefault();hi(false);
      const files=Array.from((e.dataTransfer&&e.dataTransfer.files)||[]).filter(f=>f.type.indexOf('image/')===0).slice(0,6);
      if(!files.length)return;
      try{const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));inp.files=dt.files;}catch(_){}
      inp.dispatchEvent(new Event('change'));});
    row.querySelector('.shv_del').onclick=()=>{row.remove();shmPaint();};
  }
  function shvAddRow(){
    if(document.querySelectorAll('#shv_list .shv_row').length>=8)return toast('Max 8 varieties',true);
    const row=document.createElement('div');row.className='shv_row';
    row.style.cssText='display:flex;gap:12px;align-items:flex-start;margin-bottom:10px;padding:10px;border:1px solid var(--line2);border-radius:10px';
    row.innerHTML='<div style="flex:0 0 190px"><label style="font-size:10.5px;display:block;margin-bottom:4px">Tag / colorway name</label>'
      +'<input class="shv_name" maxlength="30" placeholder="e.g. Champagne" style="width:100%;padding:10px 12px">'
      +'<button type="button" class="sec shv_del" style="margin-top:8px;font-size:11px;padding:5px 10px">\\u2715 Remove</button></div>'
      +'<div style="flex:1"><label class="shv_drop" style="padding:14px 10px;display:block;text-align:center;border:1.5px dashed var(--line2);border-radius:9px;cursor:pointer;position:relative">'
      +'<input type="file" class="shv_files" accept="image/*" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer">'
      +'<span class="shv_lbl muted" style="font-size:12.5px">Click or drop photos</span></label>'
      +'<div class="shv_thumbs" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div></div>';
    $('#shv_list').appendChild(row);shvWireRow(row);shmPaint();
  }
  if($('#shop_box')){
    shmRender();
    shvAddRow();
    $('#shv_add').onclick=()=>shvAddRow();
    const ident=$('#shv_identical');if(ident)ident.onchange=shmPaint;
  }
  // ── Brand-a-Photo wiring ──────────────────────────────────────────────────
  if($('#brandcard_box')){
    let bcLayout='minimal';
    // Layout thumbnails use the REAL uploaded photo (once selected) instead of
    // a generic placeholder, so the user compares layouts against their own
    // frame before committing to a render. Coordinates mirror the actual
    // BrandCard composition's proportions (60x74 unit box).
    let bcPhotoUrl='';
    const bcPhotoDiv=(x,y,w,h)=>'<div style="position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;'+(bcPhotoUrl?('background-image:url('+bcPhotoUrl+');background-size:cover;background-position:center'):'background:#2a2622')+'"></div>';
    const bcFlatDiv=(x,y,w,h,color,radius,border)=>'<div style="position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;'+(radius?('border-radius:'+radius+'px;'):'')+(border?('border:'+border+';'):'')+'background:'+color+'"></div>';
    const bcCircleDiv=(cx,cy,r)=>'<div style="position:absolute;left:'+(cx-r)+'px;top:'+(cy-r)+'px;width:'+(2*r)+'px;height:'+(2*r)+'px;border-radius:50%;border:1.4px solid #fff"></div>';
    const bcBarDiv=(x,y,w,h,color,radius)=>'<div style="position:absolute;left:'+x+'px;top:'+y+'px;width:'+w+'px;height:'+h+'px;border-radius:'+(radius||2)+'px;background:'+color+'"></div>';
    const bcThumbHtml=t=>{
      const wrap=inner=>'<div style="position:relative;width:60px;height:74px;border-radius:6px;overflow:hidden;background:#141210;flex:none">'+inner+'</div>';
      if(t==='minimal')return wrap(bcPhotoDiv(0,0,60,74)+bcCircleDiv(10,10,4)+bcBarDiv(6,58,34,4,'#fff',2)+bcBarDiv(6,65,16,3,'#F4B400',1.5));
      if(t==='banner')return wrap(bcPhotoDiv(0,0,60,52)+bcFlatDiv(0,52,60,22,'#141210')+bcFlatDiv(0,52,60,2,'#F4B400')+bcCircleDiv(10,63,4)+bcBarDiv(18,61,30,4,'#fff',2));
      if(t==='editorial')return wrap(bcPhotoDiv(0,0,34,74)+bcFlatDiv(34,0,26,74,'#141210')+bcCircleDiv(47,12,4)+bcBarDiv(40,36,16,4,'#fff',2)+bcBarDiv(40,43,14,4,'#fff',2)+bcBarDiv(40,52,8,2,'#F4B400',1));
      return wrap(bcPhotoDiv(0,0,60,74)+bcFlatDiv(6,50,48,20,'rgba(20,18,16,.85)',4,'1px solid rgba(255,255,255,.2)')+bcCircleDiv(14,60,4)+bcBarDiv(22,58,26,4,'#fff',2));
    };
    const bcDefs=[['minimal','Minimal'],['banner','Banner'],['editorial','Editorial'],['badge','Badge']];
    const renderBcLayoutThumbs=()=>{
      $('#bc_layout').innerHTML=bcDefs.map(d=>'<label class="bc-lay" data-l="'+d[0]+'" style="display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;padding:8px;border:1.5px solid '+(d[0]===bcLayout?'var(--gold)':'var(--line2)')+';border-radius:9px">'+bcThumbHtml(d[0])+'<span style="font-size:11px">'+d[1]+'</span></label>').join('');
    };
    renderBcLayoutThumbs();
    const paintLay=()=>{Array.prototype.forEach.call(document.querySelectorAll('#bc_layout .bc-lay'),el=>{el.style.borderColor=el.dataset.l===bcLayout?'var(--gold)':'var(--line2)';});};
    // Delegated on the parent (survives renderBcLayoutThumbs() rebuilding children).
    $('#bc_layout').addEventListener('click',e=>{const el=e.target.closest('.bc-lay');if(!el)return;bcLayout=el.dataset.l;paintLay();bcSaveState();});
    window._bcLayout=()=>bcLayout;
    // Treatment radios highlight
    const paintTreat=()=>{Array.prototype.forEach.call(document.querySelectorAll('#bc_treatment .bc-opt'),el=>{const r=el.querySelector('input');el.style.borderColor=r.checked?'var(--gold)':'var(--line2)';el.style.background=r.checked?'rgba(232,182,74,.06)':'transparent';});};
    Array.prototype.forEach.call(document.querySelectorAll('input[name="bc_treat"]'),r=>r.onchange=()=>{paintTreat();bcSaveState();});paintTreat();
    // Text mode toggle
    const paintText=()=>{const ai=(document.querySelector('input[name="bc_text"]:checked')||{}).value==='ai';
      const tp=$('#bc_tagline');if(tp)tp.placeholder=ai?'Optional hint for the AI (or leave blank)':'Your tagline (e.g. Clear vision, all-day comfort)';
      const h=$('#bc_tag_hint');if(h)h.style.display=ai?'':'none';
      const ib=$('#bc_tag_ideas_btn');if(ib)ib.style.display=ai?'inline-flex':'none';
      if(!ai){const ideas=$('#bc_tag_ideas');if(ideas){ideas.style.display='none';ideas.innerHTML='';}}
      // Same toggle for every batch row's own "4 ideas" button (rows are added
      // dynamically, so this must re-run on every text-mode change, not just once).
      Array.prototype.forEach.call(document.querySelectorAll('.bcb_ideas_btn'),b=>{b.style.display=ai?'inline-flex':'none';});
      if(!ai)Array.prototype.forEach.call(document.querySelectorAll('.bcb_ideas'),d=>{d.style.display='none';d.innerHTML='';});};
    Array.prototype.forEach.call(document.querySelectorAll('input[name="bc_text"]'),r=>r.onchange=()=>{paintText();bcSaveState();});paintText();
    // 4 AI tagline suggestions — a lightweight direct call (not a full render
    // job); picking one commits it as "own" text so the render job uses it
    // verbatim instead of re-rolling its own single AI tagline.
    const bcIdeasBtn=$('#bc_tag_ideas_btn');
    if(bcIdeasBtn)bcIdeasBtn.onclick=async()=>{
      bcIdeasBtn.disabled=true;const origLabel=bcIdeasBtn.textContent;bcIdeasBtn.textContent='Thinking…';
      const ideasBox=$('#bc_tag_ideas');
      try{
        const r=await fetch('/api/brandcard/taglines',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({client:CLIENT,productName:($('#bc_product')||{}).value||'',hint:($('#bc_tagline')||{}).value||''})});
        const d=await r.json().catch(()=>({}));
        if(!r.ok||!d.taglines||!d.taglines.length){toast(d.error||'Could not get tagline ideas',true);return;}
        ideasBox.style.display='flex';
        ideasBox.innerHTML=d.taglines.map((t,i)=>'<button type="button" class="sec bc-tag-idea" data-i="'+i+'" style="font-size:12px;padding:8px 12px;text-align:left;max-width:100%">'+t.replace(/</g,'&lt;')+'</button>').join('');
        Array.prototype.forEach.call(ideasBox.querySelectorAll('.bc-tag-idea'),(btn,i)=>{
          btn.onclick=()=>{
            $('#bc_tagline').value=d.taglines[i];
            const ownRadio=document.querySelector('input[name="bc_text"][value="own"]');
            if(ownRadio){ownRadio.checked=true;ownRadio.dispatchEvent(new Event('change'));} // clears/hides the ideas box via paintText()
            bcSaveState();
          };
        });
      }catch(e){toast('Network error getting tagline ideas',true);}
      bcIdeasBtn.disabled=false;bcIdeasBtn.textContent=origLabel;
    };
    // Photo dropzone + preview (1-6 photos). 2+ photos auto-forces AI re-shoot
    // and locks the treatment picker, since only re-shoot can use multiple
    // reference angles — original/cleanup only ever look at one photo.
    const bcFile=$('#bc_photo');
    // A FileList is immutable, so "removing" a photo means rebuilding the
    // input's list from a DataTransfer minus that index.
    const removeFileAt=(inp,idx)=>{
      const fs=Array.from(inp.files||[]);
      if(idx<0||idx>=fs.length)return false;
      fs.splice(idx,1);
      try{const dt=new DataTransfer();fs.forEach(f=>dt.items.add(f));inp.files=dt.files;}catch(_){return false;}
      return true;
    };
    // One clickable thumbnail with a hover ✕ overlay; click removes it.
    const makeThumb=(file,size,onRemove)=>{
      const u=URL.createObjectURL(file);
      const d=document.createElement('div');
      d.title='Click to remove';
      d.style.cssText='position:relative;width:'+size+'px;height:'+size+'px;border-radius:8px;overflow:hidden;border:1px solid var(--line2);background:#0d0d0f;cursor:pointer;flex:none';
      d.innerHTML='<img src="'+u+'" style="width:100%;height:100%;object-fit:cover;display:block">'
        +'<div class="thumb_x" style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,8,10,.62);color:#fff;font-size:'+Math.round(size/3.4)+'px;line-height:1">\\u2715</div>';
      const x=d.querySelector('.thumb_x');
      d.addEventListener('mouseenter',()=>{x.style.display='flex';});
      d.addEventListener('mouseleave',()=>{x.style.display='none';});
      d.addEventListener('click',onRemove);
      return {el:d,url:u};
    };
    // ── Persisted brand-card state (text + Files together, in IndexedDB) ────
    const BC_STATE_KEY='brandcard_state_'+CLIENT;
    let bcRestoring=false,bcDirty=false,bcSaveT=null;
    const bcCollectState=()=>({
      treatment:(document.querySelector('input[name="bc_treat"]:checked')||{}).value||'original',
      textMode:(document.querySelector('input[name="bc_text"]:checked')||{}).value||'own',
      tagline:($('#bc_tagline')||{}).value||'',
      product:($('#bc_product')||{}).value||'',
      aspect:($('#bc_aspect')||{}).value||'4:5',
      showLogo:!!(($('#bc_logo')||{}).checked),
      layout:bcLayout,
      batchMode:!!(($('#bc_batch_toggle')||{}).checked),
      photos:Array.from(bcFile.files||[]).slice(0,6),
      rows:Array.prototype.map.call(document.querySelectorAll('#bcb_list .bcb_row'),row=>({
        photos:Array.from(((row.querySelector('.bcb_files')||{}).files)||[]).slice(0,6),
        tagline:((row.querySelector('.bcb_tagline')||{}).value)||'',
        product:((row.querySelector('.bcb_product')||{}).value)||''
      }))
    });
    // Debounced so typing doesn't hit IDB on every keystroke. The bcRestoring
    // guard stops the restore pass from saving over the state it is reading.
    const bcSaveState=()=>{
      if(bcRestoring)return;
      bcDirty=true;
      clearTimeout(bcSaveT);
      bcSaveT=setTimeout(()=>{idbSet(BC_STATE_KEY,bcCollectState());},250);
    };
    const bcRestoreState=async()=>{
      const s=await idbGet(BC_STATE_KEY);
      // If the user already started interacting while IDB was resolving, their
      // input wins — never clobber live typing with a stale snapshot.
      if(!s||bcDirty)return;
      bcRestoring=true;
      try{
        if($('#bc_tagline')&&s.tagline)$('#bc_tagline').value=s.tagline;
        if($('#bc_product')&&s.product)$('#bc_product').value=s.product;
        if($('#bc_aspect')&&s.aspect)$('#bc_aspect').value=s.aspect;
        if($('#bc_logo')&&s.showLogo!=null)$('#bc_logo').checked=!!s.showLogo;
        if(s.layout&&['minimal','banner','editorial','badge'].indexOf(s.layout)>=0)bcLayout=s.layout;
        const txr=document.querySelector('input[name="bc_text"][value="'+(s.textMode==='ai'?'ai':'own')+'"]');
        if(txr)txr.checked=true;
        // Photos before bcPaint — its 2+-photo rule may lock the treatment.
        if(s.photos&&s.photos.length){
          try{const dt=new DataTransfer();s.photos.slice(0,6).forEach(f=>dt.items.add(f));bcFile.files=dt.files;}catch(_){}
        }
        bcPaint();
        // Treatment AFTER bcPaint, so a 1-photo restore keeps the saved choice
        // instead of whatever the picker happened to default to.
        if(Array.from(bcFile.files||[]).length<2&&s.treatment){
          const tr=document.querySelector('input[name="bc_treat"][value="'+s.treatment+'"]');
          if(tr)tr.checked=true;
        }
        paintTreat();paintLay();renderBcLayoutThumbs();
        if(s.batchMode&&$('#bc_batch_toggle')){
          $('#bc_batch_toggle').checked=true;
          $('#bcb_list').innerHTML='';
          (s.rows||[]).forEach(rw=>{
            bcbAddRow();
            const row=$('#bcb_list').lastElementChild;
            if(!row)return;
            if(rw.tagline)row.querySelector('.bcb_tagline').value=rw.tagline;
            if(rw.product)row.querySelector('.bcb_product').value=rw.product;
            if(rw.photos&&rw.photos.length){
              const fi=row.querySelector('.bcb_files');
              try{const dt=new DataTransfer();rw.photos.slice(0,6).forEach(f=>dt.items.add(f));fi.files=dt.files;}catch(_){}
              fi.dispatchEvent(new Event('change'));
            }
          });
          bcPaintBatchMode();
        }
        // Last — it also syncs every batch row's tagline-ideas button.
        paintText();
      }finally{bcRestoring=false;}
    };
    const bcPaint=()=>{const fs=Array.from(bcFile.files||[]).slice(0,6);
      $('#bc_photo_lbl').textContent=fs.length?fs.length+' photo(s) selected \\u2014 click one to remove':'Click or drop 1\\u20136 photos here';
      const tw=$('#bc_thumb');tw.innerHTML='';
      bcPhotoUrl='';
      fs.forEach((f,i)=>{const t=makeThumb(f,64,()=>{if(removeFileAt(bcFile,i)){bcPaint();bcSaveState();}});
        if(i===0)bcPhotoUrl=t.url;tw.appendChild(t.el);});
      renderBcLayoutThumbs();
      const multi=fs.length>1;
      const hint=$('#bc_multi_hint');if(hint)hint.style.display=multi?'':'none';
      Array.prototype.forEach.call(document.querySelectorAll('input[name="bc_treat"]'),r=>{
        if(multi){r.checked=(r.value==='reshoot');r.disabled=(r.value!=='reshoot');}
        else{r.disabled=false;}
      });
      Array.prototype.forEach.call(document.querySelectorAll('#bc_treatment .bc-opt'),el=>{
        const r=el.querySelector('input');el.style.opacity=r.disabled?'0.4':'1';el.style.cursor=r.disabled?'default':'pointer';
        el.style.borderColor=r.checked?'var(--gold)':'var(--line2)';el.style.background=r.checked?'rgba(232,182,74,.06)':'transparent';
      });
    };
    if(bcFile)bcFile.onchange=()=>{bcPaint();bcSaveState();};
    {const dz=$('#bc_drop');if(dz){
      dz.addEventListener('dragover',e=>{e.preventDefault();dz.style.borderColor='var(--gold)';});
      dz.addEventListener('dragleave',()=>{dz.style.borderColor='var(--line2)';});
      dz.addEventListener('drop',e=>{e.preventDefault();dz.style.borderColor='var(--line2)';
        const files=Array.from((e.dataTransfer&&e.dataTransfer.files)||[]).filter(f=>f.type.indexOf('image/')===0).slice(0,6);
        if(!files.length)return;
        try{const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));bcFile.files=dt.files;}catch(_){}
        bcPaint();bcSaveState();});}}
    // Card-style presets (localStorage) — captures treatment/text mode/logo/
    // layout/aspect so a repeated look doesn't need re-picking every time.
    const BC_PS_KEY='bc_presets_v1';
    const bcPsLoad=()=>{try{return JSON.parse(localStorage.getItem(BC_PS_KEY)||'[]');}catch(_){return [];}};
    const bcPsSave=arr=>{try{localStorage.setItem(BC_PS_KEY,JSON.stringify(arr));}catch(_){}};
    const bcPsSel=$('#bc_preset_sel');
    const bcPsDelBtn=$('#bc_preset_del');
    const bcPsRender=selectName=>{
      const list=bcPsLoad();
      bcPsSel.innerHTML='<option value="">\\u2014 none \\u2014</option>'+list.map(p=>'<option value="'+String(p.name).replace(/"/g,'&quot;')+'">'+String(p.name).replace(/</g,'&lt;')+'</option>').join('');
      bcPsSel.value=selectName||'';
      bcPsDelBtn.style.display=bcPsSel.value?'':'none';
    };
    const bcPsCurrent=()=>({
      treatment:(document.querySelector('input[name="bc_treat"]:checked')||{}).value||'original',
      textMode:(document.querySelector('input[name="bc_text"]:checked')||{}).value||'own',
      showLogo:!!($('#bc_logo')||{}).checked,
      layout:bcLayout,
      aspect:($('#bc_aspect')||{}).value||'4:5'
    });
    const bcPsApply=p=>{
      if(!p)return;
      const multiNow=Array.from((bcFile.files||[])).length>1;
      if(!multiNow)Array.prototype.forEach.call(document.querySelectorAll('input[name="bc_treat"]'),r=>{r.checked=(r.value===p.treatment);});
      Array.prototype.forEach.call(document.querySelectorAll('input[name="bc_text"]'),r=>{r.checked=(r.value===p.textMode);});
      if($('#bc_logo'))$('#bc_logo').checked=!!p.showLogo;
      bcLayout=['minimal','banner','editorial','badge'].indexOf(p.layout)>=0?p.layout:'minimal';
      paintLay();paintTreat();paintText();
      if($('#bc_aspect'))$('#bc_aspect').value=['1:1','4:5','9:16','all'].indexOf(p.aspect)>=0?p.aspect:'4:5';
      bcSaveState();
    };
    bcPsRender();
    bcPsSel.onchange=()=>{
      const name=bcPsSel.value;
      bcPsDelBtn.style.display=name?'':'none';
      if(!name)return;
      const p=bcPsLoad().find(x=>x.name===name);
      if(p)bcPsApply(p);
    };
    $('#bc_preset_save').onclick=()=>{
      const name=(window.prompt('Name this card style:','')||'').trim().slice(0,40);
      if(!name)return;
      const list=bcPsLoad();
      const cur=bcPsCurrent();
      const i=list.findIndex(p=>p.name===name);
      const entry=Object.assign({name:name},cur);
      if(i>=0)list[i]=entry;else list.push(entry);
      bcPsSave(list);
      bcPsRender(name);
      toast('Saved preset "'+name+'"');
    };
    bcPsDelBtn.onclick=()=>{
      const name=bcPsSel.value;if(!name)return;
      if(!window.confirm('Delete preset "'+name+'"?'))return;
      bcPsSave(bcPsLoad().filter(p=>p.name!==name));
      bcPsRender();
    };
    // Regenerate — replays the last submission's exact photos + settings
    // (single card or the whole batch, whichever ran last).
    const bcRetryBtn=$('#bc_retry_btn');
    if(bcRetryBtn)bcRetryBtn.onclick=async()=>{
      if(!bcLastSubmit||!bcLastSubmit.items||!bcLastSubmit.items.length)return;
      bcRetryBtn.disabled=true;
      for(const it of bcLastSubmit.items){await submitBrandCard(it.photos,it.plan);}
      if(bcLastSubmit.items.length>1)toast('\\ud83d\\udd01 Regenerating '+bcLastSubmit.items.length+' brand cards\\u2026');
      bcRetryBtn.disabled=false;
    };
    // Batch mode toggle — swaps the single photo/tagline UI for a per-frame
    // list; shared treatment/text-mode/logo/layout/aspect still apply to all.
    const bcBatchToggle=$('#bc_batch_toggle');
    const bcbWireRow=row=>{
      const inp=row.querySelector('.bcb_files'),lbl=row.querySelector('.bcb_lbl'),tw=row.querySelector('.bcb_thumbs'),dz=row.querySelector('.bcb_drop');
      const paint=()=>{const fs=Array.from(inp.files||[]).slice(0,6);
        lbl.textContent=fs.length?fs.length+' photo(s) \\u2014 click one to remove':'Click or drop 1\\u20136 photos';
        tw.innerHTML='';
        fs.forEach((f,i)=>{const t=makeThumb(f,46,()=>{if(removeFileAt(inp,i)){paint();bcSaveState();}});tw.appendChild(t.el);});};
      inp.onchange=()=>{paint();bcSaveState();};
      const hi=on=>{dz.style.borderColor=on?'var(--gold)':'var(--line2)';};
      dz.addEventListener('dragover',e=>{e.preventDefault();hi(true);});
      dz.addEventListener('dragleave',()=>hi(false));
      dz.addEventListener('drop',e=>{e.preventDefault();hi(false);
        const files=Array.from((e.dataTransfer&&e.dataTransfer.files)||[]).filter(f=>f.type.indexOf('image/')===0).slice(0,6);
        if(!files.length)return;
        try{const dt=new DataTransfer();files.forEach(f=>dt.items.add(f));inp.files=dt.files;}catch(_){}
        paint();bcSaveState();});
      row.querySelector('.bcb_del').onclick=()=>{row.remove();bcSaveState();};
      Array.prototype.forEach.call(row.querySelectorAll('.bcb_tagline,.bcb_product'),f=>f.addEventListener('input',bcSaveState));
      // Per-row "4 tagline ideas" — same lightweight endpoint as single mode,
      // scoped to this row's own product name + tagline-as-hint.
      const ideasBtn=row.querySelector('.bcb_ideas_btn'),ideasBox=row.querySelector('.bcb_ideas');
      const taglineField=row.querySelector('.bcb_tagline'),productField=row.querySelector('.bcb_product');
      if(ideasBtn)ideasBtn.onclick=async()=>{
        ideasBtn.disabled=true;const orig=ideasBtn.textContent;ideasBtn.textContent='Thinking\\u2026';
        try{
          const r=await fetch('/api/brandcard/taglines',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({client:CLIENT,productName:(productField||{}).value||'',hint:(taglineField||{}).value||''})});
          const d=await r.json().catch(()=>({}));
          if(!r.ok||!d.taglines||!d.taglines.length){toast(d.error||'Could not get tagline ideas',true);return;}
          ideasBox.style.display='flex';
          ideasBox.innerHTML=d.taglines.map((t,i)=>'<button type="button" class="sec bcb-tag-idea" data-i="'+i+'" style="font-size:11.5px;padding:6px 10px;text-align:left;max-width:100%">'+t.replace(/</g,'&lt;')+'</button>').join('');
          Array.prototype.forEach.call(ideasBox.querySelectorAll('.bcb-tag-idea'),(btn,i)=>{
            btn.onclick=()=>{taglineField.value=d.taglines[i];ideasBox.style.display='none';ideasBox.innerHTML='';bcSaveState();};
          });
        }catch(e){toast('Network error getting tagline ideas',true);}
        ideasBtn.disabled=false;ideasBtn.textContent=orig;
      };
    };
    const bcbAddRow=()=>{
      if(document.querySelectorAll('#bcb_list .bcb_row').length>=10)return toast('Max 10 frames per batch',true);
      const row=document.createElement('div');row.className='bcb_row';
      row.style.cssText='display:flex;gap:12px;align-items:flex-start;margin-bottom:10px;padding:10px;border:1px solid var(--line2);border-radius:10px';
      row.innerHTML='<div style="flex:1"><label class="bcb_drop" style="padding:14px 10px;display:block;text-align:center;border:1.5px dashed var(--line2);border-radius:9px;cursor:pointer;position:relative">'
        +'<input type="file" class="bcb_files" accept="image/*" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer">'
        +'<span class="bcb_lbl muted" style="font-size:12.5px">Click or drop 1\\u20136 photos</span></label>'
        +'<div class="bcb_thumbs" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div></div>'
        +'<div style="flex:1;display:flex;flex-direction:column;gap:8px">'
        +'<input class="bcb_tagline" maxlength="140" placeholder="Tagline (or AI hint, if \\u2018Let AI suggest\\u2019 is on)" style="width:100%;padding:10px 12px">'
        +'<button type="button" class="sec bcb_ideas_btn" style="display:none;align-self:flex-start;font-size:11px;padding:5px 10px">\\u2728 4 ideas</button>'
        +'<div class="bcb_ideas" style="display:none;flex-wrap:wrap;gap:6px"></div>'
        +'<input class="bcb_product" maxlength="40" placeholder="Product / model name (optional)" style="width:100%;padding:10px 12px">'
        +'<button type="button" class="sec bcb_del" style="align-self:flex-start;font-size:11px;padding:5px 10px">\\u2715 Remove</button></div>';
      $('#bcb_list').appendChild(row);bcbWireRow(row);
      // A row can be added after "Let AI suggest" is already selected — sync
      // its ideas button to the CURRENT mode instead of always starting hidden.
      const aiNow=(document.querySelector('input[name="bc_text"]:checked')||{}).value==='ai';
      const ib=row.querySelector('.bcb_ideas_btn');if(ib)ib.style.display=aiNow?'inline-flex':'none';
    };
    const bcPaintBatchMode=()=>{
      const on=!!(bcBatchToggle&&bcBatchToggle.checked);
      const sp=$('#bc_single_photo');if(sp)sp.style.display=on?'none':'';
      const bp=$('#bc_batch_photo');if(bp)bp.style.display=on?'':'none';
      const st=$('#bc_single_text');if(st)st.style.display=on?'none':'';
      const btn=$('#bc_batch_text_note');if(btn)btn.style.display=on?'':'none';
      const spd=$('#bc_single_product');if(spd)spd.style.display=on?'none':'';
      if(on&&document.querySelectorAll('#bcb_list .bcb_row').length===0)bcbAddRow();
    };
    if(bcBatchToggle)bcBatchToggle.onchange=()=>{bcPaintBatchMode();bcSaveState();};
    const bcbAddBtn=$('#bcb_add');if(bcbAddBtn)bcbAddBtn.onclick=()=>{bcbAddRow();bcSaveState();};
    // ── Remember the last brand card (inputs AND uploaded photos) ──────────
    // Leaving for the Batches tab (or any tab) destroys this whole view, so
    // everything is snapshotted to IndexedDB — text in the same record as the
    // Files, which keeps the batch rows' photos and their captions in step.
    ['#bc_tagline','#bc_product'].forEach(sel=>{const el=$(sel);if(el)el.addEventListener('input',bcSaveState);});
    ['#bc_aspect','#bc_logo'].forEach(sel=>{const el=$(sel);if(el)el.addEventListener('change',bcSaveState);});
    bcRestoreState();
  }
  document.querySelectorAll('input[name="shop_spec"]').forEach(c=>{
    const paint=()=>{c.closest('.spec-chip').style.borderColor=c.checked?'var(--gold)':'var(--line2)';
      c.closest('.spec-chip').style.background=c.checked?'rgba(232,182,74,.08)':'transparent';};
    c.onchange=paint;paint();
  });
  // Advice/tweet custom avatar preview.
  if($('#advice_avatar')){
    $('#advice_avatar').onchange=()=>{
      const f=$('#advice_avatar').files&&$('#advice_avatar').files[0];
      if(f)$('#advice_avatar_prev').style.backgroundImage='url('+URL.createObjectURL(f)+')';
    };
  }
  // ── Eyeglasses poster-style card wiring ──────────────────────────────────
  function syncPspCards() {
    document.querySelectorAll('#ea_psp_grid .esty-img-card').forEach(el => {
      const r = el.querySelector('input[name="g_psp"]');
      if (!r) return;
      el.style.borderColor = r.checked ? 'var(--gold)' : 'var(--line)';
    });
  }
  function syncEstyCards() {
    document.querySelectorAll('#g_estyle_box > div:first-child .esty-card').forEach(el => {
      const r = el.querySelector('input[name="g_estyle"]');
      if (!r) return;
      el.style.borderColor = r.checked ? 'var(--gold)' : 'var(--line)';
      el.style.background = r.checked ? 'rgba(232,182,74,.04)' : 'transparent';
    });
    const eStyleVal = (document.querySelector('input[name="g_estyle"]:checked') || {}).value || 'showcase';
    const pspBox = $('#ea_psp_box'), msBox = $('#ea_ms_box');
    if (eStyleVal === 'showcase') {
      if (pspBox) pspBox.style.display = 'block';
      if (msBox)  msBox.style.display  = 'none';
    } else if (eStyleVal === 'model') {
      if (pspBox) pspBox.style.display = 'none';
      if (msBox)  msBox.style.display  = 'block';
    } else {
      if (pspBox) pspBox.style.display = 'none';
      if (msBox)  msBox.style.display  = 'none';
    }
  }
  function syncModelStyleCards() {
    document.querySelectorAll('#ea_ms_grid .esty-img-card').forEach(el => {
      const r = el.querySelector('input[name="g_mstyle"]');
      if (!r) return;
      el.style.borderColor = r.checked ? 'var(--gold)' : 'var(--line)';
    });
  }
  document.querySelectorAll('input[name="g_estyle"]').forEach(r => {
    r.onchange = () => { syncEstyCards(); saveGenSettings(); };
  });
  document.querySelectorAll('input[name="g_psp"]').forEach(r => {
    r.onchange = () => { syncPspCards(); saveGenSettings(); };
  });
  document.querySelectorAll('input[name="g_mstyle"]').forEach(r => {
    r.onchange = () => { syncModelStyleCards(); saveGenSettings(); };
  });
  syncEstyCards();
  // ── Generate settings persistence (localStorage) ─────────────────────────
  const _SKEY='gen_settings_'+CLIENT;
  function saveGenSettings(){
    const arDist={};
    document.querySelectorAll('.ar-chk').forEach(chk=>{
      if(chk.checked){const card=chk.closest('.ar-card'),sl=card&&card.querySelector('.ar-slider');
        if(sl)arDist[chk.dataset.ar]=sl.value;}
    });
    const s={
      ptype:curPosterType(),
      topic:$('#g_topic')?$('#g_topic').value:'',
      headline:$('#ea_headline')?$('#ea_headline').value:'',
      promo:$('#ea_promo')?$('#ea_promo').value:'',
      brief:$('#g_brief')?$('#g_brief').value:'',
      brand:$('#g_brand')?$('#g_brand').value:'',
      logoOn:$('#g_logo_on')?$('#g_logo_on').checked:true,
      ctaOn:$('#g_cta_on')?$('#g_cta_on').checked:true,
      aiHeadOn:$('#g_ai_head')?$('#g_ai_head').checked:false,
      count:$('#g_count')?$('#g_count').value:'8',
      subject:$('#g_subject')?$('#g_subject').value:'',
      estyle:(document.querySelector('input[name="g_estyle"]:checked')||{}).value||'showcase',
      psp:(document.querySelector('input[name="g_psp"]:checked')||{}).value||'auto',
      mstyle:(document.querySelector('input[name="g_mstyle"]:checked')||{}).value||'auto',
      arDist,
    };
    try{localStorage.setItem(_SKEY,JSON.stringify(s));}catch{}
  }
  function loadGenSettings(){
    let s;try{s=JSON.parse(localStorage.getItem(_SKEY)||'null');}catch{}
    if(!s)return;
    // Poster type first — determines which subject dropdown paintSubject renders
    if(s.ptype){
      const pto=document.querySelector('input[name="g_ptype"][value="'+s.ptype+'"]');
      if(pto&&!pto.checked){pto.checked=true;syncPtypeCards();paintSubject();}
    }
    // Topic / headline
    if($('#g_topic')&&s.topic)$('#g_topic').value=s.topic;
    if($('#ea_headline')&&s.headline)$('#ea_headline').value=s.headline;
    if($('#ea_promo')&&s.promo)$('#ea_promo').value=s.promo;
    // Brief / brand
    if($('#g_brief')&&s.brief)$('#g_brief').value=s.brief;
    if($('#g_brand')&&s.brand){$('#g_brand').value=s.brand;updLogo();}
    // Logo + count
    if($('#g_logo_on')&&s.logoOn!=null)$('#g_logo_on').checked=s.logoOn;
    if($('#g_cta_on')&&s.ctaOn!=null)$('#g_cta_on').checked=s.ctaOn;
    if($('#g_ai_head')&&s.aiHeadOn!=null)$('#g_ai_head').checked=s.aiHeadOn;
    if($('#g_count')&&s.count)$('#g_count').value=s.count;
    // Subject — rendered by paintSubject above, fire change so preview updates
    if($('#g_subject')&&s.subject){$('#g_subject').value=s.subject;$('#g_subject').dispatchEvent(new Event('change'));}
    // Eyeglasses style / preset / model style
    if(s.estyle){const er=document.querySelector('input[name="g_estyle"][value="'+s.estyle+'"]');
      if(er&&!er.checked){er.checked=true;syncEstyCards();}}
    if(s.psp){const pr=document.querySelector('input[name="g_psp"][value="'+s.psp+'"]');
      if(pr&&!pr.checked){pr.checked=true;syncPspCards();}}
    if(s.mstyle){const mr=document.querySelector('input[name="g_mstyle"][value="'+s.mstyle+'"]');
      if(mr&&!mr.checked){mr.checked=true;syncModelStyleCards();}}
    // Aspect-ratio distribution
    if(s.arDist&&typeof s.arDist==='object'){
      document.querySelectorAll('.ar-chk').forEach(chk=>{
        const pct=s.arDist[chk.dataset.ar];
        if(pct!=null){chk.checked=true;
          const card=chk.closest('.ar-card'),sl=card&&card.querySelector('.ar-slider');
          if(sl)sl.value=pct;}
      });
    }
  }
  // Wire remaining fields to save on change
  if($('#g_topic'))$('#g_topic').oninput=saveGenSettings;
  if($('#ea_headline'))$('#ea_headline').oninput=saveGenSettings;
  if($('#ea_promo'))$('#ea_promo').oninput=saveGenSettings;
  if($('#g_logo_on'))$('#g_logo_on').onchange=saveGenSettings;
  if($('#g_cta_on'))$('#g_cta_on').onchange=saveGenSettings;
  if($('#g_ai_head'))$('#g_ai_head').onchange=saveGenSettings;
  if($('#g_count'))$('#g_count').onchange=saveGenSettings;
  loadGenSettings();

  // ── Custom style reference file inputs ───────────────────────────────────
  function wireStyleRefInput(fileInputId, labelId, clearBtnId) {
    const fi=$('#'+fileInputId), lbl=$('#'+labelId), clr=$('#'+clearBtnId);
    if(!fi)return;
    fi.onchange=()=>{
      const f=fi.files[0];
      if(f){lbl.textContent='📎 '+f.name;if(clr)clr.style.display='';}
      else{lbl.textContent='Click or drop an image here';if(clr)clr.style.display='none';}
    };
    if(clr)clr.onclick=()=>{fi.value='';lbl.textContent='Click or drop an image here';clr.style.display='none';};
  }
  wireStyleRefInput('ea_skref_file','ea_skref_lbl','ea_skref_clear');
  wireStyleRefInput('ea_msref_file','ea_msref_lbl','ea_msref_clear');
  // ── Aspect-ratio mix wiring ──
  // Sliders always sum to exactly 100%: dragging one redistributes the
  // remainder across the other CHECKED ratios proportionally to their
  // current shares (largest-remainder rounding so the total never drifts).
  // Checking/unchecking a ratio rebalances the same way. The dragged slider
  // snaps to AR_STEP; the others can land on any whole percent so the mix
  // always totals 100 \\u2014 only the slider you're moving needs "nice" steps.
  const AR_STEP=5;
  const arCard=r=>document.querySelector('.ar-card[data-ar="'+r+'"]');
  const arCards=()=>AR_RATIOS.map(arCard);
  const arActive=()=>arCards().filter(c=>c.querySelector('.ar-chk').checked);
  const arSnap=v=>Math.max(0,Math.min(100,Math.round(v/AR_STEP)*AR_STEP));
  // Largest-remainder distribution of an integer total across relative weights.
  function arDistribute(total,weights){
    const n=weights.length;
    if(!n)return[];
    if(total<=0)return weights.map(()=>0);
    const sumW=weights.reduce((a,b)=>a+b,0);
    const raw=weights.map(w=>sumW>0?total*w/sumW:total/n);
    const floor=raw.map(Math.floor);
    let used=floor.reduce((a,b)=>a+b,0);
    const order=raw.map((r,i)=>({i,frac:r-floor[i]})).sort((a,b)=>b.frac-a.frac);
    let k=0;
    while(used<total&&k<order.length){floor[order[k].i]+=1;used+=1;k++;}
    return floor;
  }
  function arPaint(){
    let bar='';
    AR_RATIOS.forEach(r=>{
      const c=arCard(r),on=c.querySelector('.ar-chk').checked;
      const v=+c.querySelector('.ar-slider').value||0;
      const lbl=c.querySelector('.ar-pctval');if(lbl)lbl.textContent=v+'%';
      c.style.borderColor=on?AR_COLORS[r]:'var(--line)';
      c.style.background=on?AR_COLORS[r]+'14':'transparent';
      if(on&&v>0)bar+='<div style="flex:'+v+' 0 0;background:'+AR_COLORS[r]+'" title="'+r+' \\xb7 '+v+'%"></div>';
    });
    const barEl=$('#ar_bar');
    if(barEl)barEl.innerHTML=bar||'<div style="flex:1 0 0;background:var(--line)"></div>';
    updArPrev();
  }
  function updArPrev(){
    const el=$('#ar_prev');if(!el)return;
    const n=Math.max(1,+($('#g_count')?.value)||8);
    const picks=[];
    arCards().forEach(c=>{
      if(c.querySelector('.ar-chk').checked){
        const v=+c.querySelector('.ar-slider').value||0;
        if(v>0)picks.push([c.dataset.ar,v]);
      }
    });
    if(!picks.length){el.textContent='All '+n+' poster(s) will render 4:5 (default).';return;}
    const parts=picks.map(([ar,p])=>ar+' \\xd7 ~'+Math.round(n*p/100));
    el.textContent='\\u2248 '+parts.join('   \\xb7   ');
  }
  // Sets "ratio" to "rawVal" (snapped) and rebalances the other active ratios
  // to fill the remainder, proportional to their current shares.
  function arSetValue(ratio,rawVal){
    const card=arCard(ratio);
    const active=arActive();
    if(!active.find(c=>c.dataset.ar===ratio))return;
    const others=active.filter(c=>c.dataset.ar!==ratio);
    let val;
    if(!others.length){
      val=100; // sole active ratio always owns the full mix
    }else{
      val=arSnap(rawVal);
      const remaining=100-val;
      const weights=others.map(c=>+c.querySelector('.ar-slider').value||0);
      const dist=arDistribute(remaining,weights);
      others.forEach((c,i)=>{c.querySelector('.ar-slider').value=dist[i];});
    }
    card.querySelector('.ar-slider').value=val;
    arPaint();
  }
  // Checking a ratio gives it an even share of the now-active set (shrinking
  // the rest to fit); unchecking zeroes it and redistributes its share.
  function arToggle(ratio,checked){
    const card=arCard(ratio),sl=card.querySelector('.ar-slider');
    sl.disabled=!checked;
    if(checked){
      const evenShare=Math.round(100/arActive().length);
      arSetValue(ratio,evenShare);
    }else{
      sl.value=0;
      const active=arActive();
      if(active.length){
        const weights=active.map(c=>+c.querySelector('.ar-slider').value||0);
        const dist=arDistribute(100,weights);
        active.forEach((c,i)=>{c.querySelector('.ar-slider').value=dist[i];});
      }
      arPaint();
    }
  }
  AR_RATIOS.forEach(r=>{
    const c=arCard(r);
    c.querySelector('.ar-chk').onchange=e=>{arToggle(r,e.target.checked);saveGenSettings();};
    c.querySelector('.ar-slider').oninput=e=>{arSetValue(r,+e.target.value);saveGenSettings();};
  });
  $('#g_count')&&$('#g_count').addEventListener('input',updArPrev);
  arPaint();
  let phase='';
  function setProg(p,err){const b=$('#g_bar'),t=$('#g_pct');if(!b)return;
    p=Math.max(0,Math.min(100,Math.round(p)));b.style.width=p+'%';
    if(err){b.style.background='linear-gradient(90deg,var(--red),#ff6b6b)';t.textContent='Failed — see log';}
    else t.textContent=p+'%'+(p>=100?' — done':'');}
  function progFrom(line){
    if(line.indexOf('Step 1')>-1){phase='q';return 6;}
    if(/✓\\s+\\d+\\s+.*quotes in/.test(line))return 15;
    if(line.indexOf('Step 2')>-1){phase='bg';return 16;}
    if(line.indexOf('Step 3')>-1){phase='render';return 62;}
    if(line.indexOf('Tranzzie shop card')>-1){phase='shop';return 6;}
    if(line.indexOf('Bundling Remotion')>-1)return 12;
    const m=line.match(/\\[(\\d+)\\/(\\d+)\\]/);
    if(m){const i=+m[1],n=+m[2]||1;
      if(phase==='bg'||/\\bbg-/.test(line))return 16+44*(i/n);
      if(phase==='render')return 62+35*(i/n);
      if(phase==='shop')return 15+80*(i/n);}
    if(line.indexOf('✓ Done')>-1)return 100;
    return -1;}
  // Generation-queue badge: shows "⏳ N queued" + a clear button while
  // batches are waiting behind the running one.
  function updateQInfo(s){
    const el=$('#g_qinfo');if(!el)return;
    const n=(s&&s.queued)||0;
    el.style.display=n>0?'inline-flex':'none';
    if(n>0)$('#g_qcount').textContent='⏳ '+n+' queued';
  }
  // Check if a job is already running (e.g. user refreshed mid-job or lock is
  // stuck). The button stays ENABLED — pressing it queues another batch.
  api('/api/status').then(s=>{
    if(s.running){$('#g_unlock').style.display='inline-flex';$('#g_unlock').style.gap='10px';$('#g_unlock').style.alignItems='center';}
    updateQInfo(s);
  });
  $('#g_unlock_btn').onclick=async()=>{
    await fetch('/api/clear-job',{method:'POST'});
    $('#g_go').disabled=false;$('#g_unlock').style.display='none';updateQInfo({queued:0});
    toast('Lock cleared — you can generate again.');
  };
  $('#g_qclear').onclick=async()=>{
    const r=await fetch('/api/genqueue/clear',{method:'POST'});
    const d=await r.json().catch(()=>({}));
    updateQInfo({queued:0});
    toast('Cleared '+(d.dropped||0)+' queued batch(es). The running batch continues.');
  };
  $('#g_go').onclick=async()=>{
   try{
    saveGenSettings();
    const posterType=(showEyeglasses||showAdvice)?curPosterType():'main';
    const isEyePoster = posterType === 'eyeglasses';
    const isShopPoster = posterType === 'shop';
    const isBrandPoster = posterType === 'brandphoto';
    const isAdvicePoster = posterType === 'advice' || posterType === 'tweet';
    // Studio Builder: collect varieties (name + files) from the DOM rows.
    let shopPlanObj=null,shopVarFiles=[];
    if(isShopPoster){
      const rows=Array.from(document.querySelectorAll('#shv_list .shv_row'));
      const varieties=[];
      rows.forEach(r=>{
        const name=((r.querySelector('.shv_name')||{}).value||'').trim();
        const files=Array.from(((r.querySelector('.shv_files')||{}).files)||[]).slice(0,6);
        if(name&&files.length){varieties.push({name:name,field:'variantPhotos_'+varieties.length});shopVarFiles.push(files);}
      });
      if(!varieties.length) return toast('Add at least one variety with a name and photos',true);
      const total=shmTotal();
      if(total<1&&!shmQty.specs) return toast('Pick at least one shot in the shot menu',true);
      if(total>12) return toast('That is '+total+' AI shots \\u2014 max 12 per batch. Reduce quantities or varieties.',true);
      shopPlanObj={varieties:varieties,shots:{hero:shmQty.hero,simple:shmQty.simple,model:shmQty.model,closeup:shmQty.closeup,feature:shmQty.feature,group:shmQty.group,specs:shmQty.specs},identicalSets:!!(($('#shv_identical')||{}).checked),modelNote:(($('#shop_modelnote')||{}).value||'').trim()};
    }
    // Topic required only for quote posters; optional for eyeglasses/advice; n/a for shop.
    const topic = isEyePoster
      ? ($('#ea_headline')&&$('#ea_headline').value.trim() || '')
      : ((isShopPoster||isBrandPoster) ? '' : $('#g_topic').value.trim());
    if(!isEyePoster && !isShopPoster && !isBrandPoster && !isAdvicePoster && !topic) return toast('Enter a topic first',true);
    const fd=new FormData();
    fd.append('client',CLIENT);
    fd.append('topic',topic);
    fd.append('count',String(+$('#g_count').value||8));
    fd.append('briefId',$('#g_brief').value);
    fd.append('brandPresetId',$('#g_brand').value);
    fd.append('posterType',posterType);
    if(posterType==='advice'||posterType==='tweet'){
      fd.append('adviceSeries',($('#advice_series')||{}).value||'');
      fd.append('adviceTheme',(($('#advice_theme')||{}).value)||'dark');
      const av=$('#advice_avatar')&&$('#advice_avatar').files&&$('#advice_avatar').files[0];
      if(av)fd.append('adviceAvatar',av);
      fd.append('characterId','');
    }else if(posterType==='shop'){
      shopVarFiles.forEach((files,i)=>files.forEach(f=>fd.append('variantPhotos_'+i,f)));
      fd.append('shopPlan',JSON.stringify(shopPlanObj));
      const specs=Array.from(document.querySelectorAll('input[name="shop_spec"]:checked')).map(c=>c.value);
      fd.append('shopSpecs',JSON.stringify(specs));
      fd.append('shopProduct',($('#shop_product')||{}).value||'');
      fd.append('shopMaterial',($('#shop_material')||{}).value||'');
      fd.append('shopAspect',($('#shop_aspect')||{}).value||'1:1');
      fd.append('characterId','');
    }else if(posterType==='brandphoto'){
      const textMode=(document.querySelector('input[name="bc_text"]:checked')||{}).value||'own';
      const sharedSettings={showLogo:!!(($('#bc_logo')||{}).checked),layout:(window._bcLayout?window._bcLayout():'minimal'),aspect:($('#bc_aspect')||{}).value||'4:5'};
      const sharedTreatRadio=(document.querySelector('input[name="bc_treat"]:checked')||{}).value||'original';
      // 2+ reference photos only benefit the AI re-shoot (it can cross-check
      // angles); original/cleanup only ever look at one photo, so force it —
      // per-item in batch mode, since each frame's photo count differs.
      const treatFor=n=>n>1?'reshoot':sharedTreatRadio;
      if((($('#bc_batch_toggle')||{}).checked)){
        const rows=Array.from(document.querySelectorAll('#bcb_list .bcb_row'));
        const items=[];
        for(const row of rows){
          const files=Array.from(((row.querySelector('.bcb_files')||{}).files)||[]).slice(0,6);
          const tag=((row.querySelector('.bcb_tagline')||{}).value||'').trim();
          if(!files.length)continue;
          if(textMode==='own'&&!tag)continue;
          items.push({photos:files,plan:Object.assign({treatment:treatFor(files.length),textMode:textMode,tagline:tag,productName:((row.querySelector('.bcb_product')||{}).value||'').trim()},sharedSettings)});
        }
        if(!items.length) return toast('Add at least one frame with a photo'+(textMode==='own'?' and a tagline':'')+' to the batch',true);
        $('#g_go').disabled=true;
        for(const it of items){await submitBrandCard(it.photos,it.plan);}
        $('#g_go').disabled=false;
        bcLastSubmit={items:items};
        const rb=$('#bc_retry_btn');if(rb)rb.style.display='inline-flex';
        toast('Queued '+items.length+' brand card'+(items.length===1?'':'s')+' for generation.');
        return;
      }
      const bfs=Array.from((($('#bc_photo')||{}).files)||[]).slice(0,6);
      if(!bfs.length) return toast('Upload a photo first',true);
      const tagline=($('#bc_tagline')||{}).value||'';
      if(textMode==='own'&&!tagline.trim()) return toast('Write a tagline, or switch to Let AI suggest',true);
      const treatment=treatFor(bfs.length);
      bfs.forEach(f=>fd.append('brandPhoto',f));
      const bcPlanObj=Object.assign({treatment:treatment,textMode:textMode,tagline:tagline,productName:($('#bc_product')||{}).value||''},sharedSettings);
      fd.append('brandPlan',JSON.stringify(bcPlanObj));
      fd.append('characterId','');
      bcLastSubmit={items:[{photos:bfs,plan:bcPlanObj}]};
    }else if(posterType==='eyeglasses'){
      const promoVal=$('#ea_promo')?$('#ea_promo').value.trim():'';
      if(promoVal)fd.append('promo',promoVal);
      fd.append('eyeglassesId',$('#g_subject')?$('#g_subject').value:'');
      const er=document.querySelector('input[name="g_estyle"]:checked');
      const eStyleVal=er?er.value:'showcase';
      fd.append('eyeglassesStyle',eStyleVal);
      if(eStyleVal==='showcase'){
        // nothing extra — preset image sent below as styleRef
      }else if(eStyleVal==='model'){
        const mr=document.querySelector('input[name="g_mstyle"]:checked');
        const mVal=mr?mr.value:'auto';
        // Pass 'auto' as the model style env var (text directives) only when no image preset
        fd.append('eyeglassesModelStyle', mVal);
      }
      fd.append('characterId','');
    }else{
      fd.append('characterId',$('#g_subject')?$('#g_subject').value:'');
    }
    fd.append('useLogo',$('#g_logo_on')&&$('#g_logo_on').checked?'1':'0');
    fd.append('includeCta',$('#g_cta_on')&&$('#g_cta_on').checked?'1':'0');
    fd.append('aiHeadline',$('#g_ai_head')&&$('#g_ai_head').checked?'1':'0');
    // Aspect-ratio mix → JSON like {"1:1":25,"4:5":50,"9:16":25}; only sent
    // when the user has actually checked at least one ratio with a % > 0.
    const arDist={};
    document.querySelectorAll('.ar-chk').forEach(chk=>{
      if(chk.checked){
        const pct=+chk.closest('.ar-card').querySelector('.ar-slider').value||0;
        if(pct>0)arDist[chk.dataset.ar]=pct;
      }
    });
    if(Object.keys(arDist).length)fd.append('aspectDist',JSON.stringify(arDist));
    const ef=$('#g_extras').files||[];
    for(const f of ef)fd.append('extraRef',f);
    // Style reference priority:
    // 1. Manual override upload (ea_skref_file for showcase, ea_msref_file for model)
    // 2. Selected poster preset (showcase only, if not "auto")
    // 3. Nothing — Let AI decide
    const skf=$('#ea_skref_file'), msf=$('#ea_msref_file');
    const manualRef=(skf&&skf.files&&skf.files[0])||(msf&&msf.files&&msf.files[0])||null;
    if(manualRef){
      fd.append('styleRef',manualRef);
      fd.append('stylePreset','custom');
    }else if(posterType==='eyeglasses'){
      // Fetch the selected poster template preset (showcase or model) as the style reference
      const eStyleVal2=(document.querySelector('input[name="g_estyle"]:checked')||{}).value||'showcase';
      let presetKey='auto';
      if(eStyleVal2==='showcase'){
        presetKey=(document.querySelector('input[name="g_psp"]:checked')||{}).value||'auto';
      }else if(eStyleVal2==='model'){
        presetKey=(document.querySelector('input[name="g_mstyle"]:checked')||{}).value||'auto';
      }
      if(presetKey&&presetKey!=='auto'){
        try{
          const r=await fetch('/poster-styles/'+presetKey+'.jpg');
          if(r.ok){const blob=await r.blob();fd.append('styleRef',blob,presetKey+'.jpg');fd.append('stylePreset',presetKey);}
        }catch(e){console.warn('Could not fetch poster preset:',e);}
      }
    }
    $('#g_go').disabled=true; // brief — re-enabled as soon as the server answers
    const r=await fetch('/api/generate',{method:'POST',body:fd});
    const d=await r.json().catch(()=>({}));
    $('#g_go').disabled=false;
    if(!r.ok){
      const err=d.error||'Failed to start';
      toast(err,true);
      return;
    }
    if(posterType==='brandphoto'&&bcLastSubmit){
      const rb=$('#bc_retry_btn');if(rb)rb.style.display='inline-flex';
    }
    if(d.queued){
      // A batch is already running — this one waits its turn. Don't touch the
      // running batch's log/progress; just surface the queue state. If the
      // page isn't following the running job (e.g. after a refresh), attach.
      toast('⏳ Added to generation queue — position '+d.position);
      updateQInfo({queued:d.position});
      if(!es)connectGenSSE(false);
      return;
    }
    // Started now — reset the job UI and attach a fresh SSE.
    phase='';
    $('#g_log').style.display='block';$('#g_log').textContent='';
    $('#g_prog').style.display='block';
    const gr=$('#g_result');if(gr){gr.style.display='none';gr.innerHTML='';}
    $('#g_bar').style.background='linear-gradient(90deg,var(--gold),#ffe27a)';setProg(2,false);
    connectGenSSE(true);
   }catch(err){
    if($('#g_go'))$('#g_go').disabled=false;
    console.error('generate failed:',err);
    toast('Could not start: '+((err&&err.message)||String(err)),true);
   }
  };
  // Regenerate — resubmits the last brand-card's exact photos + settings
  // without touching the current form (used by #bc_retry_btn).
  async function submitBrandCard(photos,planObj){
    const fd=new FormData();
    fd.append('client',CLIENT);
    fd.append('posterType','brandphoto');
    fd.append('characterId','');
    photos.forEach(f=>fd.append('brandPhoto',f));
    fd.append('brandPlan',JSON.stringify(planObj));
    try{
      const r=await fetch('/api/generate',{method:'POST',body:fd});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){toast(d.error||'Failed to start',true);return;}
      if(d.queued){
        toast('⏳ Added to generation queue — position '+d.position);
        updateQInfo({queued:d.position});
        if(!es)connectGenSSE(false);
        return;
      }
      phase='';
      $('#g_log').style.display='block';$('#g_log').textContent='';
      $('#g_prog').style.display='block';
      const gr=$('#g_result');if(gr){gr.style.display='none';gr.innerHTML='';}
      $('#g_bar').style.background='linear-gradient(90deg,var(--gold),#ffe27a)';setProg(2,false);
      connectGenSSE(true);
      toast('🔁 Regenerating brand card…');
    }catch(err){
      toast('Could not start: '+((err&&err.message)||String(err)),true);
    }
  }
  // SSE wiring for the generation log. fresh=true closes any previous stream
  // first (new job, clean log); fresh=false attaches to a stream already in
  // progress (queued submit after a page refresh).
  function connectGenSSE(fresh){
    if(fresh){es&&es.close();es=null;}
    if(es)return;
    $('#g_log').style.display='block';$('#g_prog').style.display='block';
    es=new EventSource('/api/log');
    let _sseErrCount=0;
    es.onerror=()=>{
      _sseErrCount++;
      if(_sseErrCount>=3){
        api('/api/status').then(s=>{if(s&&!s.running&&!(s.queued>0)){es&&es.close();es=null;$('#g_unlock').style.display='none';updateQInfo(s);}});
      }
    };
    es.onmessage=async ev=>{_sseErrCount=0;const line=JSON.parse(ev.data),L=$('#g_log');
      L.textContent+=line+'\\n';L.scrollTop=L.scrollHeight;
      if(line.indexOf('⏳ Queued:')>-1||line.indexOf('Cleared ')>-1){api('/api/status').then(updateQInfo);return;}
      if(line.indexOf('▶ Starting queued batch')>-1){
        // Next batch begins — reset progress for it, keep streaming.
        phase='';setProg(2,false);
        $('#g_bar').style.background='linear-gradient(90deg,var(--gold),#ffe27a)';
        api('/api/status').then(updateQInfo);
        return;
      }
      if(line.indexOf('✗ Exited')>-1||line.indexOf('⚠ Job timed out')>-1){
        setProg(100,true);
        const s=await api('/api/status').catch(()=>null);
        updateQInfo(s);
        if(s&&(s.running||s.queued>0)){toast('Batch failed ✗ — continuing with the queued batch',true);return;}
        es&&es.close();es=null;$('#g_unlock').style.display='none';return;
      }
      const p=progFrom(line);if(p>=0)setProg(p,false);
      if(line.indexOf('✓ Done')>-1){
        const bad=line.indexOf('no PNGs found')>-1;
        const s=await api('/api/status').catch(()=>null);
        updateQInfo(s);
        if(s&&(s.running||s.queued>0)){
          // More batches behind this one — stay on the stream, no tab switch.
          toast(bad?'⚠ Done but no posters found — next batch starting':'Batch complete \\u2713 — next queued batch starting…',bad);
          if(!bad)showLatestBatch();
          return;
        }
        es&&es.close();es=null;$('#g_unlock').style.display='none';
        toast(bad?'⚠ Done but no posters found — check log':'Batch complete \\u2713 — check Queue tab',bad);
        if(!bad){showLatestBatch();setTimeout(()=>{TAB='queue';render();},2500);}}};
  }
}
async function showLatestBatch(){
  const wrap=$('#g_result');if(!wrap)return;
  try{
    const batches=await api('/api/batches?client='+CLIENT);
    const B=batches[0];if(!B||!B.files.length){return;}
    const esc=s=>(s||'').replace(/[<>]/g,'');
    const caps=B.captions.split(/^#\\d+\\s*$/m).map(s=>s.trim()).filter(Boolean);
    const lbItems=B.files.slice(0,12).map((f,i)=>({
      url:'/posters/'+CLIENT+'/'+encodeURIComponent(B.stamp)+'/'+encodeURIComponent(f),
      caption:caps[i]||''
    }));
    window._lbItems=lbItems;
    const posters=lbItems.map((it,i)=>{
      return '<figure style="margin:0;background:#0d0d0f;border:1px solid rgba(255,255,255,.07);border-radius:12px;overflow:hidden;position:relative;cursor:zoom-in" onclick="openLb('+i+')">'
        +'<img src="'+it.url+'" style="width:100%;height:auto;display:block" loading="lazy">'
        +'<a href="'+it.url+'?dl=1" download onclick="event.stopPropagation()" style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;font-weight:600;padding:5px 10px;border-radius:6px;text-decoration:none;backdrop-filter:blur(4px)">↓</a>'
        +'</figure>';
    }).join('');
    const more=B.files.length>12?'<p style="color:var(--mut);font-size:12px;margin:4px 0 0">+ '+(B.files.length-12)+' more in Batches</p>':'';
    wrap.style.display='block';
    wrap.innerHTML=
      '<div style="border-top:1px solid rgba(255,255,255,.07);padding-top:20px">'
      +'<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:16px">'
      +'<div><div style="font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--mut);margin-bottom:3px">Latest batch</div>'
      +'<div style="font-size:15px;font-weight:600;color:var(--txt)">'+fmtStamp(B.stamp)+'</div>'
      +'<div style="font-size:12px;color:var(--mut);margin-top:2px">'+B.files.length+' poster'+(B.files.length===1?'':'s')+'</div></div>'
      +'<div style="display:flex;gap:10px;flex-wrap:wrap">'
      +'<a class="sec" style="text-decoration:none" href="/api/batch-zip?client='+CLIENT+'&stamp='+encodeURIComponent(B.stamp)+'">⬇ Download all (.zip)</a>'
      +'<button class="go" onclick="goBatches()" style="padding:10px 18px;font-size:13px">View all batches →</button>'
      +'</div></div>'
      +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px">'+posters+'</div>'
      +more+'</div>';
  }catch(e){/* silently skip if batches can't be fetched */}
}
async function viewBrand(){
  const b=await api('/api/brand?client='+CLIENT);
  $('#view').innerHTML='<div class="card"><h2>Brand Kits — '+CLIENT+'</h2>'
   +(b.length?b.map((p,i)=>{
     const logo=p.logoSrc
       ?'<img class="thumb" loading="lazy" style="object-fit:contain;background:#000" src="/api/brandlogo?p='+encodeURIComponent(p.logoSrc)+'">'
       :'<div class="thumb ph">no logo</div>';
     const sw=(c)=>'<span style="background:'+(c||'#000')+'" title="'+(c||'')+'"></span>';
     const detail='<div class="muted" style="font-size:12px;line-height:2">'
       +'<b>ID:</b> '+p.id+'<br>'
       +'<b>Accent (gold):</b> '+(p.brandAccent||'—')+' &nbsp;·&nbsp; <b>Accent deep:</b> '+(p.brandAccentDeep||'—')+' &nbsp;·&nbsp; <b>Primary (red):</b> '+(p.brandPrimary||'—')+'<br>'
       +'<b>CTA:</b> "'+(p.ctaComment||'—')+'" → '+(p.ctaTail||'—')+'<br>'
       +'<b>Logo position:</b> '+(p.logoPosition?p.logoPosition.replace("-"," "):'—')+' &nbsp;·&nbsp; <b>Logo size:</b> '+(typeof p.logoSize==="number"?Math.round(p.logoSize*100)+'% of poster height':'—')
       +(p.logoSrc?'<br><b>Logo file:</b> '+p.logoSrc:'')
       +'</div>';
     return '<div class="item asset-row" data-idx="'+i+'" style="cursor:pointer;flex-direction:column;align-items:stretch;gap:0">'
       +'<div style="display:flex;gap:14px;align-items:center">'
       +logo
       +'<div style="flex:1;min-width:0">'
       +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b>'+p.name+'</b>'
       +'<span class="pill">'+p.id+'</span>'
       +'<span class="muted asset-hint" style="font-size:11px">tap to expand ▾</span></div>'
       +'<div class="swatchrow">'+sw(p.brandAccent)+sw(p.brandAccentDeep)+sw(p.brandPrimary)+'</div>'
       +'<div class="muted" style="margin-top:5px">CTA "'+(p.ctaComment||'')+'" → '+(p.ctaTail||'')
       +(p.logoPosition?' · logo '+p.logoPosition.replace("-"," "):'')
       +(typeof p.logoSize==="number"?' · '+Math.round(p.logoSize*100)+"%":'')
       +'</div></div>'
       +'<button class="sec asset-del" data-idx="'+i+'" style="color:var(--red);border-color:rgba(224,86,75,.35);flex-shrink:0" title="Delete this brand kit">Delete</button>'
       +'</div>'
       +'<div class="asset-detail" data-idx="'+i+'" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">'+detail+'</div>'
       +'</div>';
   }).join('')
   :'<p class="muted" style="text-align:center;padding:24px 0">No brand kits yet — create one below.</p>')
   +'<h2 style="margin-top:18px">Create / update a brand kit</h2>'
   +'<div class="row"><div><label>ID</label><input id="b_id" placeholder="preset_'+CLIENT+'_2"></div>'
   +'<div><label>Name</label><input id="b_name"></div></div>'
   +'<div class="row">'
   +'<div><label>Gold (accent)</label>'
   +'<div style="display:flex;gap:8px;align-items:center"><input type="color" id="b_gold_c" value="#F5C13B" style="width:42px;height:38px;padding:2px;cursor:pointer">'
   +'<input id="b_gold" value="#F5C13B" placeholder="#F5C13B" style="flex:1"></div></div>'
   +'<div><label>Gold deep</label>'
   +'<div style="display:flex;gap:8px;align-items:center"><input type="color" id="b_goldd_c" value="#C7902A" style="width:42px;height:38px;padding:2px;cursor:pointer">'
   +'<input id="b_goldd" value="#C7902A" placeholder="#C7902A" style="flex:1"></div></div>'
   +'<div><label>Red</label>'
   +'<div style="display:flex;gap:8px;align-items:center"><input type="color" id="b_red_c" value="#E11522" style="width:42px;height:38px;padding:2px;cursor:pointer">'
   +'<input id="b_red" value="#E11522" placeholder="#E11522" style="flex:1"></div></div>'
   +'</div>'
   +'<div class="row"><div><label>CTA comment word</label><input id="b_cta" value="MENTOR"></div>'
   +'<div><label>CTA tail</label><input id="b_tail" value="LEARN MORE"></div></div>'
   +'<label>Logo (optional)</label><input id="b_logo" type="file" accept="image/*">'
   +'<div class="row" style="margin-top:10px">'
   +'<div><label>Logo position</label><select id="b_lpos">'
   +'<option value="top-left">Top left</option>'
   +'<option value="top-center" selected>Top center</option>'
   +'<option value="top-right">Top right</option>'
   +'<option value="bottom-left">Bottom left</option>'
   +'<option value="bottom-center">Bottom center</option>'
   +'<option value="bottom-right">Bottom right</option>'
   +'</select></div>'
   +'<div><label>Logo size — <span id="b_lsizeval">10</span>% of poster height</label>'
   +'<input type="range" id="b_lsize" min="6" max="22" step="1" value="10" style="width:100%"></div>'
   +'</div>'
   +'<p style="margin-top:14px"><button class="go" id="b_save">Save brand kit</button></p></div>';
  // Wire up click-to-expand detail panels and delete buttons on each row.
  $('#view').querySelectorAll('.asset-row').forEach((row)=>{
    const item=b[Number(row.dataset.idx)];
    if(!item)return;
    row.onclick=(e)=>{
      if(e.target.closest('.asset-del'))return;
      const d=row.querySelector('.asset-detail');
      const hint=row.querySelector('.asset-hint');
      if(!d)return;
      const open=d.style.display!=='none';
      d.style.display=open?'none':'block';
      if(hint)hint.textContent=open?'tap to expand ▾':'tap to collapse ▴';
    };
    const del=row.querySelector('.asset-del');
    if(del)del.onclick=async(e)=>{
      e.stopPropagation();
      if(!confirm('Delete brand kit "'+(item.name||item.id)+'"? This cannot be undone.'))return;
      const r=await fetch('/api/brand/'+encodeURIComponent(item.id)+'?client='+CLIENT,{method:'DELETE'});
      if(r&&r.ok){toast('Brand kit deleted');viewBrand();}
      else toast('Could not delete brand kit',true);
    };
  });
  // Keep each color picker in sync with its hex text input (two-way).
  [['b_gold','b_gold_c'],['b_goldd','b_goldd_c'],['b_red','b_red_c']].forEach(([hexId,pickId])=>{
    const h=$('#'+hexId),p=$('#'+pickId);
    h.oninput=()=>{if(/^#[0-9a-fA-F]{6}$/.test(h.value))p.value=h.value;};
    p.oninput=()=>{h.value=p.value;};
  });
  // Live numeric label for the logo size slider.
  $('#b_lsize').oninput=()=>{$('#b_lsizeval').textContent=$('#b_lsize').value;};
  $('#b_save').onclick=async()=>{
    let logoSrc='';const f=$('#b_logo').files[0];
    if(f){const fd=new FormData();fd.append('logo',f);
      const u=await api('/api/brand/logo',{method:'POST',body:fd});logoSrc=u.path||'';}
    const p={id:$('#b_id').value.trim(),client:CLIENT,name:$('#b_name').value.trim()||$('#b_id').value,
      brandAccent:$('#b_gold').value,brandAccentDeep:$('#b_goldd').value,brandPrimary:$('#b_red').value,
      brandDeep:'#0A0A0A',ctaComment:$('#b_cta').value.toUpperCase(),ctaTail:$('#b_tail').value.toUpperCase(),
      logoPosition:$('#b_lpos').value,
      logoSize:Number($('#b_lsize').value)/100};
    if(logoSrc)p.logoSrc=logoSrc;
    if(!p.id)return toast('Brand kit ID required',true);
    await fetch('/api/brand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
    toast('Brand kit saved');viewBrand();
  };
}
async function viewTopics(){
  const b=await api('/api/briefs?client='+CLIENT);
  $('#view').innerHTML='<div class="card"><h2>Topic Presets — '+CLIENT+'</h2>'
   +b.map(x=>'<div class="item"><b>'+x.name+'</b> <span class="pill">'+x.id+'</span><br>'
   +'<span class="muted">'+(x.topics||[]).join(' · ')+'</span></div>').join('')
   +'<h2 style="margin-top:18px">Create / update a topic preset</h2>'
   +'<div class="row"><div><label>ID</label><input id="t_id" placeholder="brief_'+CLIENT+'_2"></div>'
   +'<div><label>Name</label><input id="t_name"></div></div>'
   +'<label>Topics (one per line)</label><textarea id="t_topics"></textarea>'
   +'<label>Voice notes</label><textarea id="t_voice"></textarea>'
   +'<p style="margin-top:14px"><button class="go" id="t_save">Save topic preset</button></p></div>';
  $('#t_save').onclick=async()=>{
    const body={id:$('#t_id').value.trim(),client:CLIENT,name:$('#t_name').value.trim()||$('#t_id').value,
      topics:$('#t_topics').value,voiceNotes:$('#t_voice').value,bannedPhrases:[]};
    if(!body.id)return toast('Topic preset ID required',true);
    await fetch('/api/briefs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    toast('Topic preset saved');viewTopics();
  };
}
async function viewChars(){
  const c=await api('/api/characters?client='+CLIENT);
  $('#view').innerHTML='<div class="card"><h2>Characters — '+CLIENT+'</h2>'
   +(c.length?c.map((x,i)=>{
     const photos=x.photos||[];
     const first=photos[0];
     const thumb=first
       ?'<img class="thumb" loading="lazy" src="/api/charphoto?p='+encodeURIComponent(first)+'">'
       :'<div class="thumb ph">no photo</div>';
     const gallery=photos.length
       ?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'
         +photos.map((ph)=>'<img class="thumb" loading="lazy" style="width:84px;height:84px" src="/api/charphoto?p='+encodeURIComponent(ph)+'">').join('')
         +'</div>'
       :'';
     const detail='<div class="muted" style="font-size:12px;line-height:2">'
       +'<b>ID:</b> '+x.id+'<br>'
       +'<b>Status:</b> '+(x.enabled?'enabled':'disabled')+'<br>'
       +'<b>Photos:</b> '+photos.length
       +'</div>'+gallery;
     return '<div class="item asset-row" data-idx="'+i+'" style="cursor:pointer;flex-direction:column;align-items:stretch;gap:0">'
       +'<div style="display:flex;gap:14px;align-items:center">'
       +thumb
       +'<div style="flex:1;min-width:0">'
       +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b>'+x.name+'</b>'
       +'<span class="pill">'+x.id+'</span>'
       +'<span class="muted asset-hint" style="font-size:11px">tap to expand ▾</span></div>'
       +'<div class="muted" style="margin-top:5px">'+photos.length+' photo'
       +(photos.length===1?'':'s')+(x.enabled?'':' · disabled')+'</div>'
       +'</div>'
       +'<button class="sec asset-del" data-idx="'+i+'" style="color:var(--red);border-color:rgba(224,86,75,.35);flex-shrink:0" title="Delete this character">Delete</button>'
       +'</div>'
       +'<div class="asset-detail" data-idx="'+i+'" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">'+detail+'</div>'
       +'</div>';
   }).join('')
   :'<p class="muted" style="text-align:center;padding:24px 0">No character yet. Optional — Tranzzie can run scene-only.</p>')
   +'<h2 style="margin-top:18px">Create / update a character</h2>'
   +'<div class="row"><div><label>ID</label><input id="c_id" placeholder="char_'+CLIENT+'"></div>'
   +'<div><label>Name</label><input id="c_name"></div></div>'
   +'<label>Photos (optional — pick one or many to add)</label>'
   +'<input id="c_files" type="file" accept="image/*" multiple>'
   +'<p style="margin-top:14px"><button class="go" id="c_save">Save character</button></p></div>';
  $('#view').querySelectorAll('.asset-row').forEach((row)=>{
    const item=c[Number(row.dataset.idx)];
    if(!item)return;
    row.onclick=(e)=>{
      if(e.target.closest('.asset-del'))return;
      const d=row.querySelector('.asset-detail');
      const hint=row.querySelector('.asset-hint');
      if(!d)return;
      const open=d.style.display!=='none';
      d.style.display=open?'none':'block';
      if(hint)hint.textContent=open?'tap to expand ▾':'tap to collapse ▴';
    };
    const del=row.querySelector('.asset-del');
    if(del)del.onclick=async(e)=>{
      e.stopPropagation();
      if(!confirm('Delete character "'+(item.name||item.id)+'"? This cannot be undone.'))return;
      const r=await fetch('/api/characters/'+encodeURIComponent(item.id)+'?client='+CLIENT,{method:'DELETE'});
      if(r&&r.ok){toast('Character deleted');viewChars();}
      else toast('Could not delete character',true);
    };
  });
  $('#c_save').onclick=async()=>{
    const id=$('#c_id').value.trim();
    if(!id)return toast('Character ID required',true);
    const body={id,client:CLIENT,name:$('#c_name').value.trim()||id,enabled:true};
    await fetch('/api/characters',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)});
    const files=$('#c_files').files;
    if(files&&files.length){
      const fd=new FormData();for(const f of files)fd.append('photo',f);
      await fetch('/api/characters/photo?client='+CLIENT+'&charId='+encodeURIComponent(id),
        {method:'POST',body:fd});
    }
    toast('Character saved');viewChars();
  };
}
async function viewGlasses(){
  const g=await api('/api/eyeglasses?client='+CLIENT);
  const genCard='<div class="card" id="ea-card">'
   +'<h2>\\u2728 Generate a reference set from one photo</h2>'
   +'<p class="muted" style="margin:-4px 0 16px">Upload ONE clear shot of a frame — Gemini generates a ¾ angle and side-profile view of that <i>same</i> pair, compiles all three into a collage for you to review, and only saves them as a frame\\'s reference photos once you approve.</p>'
   +'<div id="ea-upload-wrap">'
   +'<label class="ea-drop" id="ea-drop">'
   +'<input type="file" id="ea-file" accept="image/*" style="position:absolute;inset:0;opacity:0;cursor:pointer">'
   +'<div style="font-size:30px;opacity:.5;margin-bottom:6px">\\ud83d\\udd76\\ufe0f</div>'
   +'<b>Click to upload or drag &amp; drop</b>'
   +'<div class="muted" style="font-size:12px;margin-top:3px">One clear product photo — JPG, PNG, HEIC. Plain background works best.</div>'
   +'</label>'
   +'</div>'
   +'<div id="ea-status" class="muted" style="font-size:13px;margin-top:12px;display:none"></div>'
   +'<div id="ea-results" style="margin-top:16px;display:none"></div>'
   +'</div>';
  $('#view').innerHTML=genCard
   +'<div class="card"><h2>\\ud83d\\udd76\\ufe0f Eyeglasses — '+CLIENT+'</h2>'
   +'<p class="muted" style="margin:-4px 0 16px">Frames used as the main subject for Tranzzie eyeglasses-showcase posters. Add reference photos so Gemini can render the actual product instead of a generic pair.</p>'
   +(g.length?g.map((x,i)=>{
     const photos=x.photos||[];
     const first=photos[0];
     const thumb=first
       ?'<img class="thumb" loading="lazy" src="/api/glassesphoto?p='+encodeURIComponent(first)+'">'
       :'<div class="thumb ph">no photo</div>';
     const photoGrid=photos.length
       ?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">'
         +photos.map((ph,pi)=>'<div style="position:relative;width:84px;height:84px;flex-shrink:0">'
           +'<img class="thumb" loading="lazy" style="width:84px;height:84px;object-fit:cover;border-radius:8px" src="/api/glassesphoto?p='+encodeURIComponent(ph)+'">'
           +'<button class="asset-rmphoto" data-gid="'+x.id+'" data-ph="'+encodeURIComponent(ph)+'" title="Remove this photo" style="position:absolute;top:2px;right:2px;padding:0;width:20px;height:20px;font-size:10px;line-height:1;border-radius:50%;background:rgba(0,0,0,.7);border:none;color:#fff;cursor:pointer">×</button>'
           +'</div>').join('')
         +'</div>'
       :'<p class="muted" style="font-size:12px;margin:0 0 10px">No photos yet — add some below.</p>';
     return '<div class="item asset-row" data-idx="'+i+'" style="flex-direction:column;align-items:stretch;gap:0">'
       +'<div style="display:flex;gap:14px;align-items:center;cursor:pointer">'
       +thumb
       +'<div style="flex:1;min-width:0">'
       +'<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><b>'+x.name+'</b>'
       +'<span class="pill">'+x.id+'</span>'
       +'<span class="muted asset-hint" style="font-size:11px">tap to expand ▾</span></div>'
       +'<div class="muted" style="margin-top:5px">'+photos.length+' photo'
       +(photos.length===1?'':'s')+(x.enabled?'':' · disabled')+'</div>'
       +'</div>'
       +'<div style="display:flex;gap:8px;flex-shrink:0">'
       +'<button class="sec asset-edit" data-idx="'+i+'" style="font-size:12px;padding:6px 12px">Edit</button>'
       +'<button class="sec asset-del" data-idx="'+i+'" style="color:var(--red);border-color:rgba(224,86,75,.35);font-size:12px;padding:6px 12px">Delete</button>'
       +'</div>'
       +'</div>'
       // Expand/collapse detail
       +'<div class="asset-detail" data-idx="'+i+'" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">'
       +'<div class="muted" style="font-size:12px;margin-bottom:10px"><b>ID:</b> '+x.id+' · <b>Status:</b> '+(x.enabled?'enabled':'disabled')+'</div>'
       +photoGrid
       +'</div>'
       // Edit panel (hidden by default)
       +'<div class="asset-editpanel" data-idx="'+i+'" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);flex-direction:column;gap:12px">'
       +'<div class="row"><div><label style="font-size:12px">Name</label><input class="ep-name" value="'+x.name.replace(/"/g,'&quot;')+'" style="font-size:13px"></div>'
       +'<div><label style="font-size:12px">Notes</label><input class="ep-notes" value="'+(x.notes||'').replace(/"/g,'&quot;')+'" placeholder="optional" style="font-size:13px"></div></div>'
       +'<div><label style="font-size:12px">Add more photos</label><input class="ep-addfiles" type="file" accept="image/*" multiple></div>'
       +'<div style="display:flex;gap:10px">'
       +'<button class="go ep-save" data-idx="'+i+'" style="font-size:13px;padding:9px 18px">Save changes</button>'
       +'<button class="sec ep-cancel" data-idx="'+i+'" style="font-size:13px">Cancel</button>'
       +'</div></div>'
       +'</div>';
   }).join('')
   :'<p class="muted" style="text-align:center;padding:24px 0">No frames yet — add one below, then pick it on the Generate tab.</p>')
   +'<h2 style="margin-top:18px">Create / update a frame</h2>'
   +'<div class="row"><div><label>ID</label><input id="g_eid" placeholder="glasses_'+CLIENT+'"></div>'
   +'<div><label>Name</label><input id="g_ename" placeholder="e.g. Aviator Classic"></div></div>'
   +'<label>Reference photos (the actual product — multiple angles help)</label>'
   +'<input id="g_efiles" type="file" accept="image/*" multiple>'
   +'<p style="margin-top:14px"><button class="go" id="g_esave">Save frame</button></p></div>';
  $('#view').querySelectorAll('.asset-row').forEach((row)=>{
    const item=g[Number(row.dataset.idx)];
    if(!item)return;
    // Expand/collapse detail on header click
    const header=row.querySelector('.asset-row > div:first-child, [style*="cursor:pointer"]');
    row.querySelector('div[style*="cursor:pointer"]')?.addEventListener('click',(e)=>{
      if(e.target.closest('.asset-edit,.asset-del'))return;
      const d=row.querySelector('.asset-detail');
      const ep=row.querySelector('.asset-editpanel');
      const hint=row.querySelector('.asset-hint');
      if(!d)return;
      // Close edit panel if open
      if(ep&&ep.style.display!=='none'){ep.style.display='none';}
      const open=d.style.display!=='none';
      d.style.display=open?'none':'block';
      if(hint)hint.textContent=open?'tap to expand ▾':'tap to collapse ▴';
    });
    // Delete
    const del=row.querySelector('.asset-del');
    if(del)del.onclick=async(e)=>{
      e.stopPropagation();
      if(!confirm('Delete frame "'+(item.name||item.id)+'"? This cannot be undone.'))return;
      const r=await fetch('/api/eyeglasses/'+encodeURIComponent(item.id)+'?client='+CLIENT,{method:'DELETE'});
      if(r&&r.ok){toast('Frame deleted');viewGlasses();}
      else toast('Could not delete frame',true);
    };
    // Edit button — toggle edit panel
    const editBtn=row.querySelector('.asset-edit');
    const editPanel=row.querySelector('.asset-editpanel');
    const detailPanel=row.querySelector('.asset-detail');
    if(editBtn&&editPanel){
      editBtn.onclick=(e)=>{
        e.stopPropagation();
        const isOpen=editPanel.style.display!=='none';
        editPanel.style.display=isOpen?'none':'flex';
        if(detailPanel)detailPanel.style.display='none';
        editBtn.textContent=isOpen?'Edit':'Cancel edit';
        const hint=row.querySelector('.asset-hint');
        if(hint)hint.textContent='tap to expand ▾';
      };
    }
    // Remove individual photo
    row.querySelectorAll('.asset-rmphoto').forEach(btn=>{
      btn.onclick=async(e)=>{
        e.stopPropagation();
        if(!confirm('Remove this photo from the frame?'))return;
        const gid=btn.dataset.gid;
        const ph=decodeURIComponent(btn.dataset.ph);
        const r=await fetch('/api/eyeglasses/'+encodeURIComponent(gid)+'/photo?client='+CLIENT+'&photoPath='+encodeURIComponent(ph),{method:'DELETE'});
        if(r&&r.ok){toast('Photo removed');viewGlasses();}
        else toast('Could not remove photo',true);
      };
    });
    // Edit panel: save changes
    const saveBtn=row.querySelector('.ep-save');
    if(saveBtn)saveBtn.onclick=async(e)=>{
      e.stopPropagation();
      saveBtn.disabled=true;
      const name=row.querySelector('.ep-name')?.value.trim()||item.name;
      const notes=row.querySelector('.ep-notes')?.value.trim()||'';
      await fetch('/api/eyeglasses',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:item.id,client:CLIENT,name,notes,enabled:item.enabled})});
      const addFiles=row.querySelector('.ep-addfiles')?.files;
      if(addFiles&&addFiles.length){
        const fd=new FormData();for(const f of addFiles)fd.append('photo',f);
        await fetch('/api/eyeglasses/photo?client='+CLIENT+'&glassesId='+encodeURIComponent(item.id),{method:'POST',body:fd});
      }
      toast('Frame updated');viewGlasses();
    };
    // Edit panel: cancel
    const cancelBtn=row.querySelector('.ep-cancel');
    if(cancelBtn)cancelBtn.onclick=(e)=>{
      e.stopPropagation();
      if(editPanel)editPanel.style.display='none';
      if(editBtn)editBtn.textContent='Edit';
    };
  });
  $('#g_esave').onclick=async()=>{
    const id=$('#g_eid').value.trim();
    if(!id)return toast('Frame ID required',true);
    const body={id,client:CLIENT,name:$('#g_ename').value.trim()||id,enabled:true};
    await fetch('/api/eyeglasses',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)});
    const files=$('#g_efiles').files;
    if(files&&files.length){
      const fd=new FormData();for(const f of files)fd.append('photo',f);
      await fetch('/api/eyeglasses/photo?client='+CLIENT+'&glassesId='+encodeURIComponent(id),
        {method:'POST',body:fd});
    }
    toast('Frame saved');viewGlasses();
  };

  // ── Generate-a-reference-set widget ───────────────────────────────────────
  (function initAngleGenerator(){
    const drop=$('#ea-drop'), fileInput=$('#ea-file'), statusEl=$('#ea-status'), resultsEl=$('#ea-results');
    let token=null, description='', mime=null, lastSet=null; // lastSet = {original,angles} for regenerate/approve
    const setStatus=(html)=>{ if(!statusEl)return; statusEl.innerHTML=html||''; statusEl.style.display=html?'block':'none'; };
    const dataUrlToBlob=async(u)=>(await fetch(u)).blob();

    function compositeCollage(items){
      // items: [{label,dataUrl}, ...] → single side-by-side strip data URL.
      // Guards against a load that never fires onload/onerror (shouldn't
      // happen with data: URLs, but a frozen "Compiling collage…" is the
      // worst possible failure mode, so we cap it with a timeout too).
      return new Promise((resolve,reject)=>{
        const imgs=items.map(it=>{const i=new Image();i.src=it.dataUrl;return i;});
        let done=false;
        const settledTimer=setTimeout(()=>{
          if(done)return; done=true;
          reject(new Error('Image load timed out — the browser could not decode one of the generated images.'));
        },20000);
        let loaded=0, failed=false;
        const finish=(fn)=>{ if(done)return; done=true; clearTimeout(settledTimer); fn(); };
        imgs.forEach((img,idx)=>{
          img.onerror=()=>{
            if(failed)return; failed=true;
            finish(()=>reject(new Error('Could not display "'+(items[idx].label||'an image')+'" — the format may be unsupported by this browser.')));
          };
          img.onload=()=>{
            if(failed||done)return;
            if(++loaded<imgs.length)return;
            finish(()=>{
              const W=imgs[0].width||600, H=imgs[0].height||600, N=imgs.length;
              const c=document.createElement('canvas'); c.width=W*N; c.height=H;
              const ctx=c.getContext('2d');
              imgs.forEach((im,i2)=>{
                ctx.drawImage(im,i2*W,0,W,H);
                if(i2>0){ctx.strokeStyle='rgba(255,255,255,0.5)';ctx.lineWidth=2;
                  ctx.beginPath();ctx.moveTo(i2*W,0);ctx.lineTo(i2*W,H);ctx.stroke();}
                const lh=Math.round(H*0.07);
                ctx.fillStyle='rgba(0,0,0,0.62)';ctx.fillRect(i2*W,H-lh,W,lh);
                const fs=Math.round(lh*0.42);
                ctx.fillStyle='#F4B400';ctx.textAlign='center';ctx.font='600 '+fs+'px system-ui,sans-serif';
                ctx.fillText(items[i2].label||'',i2*W+W/2,H-Math.round(lh*0.3));
              });
              resolve(c.toDataURL('image/png'));
            });
          };
        });
      });
    }

    function renderReview(set){
      lastSet=set;
      const items=[set.original,...set.angles];
      resultsEl.style.display='block';
      resultsEl.innerHTML='<div class="muted" style="font-size:12px;margin-bottom:10px">Compiling collage…</div>';
      compositeCollage(items).then((collageUrl)=>{
        resultsEl.innerHTML=
          '<div style="border:1px solid var(--line2,rgba(255,255,255,.14));border-radius:10px;overflow:hidden;margin-bottom:14px">'
          +'<img src="'+collageUrl+'" style="width:100%;display:block">'
          +'</div>'
          +'<p class="muted" style="font-size:12px;margin:-6px 0 14px">Review the set above — does the ¾ and side view still look like the <i>same</i> pair? If anything drifted, hit Regenerate.</p>'
          +'<div class="row"><div><label>Frame ID</label><input id="ea_id" placeholder="glasses_'+CLIENT+'"></div>'
          +'<div><label>Frame name</label><input id="ea_name" placeholder="e.g. Aviator Classic"></div></div>'
          +'<p class="muted" style="font-size:11.5px;margin:4px 0 14px">If the ID matches an existing frame, these photos are <i>added</i> to it. Otherwise a new frame is created.</p>'
          +'<p style="display:flex;gap:10px;flex-wrap:wrap">'
          +'<button class="go" id="ea_approve">\\u2713 Approve &amp; save as frame</button>'
          +'<button class="sec" id="ea_regen">\\u21bb Regenerate</button>'
          +'<button class="sec" id="ea_cancel" style="color:var(--red);border-color:rgba(224,86,75,.35)">Cancel</button>'
          +'</p>';
        $('#ea_regen').onclick=()=>doGenerate(true);
        $('#ea_cancel').onclick=()=>{
          lastSet=null; token=null; description=''; mime=null;
          resultsEl.style.display='none'; resultsEl.innerHTML='';
          setStatus(''); fileInput.value='';
          toast('Discarded');
        };
        $('#ea_approve').onclick=async()=>{
          const id=$('#ea_id').value.trim();
          if(!id)return toast('Frame ID required',true);
          const name=$('#ea_name').value.trim()||id;
          const btn=$('#ea_approve'); btn.disabled=true; btn.textContent='Saving…';
          try{
            await fetch('/api/eyeglasses',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({id,client:CLIENT,name,enabled:true})});
            const fd=new FormData();
            let n=0;
            for(const it of items){
              const blob=await dataUrlToBlob(it.dataUrl);
              fd.append('photo',blob,'angle-'+(n++)+'-'+(it.label||'shot').toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.png');
            }
            const r=await fetch('/api/eyeglasses/photo?client='+CLIENT+'&glassesId='+encodeURIComponent(id),
              {method:'POST',body:fd});
            if(!r.ok)throw new Error('upload failed');
            toast('Reference set saved to "'+name+'"');
            lastSet=null; token=null; description=''; mime=null;
            resultsEl.style.display='none'; resultsEl.innerHTML='';
            setStatus(''); fileInput.value='';
            viewGlasses();
          }catch(e){
            toast('Could not save the set — try again',true);
            btn.disabled=false; btn.textContent='\\u2713 Approve & save as frame';
          }
        };
      }).catch((err)=>{
        lastSet=null;
        resultsEl.innerHTML='<p style="color:var(--red);font-size:13px;margin:0 0 12px">'
          +'\\u26a0\\ufe0f '+(err && err.message ? err.message : 'Could not compile the review collage.')+'</p>'
          +'<p style="display:flex;gap:10px;flex-wrap:wrap">'
          +'<button class="sec" id="ea_retry">\\u21bb Try again</button>'
          +'<button class="sec" id="ea_cancel2" style="color:var(--red);border-color:rgba(224,86,75,.35)">Cancel</button>'
          +'</p>';
        $('#ea_retry').onclick=()=>doGenerate(true);
        $('#ea_cancel2').onclick=()=>{
          token=null; description=''; mime=null; lastSet=null;
          resultsEl.style.display='none'; resultsEl.innerHTML='';
          setStatus(''); fileInput.value='';
          toast('Discarded');
        };
      });
    }

    async function doGenerate(isRegen){
      if(!token)return;
      resultsEl.style.display='none'; resultsEl.innerHTML='';
      setStatus('<span class="spinner" style="display:inline-block;width:13px;height:13px;border:2px solid rgba(244,180,0,.3);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:7px"></span>'
        +(isRegen?'Regenerating angle views…':'Generating ¾ and side-profile views of your frame…')+' this takes ~30-60s.');
      try{
        const r=await fetch('/api/eyeglasses/angles/generate',{method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({token,description})});
        const d=await r.json();
        if(!r.ok||d.error){setStatus('');toast(d.error||'Generation failed',true);return;}
        setStatus('');
        renderReview(d);
      }catch(e){ setStatus(''); toast('Network error — try again',true); }
    }

    async function handleFile(file){
      if(!file)return;
      token=null; description=''; mime=null; lastSet=null;
      resultsEl.style.display='none'; resultsEl.innerHTML='';
      setStatus('<span class="spinner" style="display:inline-block;width:13px;height:13px;border:2px solid rgba(244,180,0,.3);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:7px"></span> Checking photo…');
      const fd=new FormData(); fd.append('photo',file);
      try{
        const r=await fetch('/api/eyeglasses/angles/validate',{method:'POST',body:fd});
        const d=await r.json();
        if(!r.ok||d.error){setStatus('');toast(d.error||'Could not analyze photo',true);return;}
        if(!d.valid){setStatus('');toast(d.reason||'Please upload a clearer shot of the frame.',true);return;}
        token=d.token; description=d.description||''; mime=d.mime;
        setStatus('<b style="color:var(--gold)">\\u2713 '+(description||'Clear frame detected')+'</b><br><span style="font-size:12px">Generating angle views now…</span>');
        doGenerate(false);
      }catch(e){ setStatus(''); toast('Network error — try again',true); }
    }

    fileInput.onchange=(e)=>handleFile(e.target.files[0]);
    drop.addEventListener('dragover',(e)=>{e.preventDefault();drop.classList.add('over');});
    drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
    drop.addEventListener('drop',(e)=>{
      e.preventDefault(); drop.classList.remove('over');
      const f=e.dataTransfer.files&&e.dataTransfer.files[0];
      if(f&&/^image\\//.test(f.type))handleFile(f);
    });
  })();
}
async function viewQueue(){
  const esc=s=>(s||'').replace(/[<>&"]/g,'');
  let queue=await api('/api/queue?client='+CLIENT);
  // Local state for unsaved decisions before sending.
  const local={}; // queueId → { filename → status }
  function getStatus(qid,fname){return local[qid]?.[fname]||queue.find(e=>e.id===qid)?.posters.find(p=>p.filename===fname)?.status||'pending';}
  function setStatus(qid,fname,status){if(!local[qid])local[qid]={};local[qid][fname]=status;renderQueue();}

  function renderQueue(){
    const pending=queue.filter(e=>!e.sentAt);
    const sent=queue.filter(e=>e.sentAt);
    const totalPending=pending.reduce((a,e)=>a+e.posters.filter(p=>(local[e.id]?.[p.filename]||p.status)==='pending').length,0);
    const totalApproved=pending.reduce((a,e)=>a+e.posters.filter(p=>(local[e.id]?.[p.filename]||p.status)==='approved').length,0);
    // Workflow strip — step 2 is active here
    let html='<div class="workflow-strip">'
      +'<div class="wf-step"><div class="wf-num">1</div><div><div class="wf-label">Generate</div><div class="wf-sub">Already done</div></div></div>'
      +'<div class="wf-step wf-active"><div class="wf-num">2</div><div><div class="wf-label">Review in Queue</div><div class="wf-sub">Approve or decline each poster</div></div></div>'
      +'<div class="wf-step"><div class="wf-num">3</div><div><div class="wf-label">Schedule to Buffer</div><div class="wf-sub">Set dates → posts automatically</div></div></div>'
      +'</div>';
    html+='<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px">'
      +'<div>'
      +(pending.length?'<div style="font-size:22px;font-weight:700;color:var(--txt);margin-bottom:3px">'+pending.reduce((a,e)=>a+e.posters.length,0)+' posters waiting</div>'
        +'<div class="muted" style="font-size:13px">'+(totalApproved?'<span style="color:var(--gold)">✓ '+totalApproved+' approved</span> · ':'')+(totalPending?totalPending+' still need review':'all reviewed')+'</div>'
        :'<div style="font-size:15px;font-weight:600;color:var(--txt)">Queue is empty</div>')
      +'</div>'
      +'<button class="sec" onclick="viewQueue()">↻ Refresh</button></div>';

    if(!pending.length&&!sent.length){
      html+='<div class="callout callout-info"><b>Nothing here yet.</b> Go to <b>⚡ Generate</b>, type a topic and hit Generate. Your posters will appear here automatically when done.</div>';
    }

    // Build ONE flat lightbox array across ALL queue entries (ordered newest-
    // first, same as the rendered cards). Each onclick uses a global index into
    // this array — not a per-entry pi — so clicking any card opens the correct
    // image regardless of how many entries are on screen.
    const allQItems=[];let qGlobal=0;
    for(const entry of pending){
      const qid=entry.id;
      const approvedCount=entry.posters.filter(p=>(local[qid]?.[p.filename]||p.status)==='approved').length;
      const totalCount=entry.posters.length;
      html+='<div class="card" id="q-'+qid+'">'
        +'<div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:18px">'
        +'<div><div style="font-size:15px;font-weight:600;color:var(--txt)">'+fmtStamp(entry.stamp)+'</div>'
        +'<div class="muted" style="font-size:12px;margin-top:3px">'+totalCount+' posters · <span id="qc-'+qid+'">'+approvedCount+' approved</span></div></div>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap">'
        +'<button class="sec" style="font-size:12px" onclick="qSelA(this)" data-qid="'+qid+'" data-s="approved">Approve All</button>'
        +'<button class="sec" style="font-size:12px" onclick="qSelA(this)" data-qid="'+qid+'" data-s="declined">Decline All</button>'
        +'<button class="sec" style="font-size:12px;color:var(--red);border-color:var(--red)" onclick="qDel(this)" data-qid="'+qid+'">Remove</button>'
        +'</div></div>'
        // Schedule bar — strategy + date + live preview
        +'<div style="background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:9px;padding:16px;margin-bottom:16px">'
        +'<div style="font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);margin-bottom:12px">Posting Schedule <span style="font-weight:400;letter-spacing:0;text-transform:none;color:var(--mut);font-size:11px">(Manila time · UTC+8)</span></div>'
        +'<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px">'
        +'<div style="flex:2;min-width:200px"><label style="font-size:11px;color:var(--mut);display:block;margin-bottom:5px">Strategy</label>'
        +'<select id="qs-strat-'+qid+'" onchange="qPrev(this)" data-qid="'+qid+'" style="width:100%;background:#0e0e10;border:1px solid var(--line2);color:var(--txt);border-radius:8px;padding:9px 12px;font:inherit;font-size:13px">'
        +'<option value="light">Light — 2 posts/day (9 AM, 7 PM)</option>'
        +'<option value="standard" selected>Standard — 3 posts/day (9 AM, 1 PM, 7 PM)</option>'
        +'<option value="active">Active — 5 posts/day (9 AM, 11 AM, 1 PM, 5 PM, 8 PM)</option>'
        +'</select></div>'
        +'<div><label style="font-size:11px;color:var(--mut);display:block;margin-bottom:5px">Start date</label>'
        +'<input type="date" id="qs-date-'+qid+'" onchange="qPrev(this)" data-qid="'+qid+'" style="background:#0e0e10;border:1px solid var(--line2);color:var(--txt);border-radius:8px;padding:9px 12px;font:inherit;font-size:13px"></div>'
        +'<div style="margin-left:auto"><button class="go" onclick="qSnd(this)" data-qid="'+qid+'" id="qsend-'+qid+'" style="white-space:nowrap">'
        +(approvedCount>0?'Send '+approvedCount+' to Buffer →':'Approve posters first')+'</button></div></div>'
        +'<div id="qs-preview-'+qid+'" style="font-size:12px;color:var(--mut);line-height:1.8;padding:10px 12px;background:rgba(255,255,255,.02);border-radius:7px;min-height:36px">Select a strategy and date to preview the schedule.</div>'
        +'</div>'
        // Poster grid
        +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px">'
        +(()=>{
          return entry.posters.map((p)=>{
            const st=local[qid]?.[p.filename]||p.status;
            const isApp=st==='approved',isDec=st==='declined';
            const u='/posters/'+CLIENT+'/'+encodeURIComponent(entry.stamp)+'/'+encodeURIComponent(p.filename);
            const imgU=u+'?e='+_SE;
            allQItems.push({url:imgU,caption:p.caption||''});
            const myQIdx=qGlobal++;
            return '<div style="border-radius:12px;overflow:hidden;border:2px solid '+(isApp?'var(--gold)':isDec?'var(--red)':'var(--line)')+';background:#0d0d0f;opacity:'+(isDec?'.45':'1')+';transition:all .18s">'
              +'<div class="poster-thumb" style="position:relative;cursor:zoom-in" onclick="openLb('+myQIdx+')">'
              +'<img src="'+imgU+'" loading="lazy">'
              +(isApp?'<div style="position:absolute;top:8px;right:8px;background:var(--gold);color:#15120a;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;pointer-events:none">✓ APPROVED</div>':'')
              +(isDec?'<div style="position:absolute;top:8px;right:8px;background:var(--red);color:#fff;font-size:10px;font-weight:707;padding:3px 8px;border-radius:999px;pointer-events:none">✗ DECLINED</div>':'')
              +'</div>'
              +'<div style="display:flex;padding:6px 8px 8px;gap:6px">'
              +'<button class="sec" style="flex:1;font-size:11px;padding:6px 4px;'+(isApp?'border-color:var(--gold);color:var(--gold)':'')+'" onclick="qSS(this)" data-qid="'+qid+'" data-fn="'+encodeURIComponent(p.filename)+'" data-s="approved">'+(isApp?'✓ Approved':'Approve')+'</button>'
              +'<button class="sec" style="flex:1;font-size:11px;padding:6px 4px;'+(isDec?'border-color:var(--red);color:var(--red)':'')+'" onclick="qSS(this)" data-qid="'+qid+'" data-fn="'+encodeURIComponent(p.filename)+'" data-s="declined">'+(isDec?'✗ Declined':'Decline')+'</button>'
              +'</div></div>';
          }).join('');
        })()
        +'</div></div>';
    }
    // Set lightbox items ONCE after all pending entries are processed so that
    // every onclick="openLb(N)" refers to the correct global index.
    window._lbItems=allQItems;

    // Sent history
    if(sent.length){
      html+='<div class="card"><h2>Sent History</h2>';
      for(const entry of sent){
        const sentCount=entry.posters.filter(p=>p.status==='sent').length;
        const hasIds=(entry.bufferPostIds||[]).length>0;
        html+='<div class="item" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">'
          +'<div><b style="font-size:13px">'+fmtStamp(entry.stamp)+'</b>'
          +'<div class="muted" style="font-size:12px;margin-top:2px">'+sentCount+' scheduled · '+( entry.strategy||'standard')+' · starts '+entry.startDate+'</div></div>'
          +'<div style="display:flex;gap:8px;align-items:center">'
          +'<span class="pill" style="color:#5be07e;border-color:rgba(60,180,80,.3)">✓ Sent to Buffer</span>'
          +'<a href="https://buffer.com/dashboard" target="_blank" class="sec" style="font-size:11px;text-decoration:none;padding:5px 10px">View in Buffer →</a>'
          +(hasIds?'<button class="sec" style="font-size:11px;color:var(--red);border-color:rgba(224,86,75,.4);padding:5px 10px" onclick="qCancel(this)" data-qid="'+entry.id+'">Cancel Posts</button>':'')
          +'</div></div>';
      }
      html+='</div>';
    }
    $('#view').innerHTML=html;
    // Set default start date to tomorrow (Manila time) for all pending entries.
    const tomorrow=new Date(Date.now()+8*3600*1000+86400000); // UTC+8 + 1 day
    const tmrStr=tomorrow.getUTCFullYear()+'-'+String(tomorrow.getUTCMonth()+1).padStart(2,'0')+'-'+String(tomorrow.getUTCDate()).padStart(2,'0');
    for(const entry of pending){
      const el=document.getElementById('qs-date-'+entry.id);
      if(el&&!el.value){el.value=tmrStr;}
      // Trigger preview with defaults
      qPreview(entry.id);
    }
  }

  // Data-attribute bridge functions — avoids quoting issues in onclick strings.
  window.qPrev  =el=>qPreview(el.dataset.qid);
  window.qSS    =el=>setStatus(el.dataset.qid,decodeURIComponent(el.dataset.fn||''),el.dataset.s);
  window.qSelA  =el=>qSelectAll(el.dataset.qid,el.dataset.s);
  window.qDel   =el=>qDelete(el.dataset.qid);
  window.qSnd   =el=>qSend(el.dataset.qid);
  window.qCancel=async function(el){
    const qid=el.dataset.qid;
    if(!confirm('Cancel these scheduled posts in Buffer? They will be removed from your Buffer queue and the posters will return to Approved status.'))return;
    el.disabled=true;el.textContent='Cancelling…';
    const r=await fetch('/api/queue/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:CLIENT,queueId:qid})});
    const d=await r.json();
    if(!r.ok||d.error){toast(d.error||'Cancel failed',true);el.disabled=false;el.textContent='Cancel Posts';return;}
    toast('\\u2713 '+d.cancelled+' post'+(d.cancelled===1?'':'s')+' cancelled in Buffer'+(d.failed?' ('+d.failed+' failed)':''));
    queue=await api('/api/queue?client='+CLIENT);renderQueue();
  };

  // Strategy time-slot definitions (Manila hours).
  const STRATS={light:[9,19],standard:[9,13,19],active:[9,11,13,17,20]};
  const DAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function buildSchedulePreview(strategy,startDateStr,count){
    const hours=STRATS[strategy]||STRATS.standard;
    const [y,m,d]=startDateStr.split('-').map(Number);
    const slots=[]; let dayOff=0;
    while(slots.length<count){
      for(const h of hours){
        if(slots.length>=count)break;
        // Manila UTC+8 → subtract 8h for UTC
        const utcMs=Date.UTC(y,m-1,d+dayOff,h-8,0,0);
        slots.push(new Date(utcMs));
      }
      dayOff++;
    }
    return slots;
  }
  window.qPreview=function(qid){
    const stratEl=document.getElementById('qs-strat-'+qid);
    const dateEl=document.getElementById('qs-date-'+qid);
    const previewEl=document.getElementById('qs-preview-'+qid);
    if(!stratEl||!dateEl||!previewEl||!dateEl.value)return;
    const entry=queue.find(e=>e.id===qid);if(!entry)return;
    const approvedN=entry.posters.filter(p=>(local[qid]?.[p.filename]||p.status)==='approved').length;
    if(!approvedN){previewEl.textContent='Approve some posters first to see the schedule.';return;}
    const slots=buildSchedulePreview(stratEl.value,dateEl.value,approvedN);
    // Group by day for compact display
    const byDay={};
    slots.forEach(dt=>{
      // Convert UTC back to Manila for display
      const manilaMs=dt.getTime()+8*3600*1000;
      const local2=new Date(manilaMs);
      const key=DAYS[local2.getUTCDay()]+', '+MONTHS[local2.getUTCMonth()]+' '+local2.getUTCDate();
      const h=local2.getUTCHours(),ap=h>=12?'PM':'AM';
      const h12=h%12||12;
      (byDay[key]=byDay[key]||[]).push(h12+':00 '+ap);
    });
    previewEl.innerHTML=Object.entries(byDay).map(([day,times])=>'<b style="color:var(--txt)">'+day+'</b> — '+times.join(', ')).join('<br>');
  };
  window.setStatus=function(qid,fname,status){
    if(!local[qid])local[qid]={};
    local[qid][fname]=status;
    // Update server in background
    fetch('/api/queue/review',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client:CLIENT,queueId:qid,decisions:[{filename:fname,status}]})});
    renderQueue();
  };
  window.qSelectAll=function(qid,status){
    const entry=queue.find(e=>e.id===qid);
    if(!local[qid])local[qid]={};
    entry.posters.forEach(p=>{local[qid][p.filename]=status;});
    fetch('/api/queue/review',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client:CLIENT,queueId:qid,decisions:entry.posters.map(p=>({filename:p.filename,status}))})});
    renderQueue();
  };
  window.qDelete=async function(qid){
    if(!confirm('Remove this batch from the queue?'))return;
    await fetch('/api/queue/'+qid+'?client='+CLIENT,{method:'DELETE'});
    queue=queue.filter(e=>e.id!==qid);renderQueue();
  };
  window.qSend=async function(qid){
    const stratEl=document.getElementById('qs-strat-'+qid);
    const dateEl=document.getElementById('qs-date-'+qid);
    const btn=document.getElementById('qsend-'+qid);
    const entry=queue.find(e=>e.id===qid);
    const approved=(local[qid]?Object.entries(local[qid]).filter(([,s])=>s==='approved').length:0)
      +(entry?.posters.filter(p=>!local[qid]?.[p.filename]&&p.status==='approved').length||0);
    if(!approved){toast('Approve at least one poster first',true);return;}
    if(!dateEl?.value){toast('Choose a start date first',true);dateEl?.focus();return;}
    // 5-second countdown undo window
    btn.disabled=true;
    let cancelled=false;
    const previewEl=document.getElementById('qs-preview-'+qid);
    const origPreview=previewEl?.innerHTML||'';
    let secs=5;
    const cdEl=document.createElement('div');
    cdEl.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 12px;background:rgba(224,86,75,.12);border:1px solid rgba(224,86,75,.3);border-radius:7px;font-size:13px;color:var(--txt)';
    cdEl.innerHTML='<span>Sending in <b id="cd-secs">5</b>s…</span><button class="sec" style="font-size:12px;padding:5px 12px;border-color:var(--red);color:var(--red)" id="cd-cancel">Cancel</button>';
    previewEl&&previewEl.replaceWith(cdEl);
    document.getElementById('cd-cancel').onclick=()=>{cancelled=true;cdEl.innerHTML='<span style="color:#5be07e">✓ Cancelled — nothing was sent.</span>';setTimeout(()=>{cdEl.replaceWith&&document.getElementById('qs-preview-'+qid)===null&&cdEl.insertAdjacentHTML('beforebegin','<div id="qs-preview-'+qid+'">'+origPreview+'</div>');cdEl.remove?.();},2000);btn.disabled=false;};
    await new Promise(r=>{const iv=setInterval(()=>{secs--;const el=document.getElementById('cd-secs');if(el)el.textContent=secs;if(secs<=0){clearInterval(iv);r();}},1000);});
    if(cancelled)return;
    cdEl.innerHTML='<span class="spinner"></span> Scheduling in Buffer…';
    try{
      const r=await fetch('/api/queue/send',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({client:CLIENT,queueId:qid,strategy:stratEl?.value||'standard',startDate:dateEl.value})});
      const d=await r.json();
      if(!r.ok||d.error){cdEl.innerHTML='<span style="color:#ff8a82">✗ '+( d.error||'Send failed')+'</span>';btn.disabled=false;return;}
      // Show confirmation with schedule
      const lines=(d.timestamps||[]).map((t,i)=>{const dt=new Date(new Date(t).getTime()+8*3600*1000);const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];const mons=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];const h=dt.getUTCHours(),ap=h>=12?'PM':'AM',h12=h%12||12;return '<span style="color:var(--gold)">Post '+(i+1)+':</span> '+days[dt.getUTCDay()]+', '+mons[dt.getUTCMonth()]+' '+dt.getUTCDate()+' at '+h12+':00 '+ap;}).join('<br>');
      cdEl.innerHTML='<div style="width:100%"><div style="color:#5be07e;font-weight:600;margin-bottom:8px">✓ '+d.sent+' poster'+(d.sent===1?'':'s')+' scheduled in Buffer'+(d.failed?' ('+d.failed+' failed)':'')+'</div>'+(lines?'<div style="font-size:12px;line-height:1.9;margin-bottom:10px">'+lines+'</div>':'')+'<div style="display:flex;gap:8px"><a href="https://buffer.com/dashboard" target="_blank" class="sec" style="font-size:12px;text-decoration:none;padding:6px 12px">View in Buffer →</a></div></div>';
      queue=await api('/api/queue?client='+CLIENT);
    }catch(e){cdEl.innerHTML='<span style="color:#ff8a82">✗ Network error</span>';btn.disabled=false;}
  };
  renderQueue();
}
async function viewBatches(){
  let ALL=await api('/api/batches?client='+CLIENT);
  $('#view').innerHTML=
   '<div class="bx-head"><h2 style="margin:0">Batches <span class="pill">'+CLIENT+'</span></h2>'
   +'<div class="bx-tools"><input id="bx_q" placeholder="Filter by date or caption…">'
   +'<button class="sec" id="bx_open">Open folder</button>'
   +'<button class="sec" id="bx_ref">Refresh</button></div></div>'
   +'<div id="bx_meta" class="muted" style="margin:0 0 14px"></div><div id="bx_list"></div>';
  const esc=s=>(s||'').replace(/[<>]/g,'');
  const b64=s=>btoa(unescape(encodeURIComponent(String(s||''))));
  const fromB64=s=>decodeURIComponent(escape(atob(s||'')));
  function paint(){
    const q=($('#bx_q').value||'').trim().toLowerCase();
    let nb=0,np=0;
    // Build flat lightbox items array across all rendered posters
    const bxItems=[];
    let lbGlobal=0;
    // One poster cell: fixed-height thumb, status badge, hover copy/download,
    // approve / decline / posted / delete actions.
    const posterCell=(B,caps,i)=>{
      const f=B.files[i];
      const u='/posters/'+CLIENT+'/'+encodeURIComponent(B.stamp)+'/'+encodeURIComponent(f);
      const imgU=u+'?e='+_SE; // per-page-load buster: never reuse a cached broken response
      const st=(B.statuses&&B.statuses[f])||'pending';
      const fn=encodeURIComponent(f);
      const badge=st==='approved'?'<div class="ps-badge" style="background:var(--gold);color:#15120a">✓ Approved</div>'
        :st==='posted'?'<div class="ps-badge" style="background:#3cb454;color:#fff">✓ Posted</div>'
        :st==='declined'?'<div class="ps-badge" style="background:var(--red);color:#fff">✗ Declined</div>':'';
      const myLb=lbGlobal++;
      bxItems.push({url:imgU,caption:caps[i]||''});
      return '<figure data-stamp="'+B.stamp+'" data-file="'+fn+'" style="opacity:'+(st==='declined'?'.4':'1')+';transition:opacity .2s">'
       +badge
       +'<div class="poster-thumb" style="cursor:zoom-in" onclick="openLb('+myLb+')">'
       +'<img src="'+imgU+'" loading="lazy" alt="">'
       +'</div>'
       +'<button class="cp" data-c="'+b64(caps[i]||'')+'" title="Copy caption">📋</button>'
       +'<a class="dl" href="'+u+'?dl=1" download>↓</a>'
       +'<div class="ps-actions">'
       +'<div class="ps-row">'
       +'<button class="ps-btn ps-approve'+(st==='approved'?' ps-on-gold':'')+'" data-stamp="'+B.stamp+'" data-fn="'+fn+'" data-s="approved">'+(st==='approved'?'✓ Approved':'✓ Approve')+'</button>'
       +'<button class="ps-btn ps-decline'+(st==='declined'?' ps-on-red':'')+'" data-stamp="'+B.stamp+'" data-fn="'+fn+'" data-s="declined">'+(st==='declined'?'✗ Declined':'✗ Decline')+'</button>'
       +'</div>'
       +'<div class="ps-row">'
       +'<button class="ps-btn ps-btn-secondary ps-posted'+(st==='posted'?' ps-on-green':'')+'" style="flex:3" data-stamp="'+B.stamp+'" data-fn="'+fn+'" data-s="posted">'+(st==='posted'?'✓ Posted':'Already posted')+'</button>'
       +'<button class="ps-btn ps-btn-secondary del-poster" style="flex:1" data-stamp="'+B.stamp+'" data-file="'+fn+'" title="Delete poster">🗑</button>'
       +'</div>'
       +'</div></figure>';
    };
    // One card per batch: header row (date, count, captions, zip, delete) + poster grid.
    const batchCard=(B)=>{
      const caps=B.captions.split(/^#\\d+\\s*$/m).map(s=>s.trim()).filter(Boolean);
      const stampHit=B.stamp.toLowerCase().indexOf(q)>-1;
      const idx=B.files.map((_f,i)=>i).filter(i=>!q||stampHit||(caps[i]||'').toLowerCase().indexOf(q)>-1);
      if(!idx.length)return '';
      nb++;np+=idx.length;
      const allCaps=idx.map(i=>'#'+(i+1)+'\\n'+(caps[i]||'')).join('\\n\\n---\\n\\n');
      return '<div class="card" data-stamp="'+B.stamp+'">'
       +'<div class="bx-row"><b>'+fmtStamp(B.stamp)+'</b>'
       +'<span>'
       +'<span class="pill">'+idx.length+(idx.length!==B.count?(' / '+B.count):'')+' posters</span> '
       +'<button class="sec" data-cp-all="'+b64(allCaps)+'">📋 All captions</button> '
       +'<a class="sec" style="text-decoration:none" href="/api/batch-zip?client='+CLIENT+'&stamp='+encodeURIComponent(B.stamp)+'">⬇ All (.zip)</a> '
       +'<button class="sec del-batch" data-stamp="'+B.stamp+'" style="color:var(--red);border-color:rgba(224,86,75,.35)" title="Delete this entire batch">🗑 Delete batch</button>'
       +'</span></div>'
       +'<div class="grid" style="margin-top:14px">'+idx.map(i=>posterCell(B,caps,i)).join('')+'</div>'
       +'</div>';
    };
    const html=ALL.map(batchCard).join('');
    window._lbItems=bxItems;
    $('#bx_list').innerHTML=ALL.length?(html||'<p class="muted">No posters match “'+esc(q)+'”.</p>')
      :'<p class="muted">No batches yet. Generate some on the Generate tab.</p>';
    $('#bx_meta').textContent=ALL.length
      ?(nb+' batch'+(nb===1?'':'es')+' · '+np+' poster'+(np===1?'':'s')+(q?' (filtered)':''))
      :'';
    // Poster status action buttons (Approve / Mark Posted / Decline)
    document.querySelectorAll('#bx_list .ps-btn').forEach(b=>b.onclick=async ev=>{
      ev.stopPropagation();
      const stamp=b.dataset.stamp, fn=decodeURIComponent(b.dataset.fn), status=b.dataset.s;
      b.disabled=true; b.textContent='…';
      try{
        const r=await fetch('/api/poster/tag',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({client:CLIENT,stamp,filename:fn,status})});
        const d=await r.json();
        if(!r.ok||d.error){toast(d.error||'Failed',true);b.disabled=false;return;}
        const msgs={approved:'✓ Approved — go to Queue tab to schedule',posted:'✓ Marked as posted',declined:'Declined',pending:'Reset to pending'};
        toast(msgs[status]||'Updated');
        // Refresh the batches list to show updated badges
        ALL=await api('/api/batches?client='+CLIENT);paint();
        if(status==='approved')setTimeout(()=>{TAB='queue';render();},1800);
      }catch(e){toast('Error',true);b.disabled=false;}
    });
    document.querySelectorAll('#bx_list .cp').forEach(b=>b.onclick=ev=>{
      ev.preventDefault();
      navigator.clipboard.writeText(fromB64(b.dataset.c)).then(()=>toast('Caption copied'));
    });
    document.querySelectorAll('#bx_list [data-cp-all]').forEach(b=>b.onclick=ev=>{
      ev.preventDefault();
      navigator.clipboard.writeText(fromB64(b.dataset.cpAll)).then(()=>toast('All captions copied'));
    });
    // Delete poster
    document.querySelectorAll('#bx_list .del-poster').forEach(b=>b.onclick=async ev=>{
      ev.stopPropagation();
      if(!confirm('Delete this poster? This cannot be undone.'))return;
      const {stamp,file}=b.dataset;
      const r=await fetch('/api/poster?client='+CLIENT+'&stamp='+encodeURIComponent(stamp)+'&file='+file,{method:'DELETE'});
      if(!r.ok){toast('Delete failed',true);return;}
      // Remove from data + DOM
      const batch=ALL.find(x=>x.stamp===stamp);
      if(batch)batch.files=batch.files.filter(f=>f!==decodeURIComponent(file));
      b.closest('figure')?.remove();
      toast('Poster deleted');
      // If no files left in batch, remove the card
      if(batch&&!batch.files.length){
        const card=document.querySelector('#bx_list .card[data-stamp="'+stamp+'"]');
        card?.remove();
        const bIdx=ALL.findIndex(x=>x.stamp===stamp);
        if(bIdx>-1)ALL.splice(bIdx,1);
      }
    });
    // Delete batch
    document.querySelectorAll('#bx_list .del-batch').forEach(b=>b.onclick=async ev=>{
      ev.stopPropagation();
      const {stamp}=b.dataset;
      const count=ALL.find(x=>x.stamp===stamp)?.files?.length||0;
      if(!confirm('Delete entire batch ('+count+' poster'+(count===1?'':'s')+')? This cannot be undone.'))return;
      const r=await fetch('/api/batch?client='+CLIENT+'&stamp='+encodeURIComponent(stamp),{method:'DELETE'});
      if(!r.ok){toast('Delete failed',true);return;}
      const bIdx=ALL.findIndex(x=>x.stamp===stamp);
      if(bIdx>-1)ALL.splice(bIdx,1);
      document.querySelector('#bx_list .card[data-stamp="'+stamp+'"]')?.remove();
      toast('Batch deleted');
    });
  }
  $('#bx_q').oninput=paint;
  // Force a fresh fetch on manual Refresh — bypass the 20s api() cache so
  // newly-completed batches always appear immediately when the user clicks it.
  $('#bx_ref').onclick=()=>{_apiCache.delete('/api/batches?client='+CLIENT);viewBatches();};
  $('#bx_open').onclick=()=>{fetch('/api/reveal',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client:CLIENT})});toast('Opening export folder…');};
  paint();
}
async function viewHacker(){
  const cls=await api('/api/clients');
  let hkClient=(cls.find(c=>c.id===CLIENT)?CLIENT:((cls[0]&&cls[0].id)||'jurie'));
  let method='image';        // image | url | auto
  let imgB64='';let imgMime='image/png';
  const last=window._hkLast||null;   // last result — survives tab switches, cleared on refresh or Clear
  if(last){hkClient=last.client||hkClient;method=last.method||method;}
  const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const escAttr=s=>esc(s).replace(/"/g,'&quot;');
  const clientOpts=cls.map(c=>'<option value="'+c.id+'"'+(c.id===hkClient?' selected':'')+'>'+esc(c.label)+'</option>').join('');
  const spin='<span class="spinner" style="width:14px;height:14px;border:2px solid rgba(244,180,0,.3);border-top-color:var(--gold);border-radius:50%;display:inline-block;animation:spin .7s linear infinite;vertical-align:middle;margin-right:8px"></span>';
  $('#view').innerHTML=
   '<div class="card"><h2>💡 Format Hacker</h2>'
   +'<div class="muted" style="margin:-6px 0 16px">Deconstruct a winning ad or viral post from ANY niche — its visual layout AND its copywriting formula — then rebuild it as ready-to-shoot video storyboards in the selected brand voice.</div>'
   +'<div class="row" style="margin-bottom:14px"><div style="flex:0 0 240px"><label>Client</label>'
   +'<select id="hk_client">'+clientOpts+'</select></div></div>'
   +'<div class="bx-tools" style="margin-bottom:14px">'
   +'<button class="sec" id="hk_t_i">📸 Screenshot</button>'
   +'<button class="sec" id="hk_t_u">🔗 Paste Link</button>'
   +'<button class="sec" id="hk_t_a">🔥 Auto-Discover</button>'
   +'</div>'
   +'<div id="hk_src_i"><label>Ad screenshot</label>'
   +'<div id="hk_drop" style="border:1px dashed var(--line2);border-radius:10px;padding:20px;text-align:center;cursor:pointer;color:var(--mut)">'
   +'<div id="hk_file_lbl">Click or drop a screenshot of the ad here</div>'
   +'<div id="hk_prev" style="display:none;margin-top:12px"></div></div>'
   +'<input id="hk_file" type="file" accept="image/*" style="display:none">'
   +'<div class="muted" style="margin-top:6px;font-size:12px">The reliable path — a screenshot bypasses login and anti-bot walls. Max 15 MB.</div></div>'
   +'<div id="hk_src_u" style="display:none"><label>Ad / post URL</label>'
   +'<input id="hk_url" type="text" placeholder="https://...">'
   +'<div class="muted" style="margin-top:6px;font-size:12px">We read the public text of the page. Social login-walls may block it — use a screenshot if so.</div></div>'
   +'<div id="hk_src_a" style="display:none">'
   +'<label>Niche / topic / your idea (optional)</label>'
   +'<input id="hk_topic" type="text" placeholder="e.g. skincare for men — or: I want to promote my coffee shop but do not know how">'
   +'<div class="muted" style="margin-top:6px;line-height:1.6">Point the scraper at a specific niche, or drop your rough idea — it finds proven content and turns it into something that is yours but works. If a live breakdown cannot be fetched, it synthesizes a proven format from knowledge.</div></div>'
   +'<p style="margin:16px 0"><button class="go" id="hk_go">Deconstruct →</button></p>'
   +'<div id="hk_status" style="min-height:20px;margin-bottom:6px"></div>'
   +'<div id="hk_out"></div>'
   +'</div>';
  $('#hk_client').onchange=e=>{hkClient=e.target.value;CLIENT=hkClient;try{localStorage.setItem('qps_client',CLIENT);}catch(_){}buildNav();};
  const showMethod=()=>{
    const set=(id,on)=>{const el=$('#'+id);if(el)el.style.display=on?'':'none';};
    const brd=(id,on)=>{const el=$('#'+id);if(el)el.style.borderColor=on?'var(--gold)':'';};
    set('hk_src_i',method==='image');set('hk_src_u',method==='url');set('hk_src_a',method==='auto');
    brd('hk_t_i',method==='image');brd('hk_t_u',method==='url');brd('hk_t_a',method==='auto');
    const go=$('#hk_go');if(go)go.textContent=method==='auto'?'🔥 Find Winning Ad Formats':'Deconstruct →';
  };
  $('#hk_t_i').onclick=()=>{method='image';showMethod();};
  $('#hk_t_u').onclick=()=>{method='url';showMethod();};
  $('#hk_t_a').onclick=()=>{method='auto';showMethod();};
  showMethod();
  if(last&&last.topic){const tpi=$('#hk_topic');if(tpi)tpi.value=last.topic;}
  const readFile=f=>{
    if(!f)return;
    if(f.type.indexOf('image/')!==0){alert('Please choose an image file.');return;}
    if(f.size>15*1024*1024){alert('That image is too large (max 15 MB). Use a smaller screenshot.');return;}
    const fr=new FileReader();
    fr.onload=()=>{const s=String(fr.result||'');const i=s.indexOf(',');imgB64=i>=0?s.slice(i+1):s;imgMime=f.type||'image/png';
      const pv=$('#hk_prev');if(pv){pv.style.display='';pv.innerHTML='<img src="'+s+'" style="max-width:200px;max-height:200px;border-radius:10px;border:1px solid var(--line2)">';}
      const lb=$('#hk_file_lbl');if(lb)lb.textContent=f.name;};
    fr.readAsDataURL(f);
  };
  $('#hk_file').onchange=()=>readFile($('#hk_file').files&&$('#hk_file').files[0]);
  {const dz=$('#hk_drop');if(dz){dz.onclick=()=>$('#hk_file').click();
    dz.addEventListener('dragover',e=>{e.preventDefault();dz.style.borderColor='var(--gold)';});
    dz.addEventListener('dragleave',()=>{dz.style.borderColor='var(--line2)';});
    dz.addEventListener('drop',e=>{e.preventDefault();dz.style.borderColor='var(--line2)';
      const f=(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0]);readFile(f);});}}
  // A scene as a compact, scannable block: header (Scene N · shot · duration),
  // then labelled lines. B-roll only shows when present, to keep it uncluttered.
  const sceneMeta=sc=>{const a=[];if(sc.shot)a.push(esc(sc.shot));if(sc.duration)a.push(esc(sc.duration));return a.length?' · '+a.join(' · '):'';};
  const line=(lbl,val)=>val?'<div style="margin-top:3px"><span style="color:var(--mut)">'+lbl+'</span> — '+esc(val)+'</div>':'';
  const sceneRow=(sc,i)=>'<div style="border-left:2px solid var(--gold);padding:7px 0 7px 12px;margin:9px 0">'
    +'<div style="font-size:10px;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;font-weight:700">Scene '+(i+1)+sceneMeta(sc)+'</div>'
    +line('On-screen',sc.onScreenText)
    +line('Voiceover',sc.voiceover)
    +line('Camera',sc.cameraAction)
    +line('B-roll',sc.bRoll)
    +'</div>';
  const sendToEngine=(sb,mode)=>{
    const L=[];L.push(sb.title||'Untitled');
    if(sb.contentIdea)L.push('Idea: '+sb.contentIdea);
    if(sb.hook)L.push('Hook: '+sb.hook);
    (sb.scenes||[]).forEach((sc,i)=>{L.push('');
      L.push('Scene '+(i+1)+(sc.shot?' ('+sc.shot+(sc.duration?', '+sc.duration:'')+')':''));
      if(sc.onScreenText)L.push('On-screen text: '+sc.onScreenText);
      if(sc.voiceover)L.push('Voiceover: '+sc.voiceover);
      if(sc.cameraAction)L.push('Camera: '+sc.cameraAction);
      if(sc.bRoll)L.push('B-roll: '+sc.bRoll);});
    if(sb.caption){L.push('');L.push('Caption: '+sb.caption);}
    const defChar=(cls.find(c=>c.id===hkClient)||{}).characterId||'';
    window._hackHandoff={script:L.join('\\n'),count:(sb.scenes||[]).length||8,characterId:defChar};
    CLIENT=hkClient;try{localStorage.setItem('qps_client',CLIENT);}catch(_){}
    buildNav().then(()=>{TAB=(mode==='story'?'video':'broll');render();});
  };
  const oneSource=(src,prev)=>{
    if(src.kind==='image'&&prev)return '<img src="'+prev+'" style="max-width:220px;max-height:220px;border-radius:10px;border:1px solid var(--line2)">';
    if(src.kind==='video')return '<div style="display:inline-block;vertical-align:top;width:200px;margin:0 12px 12px 0">'
      +(src.thumbnail?'<a href="'+escAttr(src.url)+'" target="_blank" rel="noopener"><img src="'+escAttr(src.thumbnail)+'" style="width:200px;border-radius:10px;border:1px solid var(--line2)"></a>':'')
      +'<div style="margin-top:5px;font-size:12px;line-height:1.35"><a href="'+escAttr(src.url)+'" target="_blank" rel="noopener" style="color:var(--gold)">▶ '+esc(src.title||'source')+'</a></div></div>';
    if(src.kind==='link')return (src.images||[]).slice(0,3).map(u=>'<a href="'+escAttr(src.url)+'" target="_blank" rel="noopener"><img src="'+escAttr(u)+'" style="max-width:180px;border-radius:10px;border:1px solid var(--line2);margin:0 8px 8px 0"></a>').join('')
      +'<div style="margin-top:4px;word-break:break-all"><a href="'+escAttr(src.url)+'" target="_blank" rel="noopener" style="color:var(--gold)">🔗 '+esc(src.url)+'</a></div>';
    return '';
  };
  const sourceCard=(sources,prev)=>{
    if(!sources||!sources.length)return '';
    const items=sources.map(s=>oneSource(s,prev)).filter(Boolean).join('');
    if(!items)return '';
    const label=sources.length>1?('🔎 What it analyzed ('+sources.length+' examples)'):'🔎 What it analyzed';
    return '<div class="card" style="margin-top:16px"><h2>'+label+'</h2>'+items+'</div>';
  };
  const renderResult=(j,prev)=>{
    const bp=j.blueprint||{};const boards=j.adaptedStoryboards||[];
    let html='<div style="display:flex;justify-content:flex-end;margin-top:12px"><button class="sec" id="hk_clear">✕ Clear results</button></div>';
    html+=sourceCard(j.sources||(j.source?[j.source]:[]),prev);
    html+='<div class="card" style="margin-top:16px"><h2>🧬 Format Blueprint</h2>'
      +(j.synthesized?'<div class="muted" style="margin:-4px 0 12px">No live source could be fetched — this is a proven format synthesized from knowledge.</div>':'')
      +'<div style="margin-bottom:10px"><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Visual strategy</div>'+esc(bp.visualStrategy)+'</div>'
      +'<div style="margin-bottom:10px"><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Copywriting formula</div>'+esc(bp.copywritingFormula)+'</div>'
      +'<div><div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Why it worked</div>'+esc(bp.whyItWorked)+'</div></div>';
    boards.forEach((sb,bi)=>{
      const tags=(sb.hashtags||[]).map(h=>'#'+String(h).replace(/^#/,'')).join(' ');
      html+='<div class="card" style="margin-top:16px"><h2 style="margin-bottom:4px">🎬 '+esc(sb.title)+'</h2>'
        +(sb.contentIdea?'<div style="margin:0 0 12px;font-size:13px"><span style="color:var(--mut)">💡 Idea — </span>'+esc(sb.contentIdea)+'</div>':'')
        +'<div style="background:rgba(232,182,74,.08);border:1px solid var(--line2);border-radius:8px;padding:8px 11px;margin-bottom:8px"><div style="color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:.06em">Hook</div><div style="margin-top:2px">'+esc(sb.hook)+'</div></div>'
        +(sb.scenes||[]).map((sc,i)=>sceneRow(sc,i)).join('')
        +(sb.caption?'<div style="margin-top:12px;border-top:1px solid var(--line2);padding-top:12px">'
          +'<div style="font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">📝 Ready-to-post caption</div>'
          +'<div style="white-space:pre-wrap">'+esc(sb.caption)+'</div>'
          +(tags?'<div style="margin-top:6px;color:#7fb2ff">'+esc(tags)+'</div>':'')
          +'<button class="sec" data-cap="'+bi+'" style="margin-top:9px">Copy caption</button></div>':'')
        +'<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">'
        +'<button class="go" data-eng="story" data-bi="'+bi+'">Send to Video Engine →</button>'
        +'<button class="sec" data-eng="broll" data-bi="'+bi+'">Send to B-Roll Engine →</button></div></div>';
    });
    $('#hk_out').innerHTML=html;
    const cl=$('#hk_clear');if(cl)cl.onclick=()=>{window._hkLast=null;$('#hk_out').innerHTML='';};
    Array.prototype.forEach.call(document.querySelectorAll('#hk_out button[data-eng]'),b=>{
      b.onclick=()=>sendToEngine(boards[+b.dataset.bi],b.dataset.eng);});
    Array.prototype.forEach.call(document.querySelectorAll('#hk_out button[data-cap]'),b=>{
      b.onclick=()=>{const sb=boards[+b.dataset.cap];const tg=(sb.hashtags&&sb.hashtags.length)?('\\n\\n'+sb.hashtags.map(h=>'#'+String(h).replace(/^#/,'')).join(' ')):'';
        navigator.clipboard.writeText((sb.caption||'')+tg).then(()=>{const o=b.textContent;b.textContent='Copied ✓';setTimeout(()=>{b.textContent=o;},1500);},()=>alert('Clipboard blocked — select and copy manually.'));};});
  };
  $('#hk_go').onclick=()=>{
    const tp=method==='auto'?(($('#hk_topic')||{}).value||'').trim():'';
    const body={client:hkClient,method:method};
    if(tp)body.topic=tp;
    if(method==='image'){if(!imgB64){alert('Upload a screenshot of the ad first.');return;}body.image=imgB64;body.mimeType=imgMime;}
    else if(method==='url'){const u=($('#hk_url').value||'').trim();if(!/^https?:\\/\\//i.test(u)){alert('Paste a valid link starting with http.');return;}body.url=u;}
    const btn=$('#hk_go');btn.disabled=true;
    $('#hk_status').innerHTML=spin+'Deconstructing ad psychology and visuals…';
    $('#hk_out').innerHTML='';
    fetch('/api/hack-format',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(r=>r.json()).then(j=>{btn.disabled=false;$('#hk_status').innerHTML='';
        if(!j||j.error){$('#hk_status').innerHTML='<span style="color:#ff6b6b">'+esc((j&&j.error)||'Something went wrong. Try again.')+'</span>';return;}
        const prev=(method==='image')?('data:'+imgMime+';base64,'+imgB64):'';
        window._hkLast={client:hkClient,method:method,topic:tp,result:j,prev:prev};
        renderResult(j,prev);})
      .catch(()=>{btn.disabled=false;$('#hk_status').innerHTML='<span style="color:#ff6b6b">Network error. Try again.</span>';});
  };
  if(last&&last.result){renderResult(last.result,last.prev||'');}
}
async function viewBroll(mode){
  mode=mode==='story'?'story':'broll';const isStory=mode==='story';
  const [chars,ENV]=await Promise.all([
    api('/api/characters'),
    api('/api/env').catch(()=>({})),
  ]);
  let src='idea';          // idea | script | video | claude
  let brStamp='';          // current analyzed set
  let brSet=null;          // {meta,shots}
  let brLast={};           // remembered Stage-1 inputs (for Back)
  let es;                  // shared SSE handle
  const bresc=(s)=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const charOpts='<option value="none">— none (scenes only) —</option>'
   +chars.map(c=>'<option value="'+c.id+'">'+c.name+' ('+c.client+', '
    +((c.photos||[]).length)+' photo'+(((c.photos||[]).length)===1?'':'s')+')</option>').join('');
  $('#view').innerHTML=
   '<div class="card"><h2>'+(isStory?'Video Maker':'B-Roll Maker')+'</h2>'
   +'<div class="muted" style="margin:-6px 0 16px">'
   +(isStory
     ? 'Turn an idea or a script into a full video. The AI plans a connected, scene-by-scene storyboard you <b style="color:var(--txt)">review before any frames are generated</b>, then renders the first frame + a paired video prompt for each scene. Veo auto-animation is OFF — you assemble the video in your own tool.'
     : 'Start from an idea, a script, or a video. The AI plans a connected storyboard you <b style="color:var(--txt)">review before any frames are generated</b>, then renders the first frame + a paired video prompt for each scene. Veo auto-animation is OFF — you make the video in your own tool.')
   +'</div>'
   +'<div id="br_input">'
   +'<div class="bx-tools" style="margin-bottom:14px">'
   +'<button class="sec" id="br_t_i">Idea</button>'
   +'<button class="sec" id="br_t_s">Script</button>'
   +(isStory?''
     :'<button class="sec" id="br_t_v">Video</button>'
      +'<button class="sec" id="br_t_c">Use Claude <span style="opacity:.7;font-size:10px;letter-spacing:.06em;text-transform:uppercase">· any size</span></button>')
   +'</div>'
   +'<div id="br_src_i"><label>Idea</label>'
   +'<textarea id="br_idea" placeholder="One or two lines — e.g. why discipline beats motivation for busy parents" style="min-height:90px"></textarea>'
   +'<div class="muted" style="margin-top:6px;font-size:12px">The AI drafts a short script from this first, then builds the storyboard you review.</div></div>'
   +'<div id="br_src_s" style="display:none"><label>Script</label>'
   +'<textarea id="br_script" placeholder="Paste the script (Taglish ok)…" style="min-height:140px"></textarea></div>'
   +'<div id="br_src_v" style="display:none"><label>Video file</label>'
   +'<input id="br_video" type="file" accept="video/*"><div class="muted" style="margin-top:6px">'
   +'Gemini watches the video directly (sees every frame, hears every word) and writes the shot list. '
   +'<b style="color:var(--txt)">Max 100 MB</b> — short Taglish/English clips work great. '
   +'Phone clips are usually ~5–15 MB per minute; longer recordings should be trimmed or compressed first.</div></div>'
   +'<div id="br_src_c" style="display:none">'
   +'<div class="muted" style="margin-bottom:10px;line-height:1.6">'
   +'For videos that won\\\'t fit the 100 MB cap (multi-hour podcasts, raw 4K interviews, etc.), let Claude run the pipeline locally on the Mac '
   +'— no upload, no size limit. Pick your settings above, copy the prompt below, paste it into Claude Code (or Claude Desktop with this folder open), and follow what Claude asks for. '
   +'When it finishes, hit <b style="color:var(--txt)">Refresh</b> on the Sets list to see the batch.</div>'
   +'<label>Prompt to paste into Claude</label>'
   +'<pre id="br_claude_prompt" style="max-height:none;background:#0b0b0d;border:1px solid var(--line-bright);border-radius:9px;padding:14px;font-size:11.5px;line-height:1.55;color:#cfcfd2;white-space:pre-wrap;overflow:auto"></pre>'
   +'<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
   +'<button class="go" id="br_copy">Copy prompt</button>'
   +'<button class="sec" id="br_open_claude">Open Claude in browser</button>'
   +'<span class="muted" style="font-size:12px">(or paste it into a Claude Code session running on your Mac — that\\\'s the one with file access)</span>'
   +'</div></div>'
   +'<div class="row" style="margin-top:6px">'
   +'<div><label>Aspect</label><select id="br_aspect"><option value="9:16">9:16 vertical</option>'
   +'<option value="16:9">16:9 landscape</option></select></div>'
   +'<div style="flex:0 0 120px"><label>Scenes</label><input id="br_count" type="number" min="1" max="40" value="8"></div>'
   +'<div><label>Character (optional)</label><select id="br_char">'+charOpts+'</select></div></div>'
   +'<p style="margin:16px 0"><button class="go" id="br_go">Analyze →</button></p>'
   +'</div>'
   +'<div id="br_story"></div>'
   +'<pre id="br_log" style="display:none"></pre></div>'
   +'<div class="bx-head"><h2 style="margin:0">'+(isStory?'Projects':'Sets')+'</h2><div class="bx-tools">'
   +'<button class="sec" id="br_ref">Refresh</button></div></div><div id="br_sets"></div>';
  const showSrc=()=>{
    const set=(id,on)=>{const e=$('#'+id);if(e)e.style.display=on?'':'none';};
    const brd=(id,on)=>{const e=$('#'+id);if(e)e.style.borderColor=on?'var(--gold)':'';};
    set('br_src_i',src==='idea');set('br_src_s',src==='script');
    set('br_src_v',src==='video');set('br_src_c',src==='claude');
    brd('br_t_i',src==='idea');brd('br_t_s',src==='script');
    brd('br_t_v',src==='video');brd('br_t_c',src==='claude');
    // In Claude mode, hide the Analyze button — the action is "Copy prompt" inside the panel.
    const go=$('#br_go');if(go)go.style.display=src==='claude'?'none':'';
    if(src==='claude')paintClaudePrompt();
  };
  function paintClaudePrompt(){
    const aspect=$('#br_aspect').value||'9:16';
    const count=$('#br_count').value||'25';
    const charId=$('#br_char').value||'none';
    const charLine=(charId==='none'||!charId)
      ? '- No character — scene-only b-roll cutaways.'
      : '- Character: '+charId+' (Claude will load this character\\\'s reference photos from config/characters.json).';
    const prompt=
      'Hi Claude — I want to generate a B-Roll batch from a video on my Mac. The web dashboard\\\'s upload cap is 100 MB and my source is bigger, so please run this locally.\\n'
      +'\\nSettings I picked in the dashboard:\\n'
      +'- Aspect ratio: '+aspect+'\\n'
      +'- Number of shots: '+count+'\\n'
      +charLine+'\\n'
      +'\\nWhat I\\\'d like you to do:\\n'
      +'1. Ask me for the absolute path to my video file (any size).\\n'
      +'2. If the file is bigger than 15 MB, compress it first so it fits Gemini\\\'s inline limit while keeping the audio intelligible:\\n'
      +'     ffmpeg -y -i "<path>" -vf scale=-2:360 -c:v libx264 -crf 36 -preset veryfast \\\\\\n'
      +'       -c:a aac -b:a 32k -ac 1 -ar 16000 -movflags +faststart /tmp/broll-source.mp4\\n'
      +'3. Run the pipeline against the compressed copy:\\n'
      +'     cd /Users/macbookpro/claude_code/research/remotion-app\\n'
      +'     node scripts/broll-batch.mjs --aspect '+aspect+' --count '+count+' '+(charId==='none'||!charId?'':'--character '+charId+' ')+'--video /tmp/broll-source.mp4\\n'
      +'4. After step 2 of the pipeline finishes, retry any shots that hit Vertex 429 quota with 8s throttling between calls (it usually drops 5–15 of them on bigger batches).\\n'
      +'5. Patch the JSON\\\'s framePath fields for the retried shots, then run scripts/broll-deliverable.mjs to rebuild the HTML so it shows all of them.\\n'
      +'6. Open the resulting /Users/macbookpro/claude_code/brolls/generated/<stamp>/broll.html in my browser.\\n'
      +'\\nWhen the batch is done it will show up under the Sets list in the dashboard — I\\\'ll click Refresh there to grab it.';
    $('#br_claude_prompt').textContent=prompt;
  }
  $('#br_t_i').onclick=()=>{src='idea';showSrc();};
  $('#br_t_s').onclick=()=>{src='script';showSrc();};
  {const _v=$('#br_t_v');if(_v)_v.onclick=()=>{src='video';showSrc();};}
  {const _c=$('#br_t_c');if(_c)_c.onclick=()=>{src='claude';showSrc();};}
  // Repaint when any of the settings the prompt depends on change.
  ['br_aspect','br_count','br_char'].forEach(id=>{
    const el=$('#'+id);if(el)el.addEventListener('change',()=>{if(src==='claude')paintClaudePrompt();});
    if(el)el.addEventListener('input',()=>{if(src==='claude')paintClaudePrompt();});
  });
  showSrc();
  // ── Format Hacker handoff ── if a concept was "Sent to Engine", prefill the
  // Script field so the user can review + hit Analyze (the normal staged flow).
  if(window._hackHandoff){
    const H=window._hackHandoff;window._hackHandoff=null;
    src='script';showSrc();
    const st=$('#br_script');if(st)st.value=H.script||'';
    if(H.count){const cn=$('#br_count');if(cn)cn.value=Math.max(1,Math.min(40,H.count));}
    if(H.characterId){const ch=$('#br_char');if(ch&&Array.prototype.some.call(ch.options,o=>o.value===H.characterId))ch.value=H.characterId;}
    const inp=$('#br_input');if(inp)inp.scrollIntoView({behavior:'smooth',block:'start'});
  }
  // Wire up the Claude-mode buttons — use a flag so re-visiting this tab
  // does not stack duplicate listeners (each visit re-calls viewBroll).
  if(!window._brClickWired){window._brClickWired=true;
  document.addEventListener('click',(ev)=>{
    if(ev.target&&ev.target.id==='br_copy'){
      const txt=$('#br_claude_prompt').textContent||'';
      navigator.clipboard.writeText(txt).then(()=>{
        const b=ev.target;const o=b.textContent;b.textContent='Copied ✓';
        setTimeout(()=>{b.textContent=o;},1600);
      },()=>alert('Clipboard blocked — select the prompt manually and Cmd+C'));
    }
    if(ev.target&&ev.target.id==='br_open_claude'){
      window.open('https://claude.ai/new','_blank','noopener');
    }
  });
  }
  // ── Staged flow: Analyze (1→2) → Storyboard review → Frames (2→3) ──
  // Stream the shared job log; fire onDone(ok) on the job's terminal line. The
  // SSE channel replays the previous job's log on connect, so we ignore done/fail
  // until ctl.start() (called once the POST confirms THIS job started).
  function brStreamLog(L,onDone){
    es&&es.close();es=new EventSource('/api/log');
    let jobStarted=false;
    es.onmessage=ev=>{const line=JSON.parse(ev.data);
      L.textContent+=line+'\\n';L.scrollTop=L.scrollHeight;
      if(jobStarted&&(line.indexOf('✓ Done')>-1||line.indexOf('✗ Exited')>-1)){es.close();onDone(line.indexOf('✓ Done')>-1);}};
    return {start:()=>{jobStarted=true;}};
  }
  $('#br_go').onclick=()=>{
    const aspect=$('#br_aspect').value,count=$('#br_count').value||'8',charId=$('#br_char').value;
    const fd=new FormData();fd.append('aspect',aspect);fd.append('count',count);fd.append('characterId',charId);fd.append('mode',mode);
    let sizeMB=0;
    if(src==='video'){const f=$('#br_video').files[0];
      if(!f)return alert('Choose a video file');
      sizeMB=f.size/(1024*1024);
      if(sizeMB>100)return alert('That video is '+sizeMB.toFixed(1)+' MB — please trim or compress it under 100 MB.');
      fd.append('video',f);}
    else if(src==='idea'){const t=$('#br_idea').value.trim();
      if(t.length<4)return alert('Describe your idea in a few words');fd.append('idea',t);}
    else{const t=$('#br_script').value.trim();
      if(t.length<10)return alert('Paste a script (10+ chars)');fd.append('script',t);}
    const L=$('#br_log');$('#br_go').disabled=true;L.style.display='block';
    L.textContent=src==='video'?'Uploading '+sizeMB.toFixed(1)+' MB video…\\n':'Planning the storyboard…\\n';
    const ctl=brStreamLog(L,(ok)=>{$('#br_go').disabled=false;if(ok)loadStoryboard();});
    const fail=(msg)=>{alert(msg);L.textContent+='\\n✗ '+msg+'\\n';es&&es.close();$('#br_go').disabled=false;};
    const xhr=new XMLHttpRequest();xhr.open('POST','/api/broll/analyze');
    xhr.upload.onprogress=(e)=>{if(!e.lengthComputable)return;const pct=Math.round(e.loaded/e.total*100);
      const last=L.textContent.split('\\n').slice(-1)[0];const line='Uploading… '+pct+'%';
      if(last.indexOf('Uploading')===0){L.textContent=L.textContent.replace(/Uploading[^\\n]*$/,line);}
      else{L.textContent+=line+'\\n';}L.scrollTop=L.scrollHeight;};
    xhr.upload.onerror=()=>fail('Upload failed mid-transfer.');
    xhr.onerror=()=>fail('Network error reaching the server.');
    xhr.onload=()=>{const ok=xhr.status>=200&&xhr.status<300;
      if(ok){try{brStamp=(JSON.parse(xhr.responseText||'{}').stamp)||'';}catch{brStamp='';}ctl.start();return;}
      let msg='';try{msg=(JSON.parse(xhr.responseText||'{}').error)||'';}catch{}
      fail(msg||('Server returned '+xhr.status));};
    xhr.send(fd);
  };
  async function loadStoryboard(){
    if(!brStamp){loadSets();return;}
    try{brSet=await fetch('/api/broll/set/'+encodeURIComponent(brStamp)).then(r=>r.json());}catch{brSet=null;}
    if(!brSet||!brSet.shots){alert('Could not load the storyboard.');return;}
    renderStoryboard();
  }
  function renderStoryboard(){
    const m=brSet.meta||{},shots=brSet.shots||[];
    const scriptBlock=m.script
      ? '<details style="margin:0 0 14px"><summary style="cursor:pointer;color:var(--gold);font-size:13px">Drafted script (click to read)</summary>'
        +'<div class="muted" style="white-space:pre-wrap;font-size:13px;margin-top:8px;line-height:1.6">'+bresc(m.script)+'</div></details>'
      : '';
    const sc=(m.sessionCharacter&&m.sessionCharacter[0])||'';
    const charPrev=sc
      ? '<img src="/broll-char/'+encodeURIComponent(brStamp)+'/character.png?t='+Date.now()+'" style="width:120px;height:auto;border-radius:8px;border:1px solid var(--line)">'
      : '';
    const charCard=
      '<div class="card" style="margin:0 0 14px;padding:14px 16px;border-left:3px solid '+(sc?'#7ee787':'var(--gold)')+'">'
      +'<div style="font-size:14px;font-weight:600;margin-bottom:4px">Character '
      +(sc?'<span style="color:#7ee787;font-size:12px;font-weight:500">✓ ready — used in person scenes</span>':'<span class="muted" style="font-size:12px;font-weight:400">(optional)</span>')+'</div>'
      +'<div class="muted" style="font-size:12px;margin-bottom:10px">'+(m.charDetected?'Some scenes feature a person. ':'')
      +'Reference photos are <b style="color:var(--txt)">optional</b> — upload a few to lock a real person, or just describe the character, or leave both blank and the AI invents one that fits the story. Either way it makes ONE consistent character to reuse across scenes. Regenerate until it looks right.</div>'
      +'<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">'
      +(charPrev?'<div>'+charPrev+'</div>':'')
      +'<div style="flex:1;min-width:220px">'
      +'<label class="muted" style="font-size:11px">Reference photos (optional)</label>'
      +'<input type="file" id="br_char_refs" accept="image/*" multiple style="font-size:12px">'
      +'<textarea id="br_char_desc" placeholder="Describe the character (optional) — e.g. a tired 30s Filipina mom, warm eyes, simple house clothes" style="min-height:60px;margin-top:8px;font-size:12px"></textarea>'
      +'<div style="margin-top:10px"><button class="go" id="br_char_go" style="padding:8px 14px;font-size:12px">'+(sc?'Regenerate character':'Generate character')+'</button></div>'
      +'<div id="br_char_msg" class="muted" style="font-size:11px;margin-top:6px"></div>'
      +'</div></div></div>';
    const cards=shots.map(sh=>
      '<div class="card" style="margin:10px 0;padding:14px 16px">'
      +'<div style="font-size:14px;font-weight:600">'+sh.n+'. '+bresc(sh.title)
      +(sh.usesCharacter?' <span class="pill" style="background:#1c1f26;color:#b48bff">character</span>':'')
      +(sh.timecode?' <span class="muted" style="font-size:11px;font-weight:400">'+bresc(sh.timecode)+'</span>':'')+'</div>'
      +'<div class="muted" style="font-size:12px;font-style:italic;margin:4px 0 10px">'+bresc(sh.beat)+'</div>'
      +'<div style="font-size:10px;color:#7cc4ff;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">First-frame prompt</div>'
      +'<div class="muted" style="font-size:12px;margin-bottom:8px;white-space:pre-wrap">'+bresc(sh.imagePrompt)+'</div>'
      +'<div style="font-size:10px;color:#b48bff;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Video prompt</div>'
      +'<div class="muted" style="font-size:12px;white-space:pre-wrap">'+bresc(sh.videoPrompt)+'</div>'
      +'</div>').join('');
    $('#br_input').style.display='none';
    $('#br_story').innerHTML=
      '<div class="bx-row" style="margin-bottom:10px"><b>Storyboard — '+shots.length+' scene(s) · '+bresc(m.aspect||'')+'</b>'
      +'<span><button class="sec" id="br_back">← Back</button> '
      +'<button class="go" id="br_frames">Generate first frames →</button></span></div>'
      +scriptBlock+charCard+cards
      +'<p style="margin:14px 0 0;text-align:right"><button class="go" id="br_frames2">Generate first frames →</button></p>';
    $('#br_back').onclick=()=>{$('#br_story').innerHTML='';$('#br_input').style.display='';};
    $('#br_frames').onclick=onFrames;$('#br_frames2').onclick=onFrames;
    const cg=$('#br_char_go');
    if(cg)cg.onclick=()=>{
      const inp=$('#br_char_refs');const files=inp&&inp.files?[].slice.call(inp.files):[];
      const dq=$('#br_char_desc');const desc=(dq&&dq.value||'').trim();
      const fd=new FormData();files.forEach(f=>fd.append('ref',f));if(desc)fd.append('description',desc);
      const L=$('#br_log');L.style.display='block';L.textContent='Generating character…\\n';
      cg.disabled=true;const msg=$('#br_char_msg');if(msg)msg.textContent=files.length?'Uploading & generating…':'Generating…';
      const ctl=brStreamLog(L,(ok)=>{if(ok){loadStoryboard();}else{cg.disabled=false;if(msg)msg.textContent='Generation failed — see the log.';}});
      fetch('/api/broll/character?stamp='+encodeURIComponent(brStamp),{method:'POST',body:fd})
        .then(r=>r.json().then(j=>({ok:r.ok,j:j})))
        .then(o=>{if(o.ok){ctl.start();}else{alert((o.j&&o.j.error)||'Could not start character generation');cg.disabled=false;es&&es.close();}})
        .catch(()=>{alert('Network error');cg.disabled=false;es&&es.close();});
    };
  }
  function onFrames(){
    if(!brStamp)return;
    const L=$('#br_log');L.style.display='block';L.textContent='Generating first frames…\\n';
    document.querySelectorAll('#br_frames,#br_frames2').forEach(b=>{b.disabled=true;});
    const ctl=brStreamLog(L,(ok)=>{
      document.querySelectorAll('#br_frames,#br_frames2').forEach(b=>{if(b)b.disabled=false;});
      if(ok){toast('Frames ready');$('#br_story').innerHTML='';$('#br_input').style.display='';
        _apiCache.delete('/api/broll/sets');loadSets();
        const s=document.getElementById('br_sets');if(s)s.scrollIntoView({behavior:'smooth'});}});
    fetch('/api/broll/frames?stamp='+encodeURIComponent(brStamp),{method:'POST'})
      .then(r=>r.json().then(j=>({ok:r.ok,j:j})))
      .then(o=>{if(o.ok){ctl.start();}else{alert((o.j&&o.j.error)||'Could not start frame generation');
        document.querySelectorAll('#br_frames,#br_frames2').forEach(b=>{if(b)b.disabled=false;});es&&es.close();}})
      .catch(()=>{alert('Network error');document.querySelectorAll('#br_frames,#br_frames2').forEach(b=>{if(b)b.disabled=false;});es&&es.close();});
  }
  $('#br_ref').onclick=()=>{_apiCache.delete('/api/broll/sets');loadSets();};
  async function loadSets(){
    const sets=(await api('/api/broll/sets')).filter(S=>(((S.meta&&S.meta.mode)||'broll')===mode));
    if(!sets.length){$('#br_sets').innerHTML='<p class="muted">'+(isStory?'No video projects yet.':'No b-roll sets yet.')+'</p>';return;}
    $('#br_sets').innerHTML=sets.map(S=>{
      const m=S.meta||{};
      const shots=S.shots.map(sh=>{
        const a='/broll-asset/'+encodeURIComponent(S.stamp)+'/shot-'+String(sh.n).padStart(2,'0')+'.png';
        const img=sh.hasFrame
          ?'<figure><img loading="lazy" style="width:100%;height:300px;object-fit:contain;background:#0d0d0f;display:block" src="'+a+'"><a class="dl" href="'+a+'?dl=1" download>↓ PNG</a></figure>'
          :'<figure><div class="frame ph" style="height:300px;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:11px">no frame</div></figure>';
        return '<div style="margin-bottom:14px;min-width:0">'+img
         +'<div style="margin-top:8px;font-size:13px;font-weight:600">'+sh.n+'. '+(sh.title||'').replace(/[<>]/g,'')
         +(sh.usesCharacter?' <span class="charbadge" style="background:#1c1f26;color:#b48bff;font-size:9px;padding:2px 7px;border-radius:4px;text-transform:uppercase">char</span>':'')+'</div>'
         +(sh.timecode?'<div class="muted" style="font-size:11px">'+sh.timecode+'</div>':'')
         +'<div class="muted" style="font-size:11px;margin:4px 0 6px">'+(sh.beat||'').replace(/[<>]/g,'')+'</div>'
         +'<label style="display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--txt);margin:0 0 6px">'
         +'<input type="checkbox" class="br_pick" data-n="'+sh.n+'"'+(sh.picked?' checked':'')+' style="width:auto">pick</label><br>'
         +'<button class="sec br_cp" data-t="img" data-s="'+S.stamp+'" data-n="'+sh.n+'" style="font-size:11px;padding:6px 10px">Copy image prompt</button> '
         +'<button class="sec br_cp" data-t="vid" data-s="'+S.stamp+'" data-n="'+sh.n+'" style="font-size:11px;padding:6px 10px">Copy Veo prompt</button>'
         +'</div>';
      }).join('');
      return '<div class="card"><div class="bx-row"><b>'+fmtStamp(S.stamp)+'</b>'
       +'<span><span class="pill">'+S.shots.length+' shots</span>'
       +'<span class="pill">'+(m.aspect||'')+'</span>'
       +'<span class="pill">'+(m.charMode==='reference-image'?'character':'no character')+'</span>'
       +(S.hasHtml?' <a class="sec" style="text-decoration:none" target="_blank" href="/broll-asset/'+encodeURIComponent(S.stamp)+'/broll.html">Open HTML</a>':'')
       +' <a class="sec" style="text-decoration:none" href="/api/broll/zip?stamp='+encodeURIComponent(S.stamp)+'">⬇ All (.zip)</a>'
       +' <button class="go br_save" data-s="'+S.stamp+'" style="padding:8px 14px;font-size:12px">Save picks</button></span></div>'
       +'<div class="grid" style="margin-top:14px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">'+shots+'</div></div>';
    }).join('');
    document.querySelectorAll('.br_cp').forEach(b=>b.onclick=()=>{
      const S=sets.find(x=>x.stamp===b.dataset.s),sh=S&&S.shots.find(y=>y.n==b.dataset.n);
      if(!sh)return;const txt=b.dataset.t==='img'?sh.imagePrompt:sh.videoPrompt;
      navigator.clipboard.writeText(txt||'').then(()=>{const o=b.textContent;
        b.textContent='Copied';setTimeout(()=>b.textContent=o,1200);});});
    document.querySelectorAll('.br_save').forEach(b=>b.onclick=async()=>{
      const card=b.closest('.card');
      const picks=[...card.querySelectorAll('.br_pick:checked')].map(c=>+c.dataset.n);
      const r=await fetch('/api/broll/pick',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({stamp:b.dataset.s,picks})});
      if(r.ok)toast(picks.length+' shot(s) picked & saved');});
  }
  loadSets();
}
// ── Lightbox ──────────────────────────────────────────────────────────────────
window._lbItems=[];
let _lbIdx=0;
function _lbShow(){
  const it=window._lbItems[_lbIdx]||{};
  const el=document.getElementById('lb');if(!el)return;
  document.getElementById('lb-img').src=it.url||'';
  document.getElementById('lb-cap').textContent=it.caption||'';
  const dlEl=document.getElementById('lb-dl');
  if(dlEl){const fn=(it.url||'').split('/').pop();dlEl.href=(it.url||'')+'?dl=1';dlEl.download=fn||'poster.png';}
  const n=window._lbItems.length;
  const ctr=document.getElementById('lb-counter');
  if(ctr)ctr.textContent=n>1?(_lbIdx+1)+' / '+n:'';
  const showNav=n>1;
  const prev=document.getElementById('lb-prev'),next=document.getElementById('lb-next');
  if(prev)prev.style.display=showNav?'flex':'none';
  if(next)next.style.display=showNav?'flex':'none';
  el.style.display='flex';
  document.body.style.overflow='hidden';
}
function openLb(idx,items){
  if(items)window._lbItems=items;
  _lbIdx=(idx||0);
  _lbShow();
}
function closeLb(){
  const el=document.getElementById('lb');if(el)el.style.display='none';
  document.body.style.overflow='';
}
function lbNav(dir){
  const n=window._lbItems.length;if(!n)return;
  _lbIdx=(_lbIdx+dir+n)%n;
  _lbShow();
}
document.addEventListener('keydown',function(e){
  const lb=document.getElementById('lb');
  if(!lb||lb.style.display==='none')return;
  if(e.key==='Escape')closeLb();
  else if(e.key==='ArrowLeft')lbNav(-1);
  else if(e.key==='ArrowRight')lbNav(1);
});
window.openLb=openLb;window.closeLb=closeLb;window.lbNav=lbNav;

boot();
</script>
<div id="lb" onclick="if(event.target===this)closeLb()" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.92);align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:20px 60px">
  <button onclick="closeLb()" style="position:fixed;top:14px;right:16px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:18px;line-height:1;width:40px;height:40px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2">✕</button>
  <button id="lb-prev" onclick="lbNav(-1)" style="position:fixed;left:12px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:26px;line-height:1;width:48px;height:48px;border-radius:50%;cursor:pointer;align-items:center;justify-content:center;display:none;z-index:2">‹</button>
  <img id="lb-img" src="" alt="poster" style="max-width:min(90vw,520px);max-height:80vh;width:auto;height:auto;object-fit:contain;border-radius:10px;box-shadow:0 10px 80px rgba(0,0,0,.9);display:block">
  <div id="lb-cap" style="max-width:520px;width:100%;text-align:center;font-size:12px;color:rgba(255,255,255,.5);line-height:1.6;padding:0 8px"></div>
  <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;justify-content:center">
    <a id="lb-dl" download style="font-size:11px;color:rgba(255,255,255,.45);text-decoration:none;padding:5px 14px;border:1px solid rgba(255,255,255,.15);border-radius:6px">⬇ Download</a>
    <span id="lb-counter" style="font-size:11px;color:rgba(255,255,255,.3)"></span>
  </div>
  <button id="lb-next" onclick="lbNav(1)" style="position:fixed;right:12px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:26px;line-height:1;width:48px;height:48px;border-radius:50%;cursor:pointer;align-items:center;justify-content:center;display:none;z-index:2">›</button>
</div>
</body></html>`;
