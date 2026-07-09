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
  const topic = (req.body?.topic || "").trim();

  res.set({ "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" });

  const args = [path.join(__dirname, "batch-techsplains.mjs"), String(count)];
  if (topic) args.push(...topic.split(/\s+/));

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, TECHSPLAINS_DYK: String(dyk), TECHSPLAINS_EXPORT_DIR: EXPORT_DIR },
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
  req.on("close", () => child.killed || child.kill());
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

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Techsplains dashboard v${VERSION} → http://localhost:${PORT}`);
  console.log(`  export dir: ${EXPORT_DIR}`);
});
