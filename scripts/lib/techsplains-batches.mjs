// Reads rendered Techsplains batches off disk for the dashboard. Prefers the
// machine-readable manifest.json; falls back to parsing captions.txt for
// batches rendered before manifests existed.

import fs from "node:fs/promises";
import path from "node:path";
import { parseCaptionsTxt } from "./techsplains-manifest.mjs";

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9._-]+\.mp4$/;

export async function listStamps(exportDir) {
  let entries = [];
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && STAMP_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function loadBatch(exportDir, stamp) {
  if (!STAMP_RE.test(stamp)) throw new Error(`bad stamp: ${stamp}`);
  const dir = path.join(exportDir, stamp);
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`batch not found: ${stamp}`);
    throw err;
  }

  let manifest = null;
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf-8"));
    if (Array.isArray(parsed)) manifest = parsed; // ignore malformed/hand-edited manifests
  } catch {
    /* older batch — no manifest */
  }

  let videos;
  if (manifest) {
    videos = files.map((file) => {
      const m = manifest.find((x) => x.file === file) || {};
      return {
        file,
        title: m.title || file,
        caption: m.caption || "",
        variant: m.variant || "difference",
        durationSec: m.durationSec ?? null,
      };
    });
  } else {
    let blocks = [];
    try {
      blocks = parseCaptionsTxt(await fs.readFile(path.join(dir, "captions.txt"), "utf-8"));
    } catch {
      /* no captions either — titles fall back to filenames */
    }
    videos = files.map((file, i) => ({
      file,
      title: blocks[i]?.title || file,
      caption: blocks[i]?.caption || "",
      variant: /did-you-know/.test(file) ? "didyouknow" : "difference",
      durationSec: null,
    }));
  }
  return { stamp, videos };
}

// Resolve an on-disk video path, refusing anything that escapes the export dir
// or isn't a plain .mp4 filename.
export function safeExportPath(exportDir, stamp, file) {
  if (!STAMP_RE.test(stamp)) throw new Error(`bad stamp: ${stamp}`);
  if (!FILE_RE.test(file)) throw new Error(`bad file: ${file}`);
  const base = path.resolve(exportDir);
  const target = path.resolve(base, stamp, file);
  if (target !== path.join(base, stamp, file) || !target.startsWith(base + path.sep)) {
    throw new Error("path escapes export dir");
  }
  return target;
}
