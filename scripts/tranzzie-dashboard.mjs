#!/usr/bin/env node
// Tranzzie Video Studio — dedicated control dashboard (LOCAL ONLY).
//
//   npm run tranzzie:dashboard      → http://localhost:4319
//
// Isolated from server.mjs (John Calub), jurie-dashboard.mjs (Jurie posters),
// and techsplains-dashboard.mjs (Techsplains). Fixed to the `tranzzie` client.
// Generate difference/"Alam mo ba" videos with a chosen presenter LOOK
// (cartoon | realistic Jurie) and BACKGROUND theme, review + approve them, then
// schedule/send to Tranzzie's OWN Buffer channel.
//
// Posting safety: a Send only ever posts to Tranzzie's channel (BUFFER_TRANZZIE_*)
// and only when Buffer + storage are configured; otherwise it degrades to a
// manual export (mark ready). Nothing posts without the operator clicking Send.

import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { projectRoot } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { listStamps, loadBatch, safeExportPath } from "./lib/techsplains-batches.mjs";
import { readQueue, setEntry, keyFor } from "./lib/techsplains-queue.mjs";
import { nextSlots } from "./lib/techsplains-schedule.mjs";
import { readSettings, writeSettings } from "./lib/diff-settings.mjs";
import { bufferConfigured, schedulePost } from "./lib/diff-buffer.mjs";
import { storageConfigured, uploadPublic } from "./lib/diff-storage.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const VERSION = require(path.join(projectRoot, "package.json")).version;

const CLIENT = "tranzzie";
const PORT = parseInt(process.env.TRANZZIE_DASHBOARD_PORT || "4319", 10);

// Presenter looks + background themes the generate form can pick. Kept in sync
// with config/clients.json presenter.looks and src/TranzzieDiffCard/backgrounds.tsx.
const LOOKS = ["cartoon", "real"];
const BG_STYLES = ["ember", "aurora", "grid", "light", "rotate"];

// Clean illustrated comparison images (same recipe as the approved samples):
// force AI image-gen with a flat, obvious-at-a-glance style so the two options
// read clearly. Applies to the comparison IMAGES, independent of presenter look.
const IMAGE_STYLE_TAIL =
  " Flat vector illustration, bold clean outlines, smooth flat colors, minimal cel shading, " +
  "modern friendly brand style — clearly and simply illustrating the subject so it is obvious " +
  "at a glance, single centered subject, vertical-friendly square composition, clean solid pale " +
  "background. No text, no words, no letters, no watermark, no logos.";

// Resolve export/queue paths for Tranzzie (env overrides win, mirroring the
// TECHSPLAINS_* knobs the other dashboard exposes).
async function ctx() {
  const cfg = await resolveDiffClient(CLIENT);
  return {
    cfg,
    exportDir: process.env.TRANZZIE_EXPORT_DIR || cfg.exportDir,
    queuePath: process.env.TRANZZIE_QUEUE_PATH || cfg.queuePath,
  };
}

const app = express();
app.use(express.json());

const HTML_PATH = path.join(__dirname, "tranzzie-dashboard.html");
app.get("/", (_req, res) => res.sendFile(HTML_PATH));
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    client: CLIENT,
    looks: LOOKS,
    bgStyles: BG_STYLES,
    buffer: bufferConfigured(CLIENT),
    storage: storageConfigured(CLIENT),
  }),
);

// --- Generate: spawn the pipeline, stream its stdout/stderr to the browser ---
app.post("/api/generate", async (req, res) => {
  const count = Math.min(20, Math.max(1, parseInt(req.body?.count, 10) || 1));
  const dyk = Math.max(0, Math.min(count, parseInt(req.body?.dyk, 10) || 0));
  const topic = (req.body?.topic || "").trim();
  const look = LOOKS.includes(req.body?.look) ? req.body.look : "cartoon";
  const bgStyle = BG_STYLES.includes(req.body?.bgStyle) ? req.body.bgStyle : "ember";
  const { exportDir } = await ctx();

  res.set({ "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });

  // Realistic look needs the photoreal pose set on disk — fail early with a
  // clear instruction rather than 404-ing deep in the render.
  if (look === "real") {
    const posePath = path.join(projectRoot, "public", "characters", "tranzzie-real", "jurie-base.png");
    if (!fs.existsSync(posePath)) {
      res.write(
        "!! Realistic Jurie poses are missing.\n" +
          "   Run:  npm run tranzzie:poses -- --look real\n__EXIT__ 1\n",
      );
      return res.end();
    }
  }

  const args = [path.join(__dirname, "batch-diff.mjs"), "--client", CLIENT, String(count)];
  if (topic) args.push(...topic.split(/\s+/));

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      DIFF_DYK: String(dyk),
      DIFF_GENERAL: "0", // Tranzzie has allowGeneral:false
      DIFF_EXPORT_DIR: exportDir,
      DIFF_PRESENTER_LOOK: look,
      DIFF_BG_STYLE: bgStyle,
      DIFF_IMAGE_SOURCE: "ai",
      DIFF_IMAGE_STYLE_TAIL: IMAGE_STYLE_TAIL,
      // Every Tranzzie visual is AI-generated (incl. DYK slideshows), so a batch
      // makes many image-gen calls. Pace them under the per-minute Vertex quota
      // and raise the retry ceiling so a big batch doesn't fail with 429s.
      DIFF_IMG_MIN_INTERVAL_MS: process.env.DIFF_IMG_MIN_INTERVAL_MS || "4000",
      DIFF_IMG_MAX_RETRIES: process.env.DIFF_IMG_MAX_RETRIES || "8",
    },
  });
  child.stdout.on("data", (c) => res.write(c));
  child.stderr.on("data", (c) => res.write(c));
  child.on("close", (code) => {
    res.write(`\n__EXIT__ ${code}\n`);
    res.end();
  });
  child.on("error", (err) => {
    res.write(`\n!! spawn error: ${err.message}\n__EXIT__ 1\n`);
    res.end();
  });
  // Kill the pipeline only if the CLIENT actually disconnects mid-run (see the
  // techsplains dashboard note: use res 'close' + writableFinished guard).
  res.on("close", () => {
    if (!res.writableFinished && !child.killed) child.kill();
  });
});

