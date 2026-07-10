#!/usr/bin/env node
// Techsplains control dashboard (LOCAL ONLY).
//
//   npm run techsplains:dashboard      → http://localhost:4318
//
// Isolated from server.mjs (John Calub) and jurie-dashboard.mjs (Jurie/Tranzzie).
// Generate a batch, review + approve videos, queue approved ones to Buffer.

import express from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";
import { resolveClient, projectRoot } from "./lib/client.mjs";
import { listStamps, loadBatch, safeExportPath } from "./lib/techsplains-batches.mjs";
import { readQueue, setEntry, keyFor } from "./lib/techsplains-queue.mjs";
import { nextSlots } from "./lib/techsplains-schedule.mjs";
import { readSettings, writeSettings } from "./lib/techsplains-settings.mjs";
import { bufferConfigured, schedulePost } from "./lib/techsplains-buffer.mjs";
import { storageConfigured, uploadPublic } from "./lib/techsplains-storage.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const VERSION = require(path.join(projectRoot, "package.json")).version;

const client = await resolveClient("techsplains");
const EXPORT_DIR = process.env.TECHSPLAINS_EXPORT_DIR || client.exportDir;
const PORT = parseInt(process.env.TECHSPLAINS_DASHBOARD_PORT || "4318", 10);

const app = express();
app.use(express.json());

const HTML_PATH = path.join(__dirname, "techsplains-dashboard.html");
app.get("/", (_req, res) => res.sendFile(HTML_PATH));
app.get("/api/health", (_req, res) => res.json({ ok: true, version: VERSION }));

