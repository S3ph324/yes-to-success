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
import express from "express";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import multer from "multer";
import path from "node:path";
import url from "node:url";
import { registerTryonRoutes } from "./tryon-routes.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const cfgDir = path.join(projectRoot, "config");
const publicDir = path.join(projectRoot, "public");

// Shown in the header as a deploy signal — bump package.json on each change.
let VERSION = "?";
try {
  VERSION = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
} catch {
  /* leave "?" */
}

const PORT = parseInt(
  process.env.PORT || process.env.JURIE_DASHBOARD_PORT || "4317",
  10,
);
const HOSTED = process.env.HOSTED === "1";
// When hosting, outputs go here (writable volume) instead of the local Mac
// client folders. Per-client = EXPORT_BASE/<clientId>; b-roll = EXPORT_BASE/broll.
const EXPORT_BASE = process.env.EXPORT_BASE || "";

const app = express();
app.set("trust proxy", true);
app.use(express.json());

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
const writeCfg = (name, data) =>
  fs.writeFile(path.join(cfgDir, name), JSON.stringify(data, null, 2));

const getClients = () => readCfg("clients.json", []);
const getClient = async (id) =>
  (await getClients()).find((c) => c.id === id) || null;

// ── Queue helpers ─────────────────────────────────────────────────────────
const queuePath  = (clientId) => path.join(cfgDir, `queue-${clientId}.json`);
const readQueue  = async (clientId) => {
  try { return JSON.parse(await fs.readFile(queuePath(clientId), "utf-8")); }
  catch { return []; }
};
const writeQueue = (clientId, data) =>
  fs.writeFile(queuePath(clientId), JSON.stringify(data, null, 2));