// --- Batches: list stamps with per-video approval status -------------------
app.get("/api/batches", async (_req, res) => {
  try {
    const { exportDir, queuePath } = await ctx();
    const queue = await readQueue(queuePath);
    const stamps = await listStamps(exportDir);
    const out = [];
    for (const stamp of stamps) {
      const { videos } = await loadBatch(exportDir, stamp);
      out.push({
        stamp,
        videos: videos.map((v) => {
          const entry = queue[keyFor(stamp, v.file)] || {};
          return { ...v, status: entry.status || "pending", caption: entry.caption ?? v.caption };
        }),
      });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/batches/:stamp", async (req, res) => {
  try {
    const { exportDir, queuePath } = await ctx();
    const queue = await readQueue(queuePath);
    const { videos } = await loadBatch(exportDir, req.params.stamp);
    res.json({
      stamp: req.params.stamp,
      videos: videos.map((v) => {
        const entry = queue[keyFor(req.params.stamp, v.file)] || {};
        return { ...v, status: entry.status || "pending", caption: entry.caption ?? v.caption };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Video streaming (Range-aware, traversal-guarded) ----------------------
app.get("/api/video/:stamp/:file", async (req, res) => {
  let abs;
  try {
    const { exportDir } = await ctx();
    abs = safeExportPath(exportDir, req.params.stamp, req.params.file);
  } catch {
    return res.status(400).end("bad path");
  }
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return res.status(404).end("not found");
  }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m ? parseInt(m[1], 10) : NaN;
    let end = m && m[2] !== "" ? parseInt(m[2], 10) : stat.size - 1;
    if (m && m[1] === "" && m[2] !== "") {
      start = Math.max(0, stat.size - parseInt(m[2], 10));
      end = stat.size - 1;
    }
    if (
      !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end < start || start >= stat.size
    ) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": stat.size, "Content-Type": "video/mp4" });
    fs.createReadStream(abs).pipe(res);
  }
});

// --- Approve / reject / edit caption ---------------------------------------
app.post("/api/approve", async (req, res) => {
  const { stamp, file, status, caption } = req.body || {};
  if (!stamp || !file || !["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "stamp, file, status required" });
  }
  try {
    const { queuePath } = await ctx();
    const patch = { status };
    if (typeof caption === "string") patch.caption = caption;
    const entry = await setEntry(keyFor(stamp, file), patch, queuePath);
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Queue: approved (or later) videos across all batches ------------------
app.get("/api/queue", async (_req, res) => {
  try {
    const { exportDir, queuePath } = await ctx();
    const queue = await readQueue(queuePath);
    const stamps = await listStamps(exportDir);
    const items = [];
    for (const stamp of stamps) {
      const { videos } = await loadBatch(exportDir, stamp);
      for (const v of videos) {
        const entry = queue[keyFor(stamp, v.file)];
        if (!entry || !["approved", "ready", "scheduled", "posted"].includes(entry.status)) continue;
        items.push({
          stamp,
          file: v.file,
          title: v.title,
          caption: entry.caption ?? v.caption,
          status: entry.status,
          scheduledAt: entry.scheduledAt || null,
          bufferUrl: entry.bufferUrl || null,
        });
      }
    }
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Snapshot: approved videos (posting candidates) + slots locked by videos
// already handed off (ready/scheduled/posted) — those can't be reassigned.
async function queueSnapshot(exportDir, queuePath) {
  const queue = await readQueue(queuePath);
  const stamps = await listStamps(exportDir);
  const approved = [];
  const sentSlots = [];
  for (const stamp of stamps) {
    const { videos } = await loadBatch(exportDir, stamp);
    for (const v of videos) {
      const entry = queue[keyFor(stamp, v.file)];
      if (!entry) continue;
      if (entry.scheduledAt && ["ready", "scheduled", "posted"].includes(entry.status)) {
        sentSlots.push(entry.scheduledAt);
      }
      if (entry.status === "approved") {
        approved.push({
          stamp,
          file: v.file,
          caption: entry.caption ?? v.caption,
          scheduledAt: entry.scheduledAt || null,
          pinned: Boolean(entry.pinned),
        });
      }
    }
  }
  return { approved, sentSlots };
}

// Lay every approved video onto the posting calendar (per the saved times) and
// PERSIST each assignment. Videos already sent, and hand-pinned times, survive a
// re-flow. Returns the fresh list.
async function autoschedule(startDate, exportDir, queuePath) {
  const { postTimes } = await readSettings(CLIENT);
  const { approved, sentSlots } = await queueSnapshot(exportDir, queuePath);
  const now = Date.now();
  const isFuture = (t) => t && new Date(t).getTime() > now;
  let after = new Date(now + 20 * 60e3);
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate || "")) {
    const sd = new Date(`${startDate}T00:00:00`);
    if (sd.getTime() > after.getTime()) after = sd;
  }
  const keptPins = approved.filter((t) => t.pinned && isFuture(t.scheduledAt));
  const needs = approved
    .filter((t) => !(t.pinned && isFuture(t.scheduledAt)))
    .sort((a, b) => (a.stamp + a.file < b.stamp + b.file ? -1 : 1));
  const taken = [...sentSlots.filter(isFuture), ...keptPins.map((t) => t.scheduledAt)];
  const slots = nextSlots({ postTimes, count: needs.length, after, taken });
  for (let i = 0; i < needs.length; i++) {
    needs[i].scheduledAt = slots[i];
    await setEntry(keyFor(needs[i].stamp, needs[i].file), { scheduledAt: slots[i], pinned: false }, queuePath);
  }
  return { approved, scheduled: needs.length, kept: keptPins.length, postTimes };
}

// Posting-time settings (persisted in config/tranzzie-settings.json).
app.get("/api/settings", async (_req, res) => {
  try {
    res.json(await readSettings(CLIENT));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/settings", async (req, res) => {
  try {
    res.json(await writeSettings(CLIENT, { postTimes: req.body?.postTimes }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-schedule (persists immediately).
app.post("/api/queue/autoschedule", async (req, res) => {
  try {
    const { exportDir, queuePath } = await ctx();
    const r = await autoschedule(req.body?.startDate, exportDir, queuePath);
    res.json({ ok: true, scheduled: r.scheduled, kept: r.kept, postTimes: r.postTimes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist per-item scheduled times (hand-set times are pinned).
app.post("/api/queue/schedule", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    const { queuePath } = await ctx();
    for (const it of items) {
      if (!it.stamp || !it.file) continue;
      await setEntry(keyFor(it.stamp, it.file), {
        scheduledAt: it.scheduledAt || null,
        pinned: Boolean(it.scheduledAt),
      }, queuePath);
    }
    res.json({ ok: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send approved videos to the posting queue. Autoposting happens ONLY on this
// explicit action, and ONLY to Tranzzie's own Buffer channel (BUFFER_TRANZZIE_*).
// With Buffer + storage configured, each approved MP4 is uploaded and scheduled
// to Buffer for its due time. If either is unconfigured it degrades to the
// manual handoff — mark approved → ready so the operator queues the files
// themselves. This is the "nothing posts without an explicit Send" guarantee.
app.post("/api/queue/send", async (_req, res) => {
  try {
    const { exportDir, queuePath } = await ctx();
    const { approved: targets } = await autoschedule(undefined, exportDir, queuePath);

    if (!bufferConfigured(CLIENT) || !storageConfigured(CLIENT)) {
      for (const t of targets) await setEntry(keyFor(t.stamp, t.file), { status: "ready" }, queuePath);
      return res.json({ mode: "manual", sent: targets.length, failed: 0, exportHint: exportDir });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];
    for (const t of targets) {
      try {
        const abs = safeExportPath(exportDir, t.stamp, t.file);
        // Namespace the remote path by client so brands never collide in a shared bucket.
        const videoUrl = await uploadPublic(CLIENT, abs, `${CLIENT}/${t.stamp}/${t.file}`);
        const { postId, url } = await schedulePost(CLIENT, { videoUrl, caption: t.caption, dueAt: t.scheduledAt });
        await setEntry(keyFor(t.stamp, t.file), {
          status: "scheduled",
          bufferPostId: postId,
          bufferUrl: url,
          videoUrl,
        }, queuePath);
        sent += 1;
      } catch (err) {
        failed += 1;
        errors.push(`${t.file}: ${err.message}`);
        console.warn(`Buffer send failed ${t.file}: ${err.message}`);
      }
    }
    res.json({ mode: "buffer", sent, failed, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Tranzzie Video Studio v${VERSION} → http://localhost:${PORT}`);
  console.log(`  posting: buffer=${bufferConfigured(CLIENT)} storage=${storageConfigured(CLIENT)} (manual export if either is off)`);
});