// --- Generate: spawn the pipeline, stream its stdout/stderr to the browser ---
app.post("/api/generate", (req, res) => {
  const count = Math.min(20, Math.max(1, parseInt(req.body?.count, 10) || 1));
  const dyk = Math.max(0, parseInt(req.body?.dyk, 10) || 0);
  const general = Math.min(count, Math.max(0, parseInt(req.body?.general, 10) || 0));
  const topic = (req.body?.topic || "").trim();

  res.set({ "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });

  const args = [path.join(__dirname, "batch-techsplains.mjs"), String(count)];
  if (topic) args.push(...topic.split(/\s+/));

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      TECHSPLAINS_DYK: String(dyk),
      TECHSPLAINS_GENERAL: String(general),
      TECHSPLAINS_EXPORT_DIR: EXPORT_DIR,
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
  // Kill the pipeline only if the CLIENT actually disconnects mid-run. Use
  // res 'close' (not req 'close' — Express fires that the instant the request
  // body is read, which would SIGTERM the pipeline immediately) and guard on
  // writableFinished so a normal completion never triggers a kill.
  res.on("close", () => {
    if (!res.writableFinished && !child.killed) child.kill();
  });
});

// --- Batches: list stamps with per-video approval status -------------------
app.get("/api/batches", async (_req, res) => {
  try {
    const queue = await readQueue();
    const stamps = await listStamps(EXPORT_DIR);
    const out = [];
    for (const stamp of stamps) {
      const { videos } = await loadBatch(EXPORT_DIR, stamp);
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
    const queue = await readQueue();
    const { videos } = await loadBatch(EXPORT_DIR, req.params.stamp);
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
app.get("/api/video/:stamp/:file", (req, res) => {
  let abs;
  try {
    abs = safeExportPath(EXPORT_DIR, req.params.stamp, req.params.file);
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
    // Suffix form "bytes=-N" → the last N bytes.
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
    const patch = { status };
    if (typeof caption === "string") patch.caption = caption;
    const entry = await setEntry(keyFor(stamp, file), patch);
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Queue: approved (or later) videos across all batches ------------------
app.get("/api/queue", async (_req, res) => {
  try {
    const queue = await readQueue();
    const stamps = await listStamps(EXPORT_DIR);
    const items = [];
    for (const stamp of stamps) {
      const { videos } = await loadBatch(EXPORT_DIR, stamp);
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

// Snapshot the posting queue: approved videos (posting candidates) plus every
// slot locked by a video already handed off (ready/scheduled/posted) — those
// posts exist outside this dashboard, so their slots can never be reassigned.
async function queueSnapshot() {
  const queue = await readQueue();
  const stamps = await listStamps(EXPORT_DIR);
  const approved = [];
  const sentSlots = [];
  for (const stamp of stamps) {
    const { videos } = await loadBatch(EXPORT_DIR, stamp);
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

// Lay every approved video out on the posting calendar (per the saved daily
// posting times) and PERSIST each assignment. Re-running re-flows to the
// CURRENT settings — changing the times and clicking again takes effect.
// Two kinds of slots survive a re-flow: videos already sent to Buffer, and
// times the operator set by hand (pinned). Returns the fresh list.
async function autoschedule(startDate) {
  const { postTimes } = await readSettings();
  const { approved, sentSlots } = await queueSnapshot();
  const now = Date.now();
  const isFuture = (t) => t && new Date(t).getTime() > now;
  // Never schedule inside the next 20 min: Buffer rejects past dueAt, and the
  // operator needs room to hit "Send to Buffer" before the first slot passes.
  let after = new Date(now + 20 * 60e3);
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate || "")) {
    const sd = new Date(`${startDate}T00:00:00`);
    if (sd.getTime() > after.getTime()) after = sd;
  }
  const keptPins = approved.filter((t) => t.pinned && isFuture(t.scheduledAt));
  const needs = approved
    .filter((t) => !(t.pinned && isFuture(t.scheduledAt)))
    // Oldest batch first — approved content posts in the order it was made.
    .sort((a, b) => (a.stamp + a.file < b.stamp + b.file ? -1 : 1));
  const taken = [...sentSlots.filter(isFuture), ...keptPins.map((t) => t.scheduledAt)];
  const slots = nextSlots({ postTimes, count: needs.length, after, taken });
  for (let i = 0; i < needs.length; i++) {
    needs[i].scheduledAt = slots[i];
    await setEntry(keyFor(needs[i].stamp, needs[i].file), { scheduledAt: slots[i], pinned: false });
  }
  return { approved, scheduled: needs.length, kept: keptPins.length, postTimes };
}

// Posting-time settings (persisted in config/techsplains-settings.json).
app.get("/api/settings", async (_req, res) => {
  try {
    res.json(await readSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/settings", async (req, res) => {
  try {
    res.json(await writeSettings({ postTimes: req.body?.postTimes }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-schedule (persists immediately — reloading the page keeps the plan).
app.post("/api/queue/autoschedule", async (req, res) => {
  try {
    const r = await autoschedule(req.body?.startDate);
    res.json({ ok: true, scheduled: r.scheduled, kept: r.kept, postTimes: r.postTimes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist per-item scheduled times (from the plan the client just computed).
app.post("/api/queue/schedule", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    for (const it of items) {
      if (!it.stamp || !it.file) continue;
      // A hand-set time is PINNED — auto-schedule re-flows around it instead
      // of overwriting it. null clears the slot (and the pin) again.
      await setEntry(keyFor(it.stamp, it.file), {
        scheduledAt: it.scheduledAt || null,
        pinned: Boolean(it.scheduledAt),
      });
    }
    res.json({ ok: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send approved videos to the posting queue. Autoposting happens ONLY on this
// explicit action. With B2 storage + Buffer configured, each approved MP4 is
// uploaded to the public bucket and scheduled to Buffer for its due time. If
// either is unconfigured, it degrades to the manual handoff — mark approved →
// ready so the operator queues the files into Buffer's composer themselves.
app.post("/api/queue/send", async (_req, res) => {
  try {
    // Any approved video still missing a future slot gets the next free one
    // first — sending never silently posts "an hour from now".
    const { approved: targets } = await autoschedule();

    if (!bufferConfigured() || !storageConfigured()) {
      for (const t of targets) await setEntry(keyFor(t.stamp, t.file), { status: "ready" });
      return res.json({ mode: "manual", sent: targets.length, failed: 0, exportHint: EXPORT_DIR });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];
    for (const t of targets) {
      try {
        const abs = safeExportPath(EXPORT_DIR, t.stamp, t.file);
        const videoUrl = await uploadPublic(abs, `${t.stamp}/${t.file}`);
        const { postId, url } = await schedulePost({ videoUrl, caption: t.caption, dueAt: t.scheduledAt });
        await setEntry(keyFor(t.stamp, t.file), {
          status: "scheduled",
          bufferPostId: postId,
          bufferUrl: url,
          videoUrl,
        });
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
  console.log(`Techsplains dashboard v${VERSION} → http://localhost:${PORT}`);
  console.log(`  export dir: ${EXPORT_DIR}`);
});