async function addBatchToQueue(clientId, batchDir, stamp) {
  try {
    const pngs = (await fs.readdir(batchDir)).filter(f => f.endsWith(".png")).sort();
    let captText = "";
    try { captText = await fs.readFile(path.join(batchDir, "captions.txt"), "utf-8"); } catch {}
    const captions = captText.split(/^-{20,}\s*$/m)
      .map(s => s.replace(/^#\d+\s*/m, "").trim()).filter(Boolean);
    const posters = pngs.map((filename, i) => ({
      filename, caption: captions[i] || "", status: "pending",
    }));
    const queue = await readQueue(clientId);
    const entry = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      stamp, clientId,
      createdAt: new Date().toISOString(),
      posters, sentAt: null, scheduledStart: null, spacingMinutes: 60,
    };
    queue.unshift(entry);
    if (queue.length > 30) queue.splice(30);
    await writeQueue(clientId, queue);
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
  const queue = await readQueue(client);
  const entry = queue.find(e => e.id === queueId);
  if (!entry) return res.status(404).json({ error: "Not found" });
  for (const { filename, status } of (decisions || [])) {
    const p = entry.posters.find(x => x.filename === filename);
    if (p) p.status = status;
  }
  await writeQueue(client, queue);
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

  const queue = await readQueue(client);
  const entry = queue.find(e => e.id === queueId);
  if (!entry) return res.status(404).json({ error: "Queue entry not found" });
  const approved = entry.posters.filter(p => p.status === "approved");
  if (!approved.length) return res.status(400).json({ error: "No approved posters to send" });

  // Build the schedule using strategy slots
  const sd = startDate || new Date().toISOString().slice(0, 10);
  const timestamps = buildPostSchedule(strategy || "standard", sd, approved.length);
  const studioUrl = STUDIO_URL();
  let sent = 0, failed = 0;
  const bufferPostIds = [];

  for (let i = 0; i < approved.length; i++) {
    const p = approved[i];
    const imageUrl = `${studioUrl}/posters/${client}/${encodeURIComponent(entry.stamp)}/${encodeURIComponent(p.filename)}`;
    try {
      const post = await bufferPost(channelId, imageUrl, p.caption, timestamps[i]);
      p.status = "sent";
      if (post?.id) bufferPostIds.push(post.id);
      sent++;
    } catch (err) {
      console.warn(`Buffer send failed ${p.filename}:`, err.message);
      failed++;
    }
    if (i < approved.length - 1) await new Promise(r => setTimeout(r, 400));
  }
  entry.sentAt = new Date().toISOString();
  entry.strategy = strategy || "standard";
  entry.startDate = sd;
  entry.bufferPostIds = bufferPostIds;
  await writeQueue(client, queue);
  res.json({ ok: true, sent, failed, timestamps, bufferPostIds });
});

app.delete("/api/queue/:queueId", async (req, res) => {
  const { client } = req.query;
  const queue = await readQueue(client);
  const filtered = queue.filter(e => e.id !== req.params.queueId);
  await writeQueue(client, filtered);
  res.json({ ok: true });
});

// Cancel scheduled Buffer posts for a queue entry (delete them from Buffer).
app.post("/api/queue/cancel", async (req, res) => {
  const { client, queueId } = req.body || {};
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "BUFFER_API_KEY not configured" });
  const queue = await readQueue(client);
  const entry = queue.find(e => e.id === queueId);
  if (!entry) return res.status(404).json({ error: "Queue entry not found" });
  const postIds = entry.bufferPostIds || [];
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
  for (const p of entry.posters) {
    if (p.status === "sent") p.status = "approved";
  }
  entry.sentAt = null;
  entry.bufferPostIds = [];
  await writeQueue(client, queue);
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
app.get("/api/charphoto", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("characters/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "characters")))
    return res.status(400).end();
  res.sendFile(fp, ASSET_CACHE);
});

// Serve a brand-kit logo for preview.
app.get("/api/brandlogo", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("brand/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "brand")))
    return res.status(400).end();
  res.sendFile(fp, ASSET_CACHE);
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

const photoStore = multer.diskStorage({
  destination: async (req, _f, cb) => {
    const client = req.query.client || "misc";
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
    const { client, charId } = req.query;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });
    const paths = files.map((f) =>
      path.posix.join("characters", client, f.filename),
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

const glassPhotoStore = multer.diskStorage({
  destination: async (req, _f, cb) => {
    const client = req.query.client || "misc";
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
    const { client, glassesId } = req.query;
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files" });
    const paths = files.map((f) =>
      path.posix.join("eyeglasses", client, f.filename),
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
  res.sendFile(fp, ASSET_CACHE);
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

// Force-clear a stuck lock (called by the UI "Unlock" button).
app.post("/api/clear-job", (_q, res) => {
  if (jobTimer) { clearTimeout(jobTimer); jobTimer = null; }
  if (job?.child) { try { job.child.kill("SIGTERM"); } catch {} }
  if (job) { job.running = false; job.code = -99; }
  res.json({ ok: true });
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

app.post("/api/generate", extraRefUpload.array("extraRef", 8), async (req, res) => {
  if (job?.running)
    return res.status(409).json({ error: "A batch is already running." });
  const {
    client,
    topic,
    count,
    briefId,
    brandPresetId,
    characterId,
    useLogo,
    bufferAutopost,
    posterType,
    eyeglassesId,
    eyeglassesStyle,
    aspectDist,
  } = req.body || {};
  const c = await getClient(client);
  if (!c) return res.status(400).json({ error: "Unknown client" });
  const t = String(topic || "").trim().slice(0, 200);
  let n = parseInt(count, 10);
  if (!Number.isFinite(n)) n = 8;
  n = Math.max(1, Math.min(200, n));
  if (!t) return res.status(400).json({ error: "Topic is required." });
  if (!guard(req, res)) return;

  const extraRefPaths = (req.files || []).map((f) => f.path);

  // Eyeglasses showcase batches are Tranzzie-only and run a separate
  // orchestrator (different content-gen voice + reference-asset source) that
  // still funnels into the same render-batch-jurie.mjs at the end.
  const isEyeglasses = client === "tranzzie" && posterType === "eyeglasses";
  const glassesId = String(eyeglassesId || "");
  const glassesStyle = String(eyeglassesStyle || "showcase");

  job = { running: true, client, log: [], code: null };
  log(
    `▶ [${c.label}] ${n} ${isEyeglasses ? "eyeglasses showcase " : ""}poster(s) about "${t}"` +
      (isEyeglasses ? ` · frame ${glassesId || "(none selected)"}` : "") +
      (extraRefPaths.length ? ` · ${extraRefPaths.length} extra ref(s)` : "") +
      (useLogo === "1" ? " · with logo" : " · no logo") +
      "…",
  );
  const env = { ...process.env };
  if (EXPORT_BASE) env.JURIE_EXPORT_DIR = path.join(EXPORT_BASE, client);
  if (briefId) env.DASHBOARD_BRIEF_ID = briefId;
  if (brandPresetId) env.DASHBOARD_BRAND_PRESET_ID = brandPresetId;
  if (isEyeglasses) {
    env.DASHBOARD_EYEGLASSES_ID = glassesId;
    env.DASHBOARD_EYEGLASSES_STYLE = glassesStyle;
  } else if (characterId !== undefined) {
    env.DASHBOARD_CHARACTER_ID = characterId;
  }
  if (useLogo !== "1") env.DASHBOARD_NO_LOGO = "1";
  if (bufferAutopost === "1") env.BUFFER_AUTOPOST = "1";
  if (extraRefPaths.length)
    env.DASHBOARD_EXTRA_REFS = JSON.stringify(extraRefPaths);
  if (aspectDist) env.DASHBOARD_ASPECT_DIST = String(aspectDist);
  env.JURIE_NO_OPEN = "1";
  const child = spawn(
    "node",
    isEyeglasses
      ? ["scripts/batch-eyeglasses-tranzzie.mjs", String(n), t]
      : ["scripts/batch-jurie.mjs", "--client", client, String(n), t],
    { cwd: projectRoot, env },
  );
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
        const clientCfg = await getClient(client);
        if (clientCfg) {
          const expDir = clientExportDir(clientCfg);
          const stamps = (await fs.readdir(expDir)).filter(safeStamp).sort().reverse();
          if (stamps[0]) {
            written = (await fs.readdir(path.join(expDir, stamps[0])))
              .filter((f) => f.endsWith(".png")).length;
          }
        }
      } catch { /* filesystem unavailable — still show done */ }
      if (written > 0) {
        log(`✓ Done — ${written} poster(s) ready. Added to Queue for review.`);
        // Auto-add to queue for approval before posting.
        try {
          const clientCfg = await getClient(client);
          if (clientCfg) {
            const expDir = clientExportDir(clientCfg);
            const stamps2 = (await fs.readdir(expDir)).filter(safeStamp).sort().reverse();
            if (stamps2[0]) {
              await addBatchToQueue(client, path.join(expDir, stamps2[0]), stamps2[0]);
              log("📋 Batch added to Queue tab — review and schedule from there.");
            }
          }
        } catch (qErr) { console.warn("Queue add error:", qErr.message); }
      } else {
        log("✓ Done. Check Batches tab (no PNGs found — Gemini may have had an error above).");
      }
    } else {
      log(`✗ Exited (${code}). Check the log above for the error.`);
    }
  });
  res.json({ ok: true });
});

// ── Batches / posters (per client export dir) ─────────────────────────────
const safeStamp = (s) => /^[0-9T:\-]+$/.test(s);
const clientExportDir = (c) =>
  EXPORT_BASE ? path.join(EXPORT_BASE, c.id) : c.exportDir;

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

  const queue = await readQueue(client);
  let entry = queue.find(e => e.stamp === stamp);
  if (!entry) {
    // Create a queue entry for this batch on the fly.
    try {
      const batchDir = path.join(clientExportDir(clientCfg), stamp);
      const pngs = (await fs.readdir(batchDir)).filter(f => f.endsWith(".png")).sort();
      let captText = "";
      try { captText = await fs.readFile(path.join(batchDir, "captions.txt"), "utf-8"); } catch {}
      const captions = captText.split(/^-{20,}\s*$/m)
        .map(s => s.replace(/^#\\d+\\s*/m, "").trim()).filter(Boolean);
      entry = {
        id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        stamp, clientId: client,
        createdAt: new Date().toISOString(),
        posters: pngs.map((fn, i) => ({ filename: fn, caption: captions[i] || "", status: "pending" })),
        sentAt: null, scheduledStart: null, spacingMinutes: 60,
      };
      queue.unshift(entry);
    } catch (err) {
      return res.status(500).json({ error: "Could not read batch: " + err.message });
    }
  }
  let poster = entry.posters.find(p => p.filename === filename);
  if (!poster) {
    poster = { filename, caption: "", status };
    entry.posters.push(poster);
  } else {
    poster.status = status;
  }
  await writeQueue(client, queue);
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
  res.sendFile(fp, ASSET_CACHE);
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

// DELETE an entire batch folder
app.delete("/api/batch", async (req, res) => {
  const { client, stamp } = req.query;
  const c = await getClient(client);
  if (!c || !safeStamp(stamp)) return res.status(400).json({ error: "bad request" });
  const dir = path.join(clientExportDir(c), stamp);
  if (!dir.startsWith(clientExportDir(c))) return res.status(400).json({ error: "bad path" });
  try { await fs.rm(dir, { recursive: true, force: true }); res.json({ ok: true }); }
  catch { res.status(404).json({ error: "Batch not found" }); }
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
    if (req.file) {
      args.push("--video", req.file.path);
    } else if (scriptText.length > 10) {
      const sf = path.join(
        projectRoot,
        "out",
        `broll-input-${Date.now()}.txt`,
      );
      await fs.writeFile(sf, scriptText);
      args.push("--script", sf);
    } else {
      return res
        .status(400)
        .json({ error: "Provide a script (10+ chars) or a video file." });
    }
    if (!guard(req, res)) return;
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
  res.sendFile(fp, ASSET_CACHE);
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
  zp.on("error", () =>
    res.status(500).json({ error: "zip not available on server" }),
  );
  zp.on("close", (code) => {
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
app.get("/", (_q, res) => res.type("html").send(PAGE));

// ── Try-On sub-site (/tryon) ──────────────────────────────────────────────
registerTryonRoutes(app, { EXPORT_BASE, guard });

app.listen(PORT, () =>
  console.log(`\n  Quote Poster Studio → http://localhost:${PORT}\n  Try-On         → http://localhost:${PORT}/tryon\n`),
);

// ── UI ────────────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quote Poster Studio</title><style>
:root{--gold:#E8B64A;--gold2:#ffe27a;--red:#E0564B;--bg:#0a0a0b;--panel:#121214;
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:18px}
figure{margin:0;background:#0d0d0f;border:1px solid var(--line);border-radius:12px;overflow:hidden;
position:relative;transition:border-color .2s}
figure:hover{border-color:var(--line2)}
figure img{width:100%;display:block;aspect-ratio:4/5;object-fit:cover}
.dl,.cp{position:absolute;top:9px;background:rgba(0,0,0,.6);color:#fff;
border:1px solid rgba(255,255,255,.2);text-decoration:none;font-size:11px;font-weight:600;
padding:6px 11px;border-radius:7px;opacity:0;transition:opacity .18s,background .15s;
backdrop-filter:blur(4px);cursor:pointer;font-family:inherit}
.dl{right:9px}.cp{left:9px}
figure:hover .dl,figure:hover .cp{opacity:1}
.dl:hover,.cp:hover{background:var(--gold);color:#15120a;border-color:var(--gold)}
figcaption{padding:12px 13px;font-size:11px;line-height:1.55;color:var(--mut);
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
  .grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .result-grid{grid-template-columns:repeat(2,1fr);gap:10px}
  .bx-head{flex-direction:column;align-items:flex-start;gap:10px}
  .bx-row{flex-direction:column;align-items:flex-start;gap:8px}
  button.go{width:100%;padding:14px}
  .opts-grid{grid-template-columns:1fr 1fr}
  figure img{aspect-ratio:3/4}
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
</style></head><body>
<header><b>QUOTE&nbsp;POSTER&nbsp;<i>STUDIO</i></b>
<span class="pill" title="deployed version">v${VERSION}</span><span class="sp"></span>
<div class="sw">Client <select id="client"></select></div>
<span class="pill">manual posting</span> <a href="/tryon" style="font-size:11px;color:var(--mut);text-decoration:none;border:1px solid var(--line2);padding:4px 10px;border-radius:6px;margin-left:4px;transition:color .14s,border-color .14s" onmouseover="this.style.color=\'var(--gold)\';this.style.borderColor=\'var(--gold)\'" onmouseout="this.style.color=\'var(--mut)\';this.style.borderColor=\'var(--line2)\'">🕶️ Try-On</a></header>
<div id="toast"></div>
<main>
<nav id="nav"></nav>
<div id="view"></div>
</main>
<script>
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
  _apiCache.set(u,{t:Date.now(),p});
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
function goBatches(){TAB='batches';render();}
function toggleAdv(){const b=document.getElementById('adv-btn'),d=document.getElementById('adv-body');if(b)b.classList.toggle('open');if(d)d.classList.toggle('open');}
async function buildNav(){
  const tabs=[['generate','⚡ Generate'],['batches','📂 Batches'],['queue','✅ Queue'],['broll','🎬 B-Roll'],['brand','🎨 Brand'],['topics','📝 Topics'],['chars','👤 Characters']];
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
}
let es;
async function viewGenerate(){
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
       +'</div>')
     :'')
   // ── Primary form ──
   +'<div class="section-label">What do you want to post about?</div>'
   +'<div class="row" style="gap:12px;margin-bottom:18px">'
   +'<div style="flex:3"><input id="g_topic" placeholder="e.g. why regular eye check-ups matter" style="width:100%;font-size:15px;padding:14px 16px"></div>'
   +'<div style="flex:0 0 100px"><label style="font-size:11px">Posters</label><input id="g_count" type="number" min="1" max="200" value="8" style="width:100%;text-align:center;font-size:15px;padding:14px 8px"></div>'
   +'</div>'
   // ── Advanced toggle ──
   +'<button class="adv-toggle" id="adv-btn" onclick="toggleAdv()">'
   +'⚙ Advanced settings <span class="muted" style="font-size:11px;margin-left:6px">(topic preset, brand kit, subject, formats)</span></button>'
   +'<div class="adv-body" id="adv-body">'
   +'<div style="border-top:1px solid var(--line);padding-top:16px;margin-top:4px">'
   +'<div class="row" style="margin-bottom:0">'
   +'<div><label>Topic preset</label><select id="g_brief"><option value="">— none —</option>'
   +briefs.map(b=>'<option value="'+b.id+'">'+b.name+'</option>').join('')+'</select>'
   +'<p class="muted" style="margin:5px 0 0;font-size:11px">Loads a saved topic with specific voice notes</p></div>'
   +'<div><label>Brand kit</label><select id="g_brand"><option value="">— default —</option>'
   +brands.map(b=>'<option value="'+b.id+'">'+b.name+'</option>').join('')+'</select>'
   +'<p class="muted" style="margin:5px 0 0;font-size:11px">Colors, logo, and CTA text</p></div></div>'
   +'<div id="g_subjrow"></div>'
   +'<div class="row" style="margin-top:14px;align-items:center">'
   +'<label style="display:inline-flex;gap:8px;align-items:center;cursor:pointer;font-size:13px;color:var(--txt);white-space:nowrap">'
   +'<input type="checkbox" id="g_logo_on" style="width:auto;margin:0"> Include logo</label>'
   +'<div><label style="font-size:11px" id="g_extras_label">Extra reference photos (overrides character for this batch)</label>'
   +'<input id="g_extras" type="file" accept="image/*" multiple></div></div>'
   +'<div id="g_estyle_box" style="display:none;margin-top:16px;padding:14px 16px;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:10px">'
   +'<div class="section-label" style="margin:0 0 12px">Eyeglasses poster type</div>'
   +'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px">'
   +'<label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer;font-size:13px;color:var(--txt);padding:10px 12px;border:1px solid var(--gold);border-radius:9px;background:rgba(232,182,74,.04)">'
   +'<input type="radio" name="g_estyle" value="showcase" checked style="width:auto;margin:3px 0 0;accent-color:var(--gold)">'
   +'<span><b>Product showcase</b> <span style="font-size:9px;background:var(--gold);color:#15120a;padding:1px 5px;border-radius:4px">READY</span><br><span class="muted" style="font-size:11px">Frame as the hero \\u2014 styled photo + tagline</span></span></label>'
   +'<label style="display:flex;align-items:flex-start;gap:9px;font-size:13px;color:var(--mut);padding:10px 12px;border:1px solid var(--line);border-radius:9px;opacity:.5;cursor:not-allowed">'
   +'<input type="radio" name="g_estyle" value="infographic" disabled style="width:auto;margin:3px 0 0">'
   +'<span><b>Infographic</b> <span style="font-size:9px;background:var(--line2);color:var(--mut);padding:1px 5px;border-radius:4px">SOON</span><br><span style="font-size:11px">Feature / benefit breakdown layout</span></span></label>'
   +'<label style="display:flex;align-items:flex-start;gap:9px;font-size:13px;color:var(--mut);padding:10px 12px;border:1px solid var(--line);border-radius:9px;opacity:.5;cursor:not-allowed">'
   +'<input type="radio" name="g_estyle" value="quote" disabled style="width:auto;margin:3px 0 0">'
   +'<span><b>Quote poster</b> <span style="font-size:9px;background:var(--line2);color:var(--mut);padding:1px 5px;border-radius:4px">SOON</span><br><span style="font-size:11px">Testimonial-style with the frame in shot</span></span></label>'
   +'</div></div>'
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
   +'<p style="margin:14px 0;display:flex;align-items:center;gap:14px;flex-wrap:wrap"><button class="go" id="g_go">Generate posters</button>'
   +'<span id="g_unlock" style="display:none"><button class="sec" id="g_unlock_btn" style="border-color:var(--red);color:var(--red)">⚠ Unlock stuck job</button>'
   +'<span class="muted" style="font-size:12px">Another job appears stuck. Click to force-clear the lock.</span></span></p>'
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
  $('#g_brand').onchange=updLogo;
  $('#g_brief').onchange=e=>{const b=briefs.find(x=>x.id===e.target.value);if(b&&b.topics&&b.topics[0])$('#g_topic').value=b.topics[0];};
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
    sel.onchange=updSubjPrev;updSubjPrev();
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
  }
  document.querySelectorAll('input[name="g_ptype"]').forEach(r=>{
    r.onchange=()=>{syncPtypeCards();paintSubject();};
  });
  syncPtypeCards();
  paintSubject();
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
    c.querySelector('.ar-chk').onchange=e=>arToggle(r,e.target.checked);
    c.querySelector('.ar-slider').oninput=e=>arSetValue(r,+e.target.value);
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
    const m=line.match(/\\[(\\d+)\\/(\\d+)\\]/);
    if(m){const i=+m[1],n=+m[2]||1;
      if(phase==='bg'||/\\bbg-/.test(line))return 16+44*(i/n);
      if(phase==='render')return 62+35*(i/n);}
    if(line.indexOf('✓ Done')>-1)return 100;
    return -1;}
  // Check if a job is already running (e.g. user refreshed mid-job or lock is stuck).
  api('/api/status').then(s=>{
    if(s.running){$('#g_go').disabled=true;$('#g_unlock').style.display='inline-flex';$('#g_unlock').style.gap='10px';$('#g_unlock').style.alignItems='center';}
  });
  $('#g_unlock_btn').onclick=async()=>{
    await fetch('/api/clear-job',{method:'POST'});
    $('#g_go').disabled=false;$('#g_unlock').style.display='none';
    toast('Lock cleared — you can generate again.');
  };
  $('#g_go').onclick=async()=>{
    const topic=$('#g_topic').value.trim();
    if(!topic)return toast('Enter a topic first',true);
    const fd=new FormData();
    fd.append('client',CLIENT);
    fd.append('topic',topic);
    fd.append('count',String(+$('#g_count').value||8));
    fd.append('briefId',$('#g_brief').value);
    fd.append('brandPresetId',$('#g_brand').value);
    const posterType=showEyeglasses?curPosterType():'main';
    fd.append('posterType',posterType);
    if(posterType==='eyeglasses'){
      fd.append('eyeglassesId',$('#g_subject')?$('#g_subject').value:'');
      const er=document.querySelector('input[name="g_estyle"]:checked');
      fd.append('eyeglassesStyle',er?er.value:'showcase');
      fd.append('characterId','');
    }else{
      fd.append('characterId',$('#g_subject')?$('#g_subject').value:'');
    }
    fd.append('useLogo',$('#g_logo_on').checked?'1':'0');
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
    $('#g_go').disabled=true;phase='';
    $('#g_log').style.display='block';$('#g_log').textContent='';
    $('#g_prog').style.display='block';
    const gr=$('#g_result');if(gr){gr.style.display='none';gr.innerHTML='';}
    $('#g_bar').style.background='linear-gradient(90deg,var(--gold),#ffe27a)';setProg(2,false);
    es&&es.close();es=new EventSource('/api/log');
    es.onmessage=ev=>{const line=JSON.parse(ev.data),L=$('#g_log');
      L.textContent+=line+'\\n';L.scrollTop=L.scrollHeight;
      if(line.indexOf('✗ Exited')>-1||line.indexOf('⚠ Job timed out')>-1){setProg(100,true);es.close();$('#g_go').disabled=false;$('#g_unlock').style.display='none';return;}
      const p=progFrom(line);if(p>=0)setProg(p,false);
      if(line.indexOf('✓ Done')>-1){es.close();$('#g_go').disabled=false;$('#g_unlock').style.display='none';
        const bad=line.indexOf('no PNGs found')>-1;
        toast(bad?'⚠ Done but no posters found — check log':'Batch complete \\u2713 — check Queue tab',bad);
        if(!bad){showLatestBatch();setTimeout(()=>{TAB='queue';render();},2500);}}};
    const r=await fetch('/api/generate',{method:'POST',body:fd});
    if(!r.ok){const err=(await r.json()).error||'Failed to start';toast(err,true);$('#g_go').disabled=false;$('#g_prog').style.display='none';
      if(err.indexOf('already running')>-1){$('#g_unlock').style.display='inline-flex';$('#g_unlock').style.gap='10px';$('#g_unlock').style.alignItems='center';}}
  };
}
async function showLatestBatch(){
  const wrap=$('#g_result');if(!wrap)return;
  try{
    const batches=await api('/api/batches?client='+CLIENT);
    const B=batches[0];if(!B||!B.files.length){return;}
    const esc=s=>(s||'').replace(/[<>]/g,'');
    const caps=B.captions.split(/^#\\d+\\s*$/m).map(s=>s.trim()).filter(Boolean);
    const posters=B.files.slice(0,12).map((f,i)=>{
      const u='/posters/'+CLIENT+'/'+encodeURIComponent(B.stamp)+'/'+encodeURIComponent(f);
      return '<figure style="margin:0;background:#0d0d0f;border:1px solid rgba(255,255,255,.07);border-radius:12px;overflow:hidden;position:relative">'
        +'<a href="'+u+'" target="_blank"><img src="'+u+'" style="width:100%;display:block;aspect-ratio:4/5;object-fit:cover" loading="lazy"></a>'
        +'<a href="'+u+'?dl=1" download style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;font-weight:600;padding:5px 10px;border-radius:6px;text-decoration:none;backdrop-filter:blur(4px)">↓</a>'
        +(caps[i]?'<div style="padding:10px 12px;font-size:11px;color:rgba(255,255,255,.55);line-height:1.5;max-height:80px;overflow:auto">'+esc(caps[i])+'</div>':'')
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
  $('#view').innerHTML='<div class="card"><h2>\\ud83d\\udd76\\ufe0f Eyeglasses — '+CLIENT+'</h2>'
   +'<p class="muted" style="margin:-4px 0 16px">Frames used as the main subject for Tranzzie eyeglasses-showcase posters. Add reference photos so Gemini can render the actual product instead of a generic pair.</p>'
   +(g.length?g.map((x,i)=>{
     const photos=x.photos||[];
     const first=photos[0];
     const thumb=first
       ?'<img class="thumb" loading="lazy" src="/api/glassesphoto?p='+encodeURIComponent(first)+'">'
       :'<div class="thumb ph">no photo</div>';
     const gallery=photos.length
       ?'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'
         +photos.map((ph)=>'<img class="thumb" loading="lazy" style="width:84px;height:84px" src="/api/glassesphoto?p='+encodeURIComponent(ph)+'">').join('')
         +'</div>'
       :'';
     const detail='<div class="muted" style="font-size:12px;line-height:2">'
       +'<b>ID:</b> '+x.id+'<br>'
       +'<b>Status:</b> '+(x.enabled?'enabled':'disabled')+'<br>'
       +'<b>Reference photos:</b> '+photos.length
       +(x.notes?'<br><b>Notes:</b> '+x.notes:'')
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
       +'<button class="sec asset-del" data-idx="'+i+'" style="color:var(--red);border-color:rgba(224,86,75,.35);flex-shrink:0" title="Delete this frame">Delete</button>'
       +'</div>'
       +'<div class="asset-detail" data-idx="'+i+'" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">'+detail+'</div>'
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
      if(!confirm('Delete frame "'+(item.name||item.id)+'"? This cannot be undone.'))return;
      const r=await fetch('/api/eyeglasses/'+encodeURIComponent(item.id)+'?client='+CLIENT,{method:'DELETE'});
      if(r&&r.ok){toast('Frame deleted');viewGlasses();}
      else toast('Could not delete frame',true);
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
        +entry.posters.map(p=>{
          const st=local[qid]?.[p.filename]||p.status;
          const isApp=st==='approved',isDec=st==='declined';
          return '<div style="border-radius:12px;overflow:hidden;border:2px solid '+(isApp?'var(--gold)':isDec?'var(--red)':'var(--line)')+';background:#0d0d0f;opacity:'+(isDec?'.45':'1')+';transition:all .18s">'
            +'<div style="position:relative"><img src="/posters/'+CLIENT+'/'+encodeURIComponent(entry.stamp)+'/'+encodeURIComponent(p.filename)+'" style="width:100%;display:block;aspect-ratio:4/5;object-fit:cover" loading="lazy">'
            +(isApp?'<div style="position:absolute;top:8px;right:8px;background:var(--gold);color:#15120a;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px">✓ APPROVED</div>':'')
            +(isDec?'<div style="position:absolute;top:8px;right:8px;background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px">✗ DECLINED</div>':'')
            +'</div>'
            +'<div style="padding:8px 10px;font-size:10.5px;color:var(--mut);max-height:70px;overflow:auto;line-height:1.45">'+esc(p.caption).slice(0,140)+'</div>'
            +'<div style="display:flex;padding:0 8px 10px;gap:6px">'
            +'<button class="sec" style="flex:1;font-size:11px;padding:6px 4px;'+(isApp?'border-color:var(--gold);color:var(--gold)':'')+'" onclick="qSS(this)" data-qid="'+qid+'" data-fn="'+encodeURIComponent(p.filename)+'" data-s="approved">'+(isApp?'✓ Approved':'Approve')+'</button>'
            +'<button class="sec" style="flex:1;font-size:11px;padding:6px 4px;'+(isDec?'border-color:var(--red);color:var(--red)':'')+'" onclick="qSS(this)" data-qid="'+qid+'" data-fn="'+encodeURIComponent(p.filename)+'" data-s="declined">'+(isDec?'✗ Declined':'Decline')+'</button>'
            +'</div></div>';
        }).join('')
        +'</div></div>';
    }

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
    const html=ALL.map(B=>{
      const caps=B.captions.split(/^#\\d+\\s*$/m).map(s=>s.trim()).filter(Boolean);
      const stampHit=B.stamp.toLowerCase().indexOf(q)>-1;
      const idx=B.files.map((_f,i)=>i).filter(i=>!q||stampHit||(caps[i]||'').toLowerCase().indexOf(q)>-1);
      if(!idx.length)return '';
      nb++;np+=idx.length;
      const allCaps=idx.map(i=>'#'+(i+1)+'\\n'+(caps[i]||'')).join('\\n\\n---\\n\\n');
      return '<div class="card" data-stamp="'+B.stamp+'"><div class="bx-row"><b>'+fmtStamp(B.stamp)+'</b>'
       +'<span><span class="pill">'+idx.length+(idx.length!==B.count?(' / '+B.count):'')+' posters</span> '
       +'<button class="sec" data-cp-all="'+b64(allCaps)+'">📋 All captions</button> '
       +'<a class="sec" style="text-decoration:none" href="/api/batch-zip?client='+CLIENT+'&stamp='+encodeURIComponent(B.stamp)+'">⬇ All (.zip)</a>'
       +' <button class="sec del-batch" data-stamp="'+B.stamp+'" style="color:var(--red);border-color:rgba(224,86,75,.35)" title="Delete this entire batch">🗑 Delete batch</button>'
       +'</span></div>'
       +'<div class="grid" style="margin-top:14px">'+idx.map(i=>{
         const f=B.files[i],u='/posters/'+CLIENT+'/'+encodeURIComponent(B.stamp)+'/'+encodeURIComponent(f);
         const st=(B.statuses&&B.statuses[f])||'pending';
         const badgeHtml=st==='approved'?'<div class="ps-badge" style="background:var(--gold);color:#15120a">✓ Approved</div>'
           :st==='posted'?'<div class="ps-badge" style="background:#3cb454;color:#fff">✓ Posted</div>'
           :st==='declined'?'<div class="ps-badge" style="background:var(--red);color:#fff">✗ Declined</div>':'';
         return '<figure data-stamp="'+B.stamp+'" data-file="'+encodeURIComponent(f)+'" style="opacity:'+(st==='declined'?'.4':'1')+';transition:opacity .2s">'
          +badgeHtml
          +'<a href="'+u+'" target="_blank" rel="noopener" title="Open full size"><img loading="lazy" src="'+u+'"></a>'
          +'<button class="cp" data-c="'+b64(caps[i]||'')+'" title="Copy caption">📋</button>'
          +'<a class="dl" href="'+u+'?dl=1" download>↓</a>'
          +'<figcaption>'+(esc(caps[i])||'—')+'</figcaption>'
          +'<div class="ps-actions">'
          // Row 1: primary approve/decline
          +'<div class="ps-row">'
          +'<button class="ps-btn ps-approve'+(st==='approved'?' ps-on-gold':'')+'" data-stamp="'+B.stamp+'" data-fn="'+encodeURIComponent(f)+'" data-s="approved">'+(st==='approved'?'✓ Approved':'✓ Approve')+'</button>'
          +'<button class="ps-btn ps-decline'+(st==='declined'?' ps-on-red':'')+'" data-stamp="'+B.stamp+'" data-fn="'+encodeURIComponent(f)+'" data-s="declined">'+(st==='declined'?'✗ Declined':'✗ Decline')+'</button>'
          +'</div>'
          // Row 2: secondary — mark posted + delete
          +'<div class="ps-row">'
          +'<button class="ps-btn ps-btn-secondary ps-posted'+(st==='posted'?' ps-on-green':'')+'" style="flex:3" data-stamp="'+B.stamp+'" data-fn="'+encodeURIComponent(f)+'" data-s="posted">'+(st==='posted'?'✓ Posted':'Already posted')+'</button>'
          +'<button class="ps-btn ps-btn-secondary del-poster" style="flex:1" data-stamp="'+B.stamp+'" data-file="'+encodeURIComponent(f)+'" title="Delete poster">🗑</button>'
          +'</div>'
          +'</div></figure>';}).join('')
       +'</div></div>';}).join('');
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
  $('#bx_ref').onclick=viewBatches;
  $('#bx_open').onclick=()=>{fetch('/api/reveal',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client:CLIENT})});toast('Opening export folder…');};
  paint();
}
async function viewBroll(){
  const [chars,ENV]=await Promise.all([
    api('/api/characters'),
    api('/api/env').catch(()=>({})),
  ]);
  let src='script';
  const charOpts='<option value="none">— none (scenes only) —</option>'
   +chars.map(c=>'<option value="'+c.id+'">'+c.name+' ('+c.client+', '
    +((c.photos||[]).length)+' photo'+(((c.photos||[]).length)===1?'':'s')+')</option>').join('');
  $('#view').innerHTML=
   '<div class="card"><h2>B-Roll Maker</h2>'
   +'<div class="muted" style="margin:-6px 0 16px">Paste a script or upload a video — the AI finds the beats and writes paired '
   +'Nano Banana (first frame) + Veo 3.1 prompts, then renders every first frame. You pick the keepers. '
   +'Veo auto-animation is wired but OFF for now.</div>'
   +'<div class="bx-tools" style="margin-bottom:14px">'
   +'<button class="sec" id="br_t_s">Script</button>'
   +'<button class="sec" id="br_t_v">Video</button>'
   +'<button class="sec" id="br_t_c">Use Claude <span style="opacity:.7;font-size:10px;letter-spacing:.06em;text-transform:uppercase">· any size</span></button></div>'
   +'<div id="br_src_s"><label>Script</label>'
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
   +'<div style="flex:0 0 120px"><label>Shots</label><input id="br_count" type="number" min="1" max="200" value="8"></div>'
   +'<div><label>Character (optional)</label><select id="br_char">'+charOpts+'</select></div></div>'
   +'<p style="margin:16px 0"><button class="go" id="br_go">Generate b-rolls</button></p>'
   +'<pre id="br_log" style="display:none"></pre></div>'
   +'<div class="bx-head"><h2 style="margin:0">Sets</h2><div class="bx-tools">'
   +'<button class="sec" id="br_ref">Refresh</button></div></div><div id="br_sets"></div>';
  const showSrc=()=>{
    $('#br_src_s').style.display=src==='script'?'':'none';
    $('#br_src_v').style.display=src==='video'?'':'none';
    $('#br_src_c').style.display=src==='claude'?'':'none';
    $('#br_t_s').style.borderColor=src==='script'?'var(--gold)':'';
    $('#br_t_v').style.borderColor=src==='video'?'var(--gold)':'';
    $('#br_t_c').style.borderColor=src==='claude'?'var(--gold)':'';
    // In Claude mode, hide the regular Generate button — the action is "Copy prompt" inside the panel.
    $('#br_go').style.display=src==='claude'?'none':'';
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
  $('#br_t_s').onclick=()=>{src='script';showSrc();};
  $('#br_t_v').onclick=()=>{src='video';showSrc();};
  $('#br_t_c').onclick=()=>{src='claude';showSrc();};
  // Repaint when any of the settings the prompt depends on change.
  ['br_aspect','br_count','br_char'].forEach(id=>{
    const el=$('#'+id);if(el)el.addEventListener('change',()=>{if(src==='claude')paintClaudePrompt();});
    if(el)el.addEventListener('input',()=>{if(src==='claude')paintClaudePrompt();});
  });
  showSrc();
  // Wire up the Claude-mode buttons (works even when not currently visible).
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
  let es;
  $('#br_go').onclick=async()=>{
    const fd=new FormData();
    fd.append('aspect',$('#br_aspect').value);
    fd.append('count',$('#br_count').value||'8');
    fd.append('characterId',$('#br_char').value);
    let sizeMB=0;
    if(src==='video'){const f=$('#br_video').files[0];
      if(!f)return alert('Choose a video file');
      sizeMB=f.size/(1024*1024);
      if(sizeMB>100){return alert('That video is '+sizeMB.toFixed(1)+' MB — please trim it or compress it under 100 MB. '
        +'On a Mac: File → Export As → 720p in QuickTime, or use HandBrake. Or just trim to a shorter clip.');}
      fd.append('video',f);}
    else{const t=$('#br_script').value.trim();
      if(t.length<10)return alert('Paste a script (10+ chars)');fd.append('script',t);}
    const L=$('#br_log');$('#br_go').disabled=true;L.style.display='block';
    L.textContent=src==='video'
      ? 'Uploading '+sizeMB.toFixed(1)+' MB video to server…  (this can take ~5–60s depending on your internet)\\n'
      : 'Submitting…\\n';
    es&&es.close();es=new EventSource('/api/log');
    es.onmessage=ev=>{const line=JSON.parse(ev.data);
      L.textContent+=line+'\\n';L.scrollTop=L.scrollHeight;
      if(line.indexOf('✓ Done')>-1||line.indexOf('✗ Exited')>-1){es.close();
        $('#br_go').disabled=false;loadSets();}};
    // Use XHR so we can show real upload progress for big videos.
    const fail=(msg)=>{alert(msg);L.textContent+='\\n✗ '+msg+'\\n';
      es&&es.close();$('#br_go').disabled=false;};
    const xhr=new XMLHttpRequest();
    xhr.open('POST','/api/broll/generate');
    xhr.upload.onprogress=(e)=>{if(!e.lengthComputable)return;
      const pct=Math.round(e.loaded/e.total*100);
      const a=(e.loaded/(1024*1024)).toFixed(1),b=(e.total/(1024*1024)).toFixed(1);
      const last=L.textContent.split('\\n').slice(-1)[0];
      const line='Uploading… '+pct+'%  ('+a+' / '+b+' MB)';
      if(last.startsWith('Uploading')){L.textContent=L.textContent.replace(/Uploading[^\\n]*$/,line);}
      else{L.textContent+=line+'\\n';}L.scrollTop=L.scrollHeight;};
    xhr.upload.onerror=()=>fail('Upload failed mid-transfer (network dropped or server closed connection).');
    xhr.onerror=()=>fail('Network error reaching the server.');
    xhr.ontimeout=()=>fail('Upload timed out.');
    xhr.onload=()=>{
      const ok=xhr.status>=200&&xhr.status<300;
      if(ok)return; // success — leave the SSE log running, button re-enables on '✓ Done'/'✗ Exited'.
      let msg='';try{msg=(JSON.parse(xhr.responseText||'{}').error)||'';}catch{/*not json*/}
      if(!msg)msg='Server returned '+xhr.status+(xhr.statusText?' '+xhr.statusText:'')
        +(xhr.responseText?' — '+xhr.responseText.slice(0,200):'');
      fail(msg);};
    xhr.send(fd);
  };
  $('#br_ref').onclick=loadSets;
  async function loadSets(){
    const sets=await api('/api/broll/sets');
    if(!sets.length){$('#br_sets').innerHTML='<p class="muted">No b-roll sets yet.</p>';return;}
    $('#br_sets').innerHTML=sets.map(S=>{
      const m=S.meta||{};
      const shots=S.shots.map(sh=>{
        const a='/broll-asset/'+encodeURIComponent(S.stamp)+'/shot-'+String(sh.n).padStart(2,'0')+'.png';
        const img=sh.hasFrame
          ?'<figure><img loading="lazy" src="'+a+'"><a class="dl" href="'+a+'?dl=1" download>↓ PNG</a></figure>'
          :'<figure><div class="frame ph" style="aspect-ratio:4/5;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:11px">no frame</div></figure>';
        return '<div style="margin-bottom:14px">'+img
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
boot();
</script></body></html>`;
