import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listStamps, loadBatch, safeExportPath } from "../lib/techsplains-batches.mjs";

let root;
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tsb-"));
  // Batch A: has manifest.json
  const a = path.join(root, "2026-07-09T10-00");
  await fs.mkdir(a, { recursive: true });
  await fs.writeFile(path.join(a, "techsplains-01-x.mp4"), "fake");
  await fs.writeFile(path.join(a, "manifest.json"), JSON.stringify([
    { file: "techsplains-01-x.mp4", title: "X vs Y", caption: "cap", variant: "difference", durationSec: 40 },
  ]));
  // Batch B: no manifest, only captions.txt (older batch)
  const b = path.join(root, "2026-07-08T09-00");
  await fs.mkdir(b, { recursive: true });
  await fs.writeFile(path.join(b, "techsplains-01-old.mp4"), "fake");
  await fs.writeFile(path.join(b, "captions.txt"),
    "#1 — Old Title\nold caption\n----------------------------------------\n");
  // A stray non-stamp dir must be ignored
  await fs.mkdir(path.join(root, ".DS_Store_dir"), { recursive: true });
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

test("listStamps returns only valid stamps, newest first", async () => {
  assert.deepEqual(await listStamps(root), ["2026-07-09T10-00", "2026-07-08T09-00"]);
});

test("loadBatch reads manifest.json when present", async () => {
  const batch = await loadBatch(root, "2026-07-09T10-00");
  assert.equal(batch.videos[0].title, "X vs Y");
  assert.equal(batch.videos[0].caption, "cap");
});

test("loadBatch falls back to captions.txt", async () => {
  const batch = await loadBatch(root, "2026-07-08T09-00");
  assert.equal(batch.videos[0].title, "Old Title");
  assert.equal(batch.videos[0].caption, "old caption");
});

test("safeExportPath rejects traversal and bad names", () => {
  assert.throws(() => safeExportPath(root, "../etc", "passwd.mp4"));
  assert.throws(() => safeExportPath(root, "2026-07-09T10-00", "../../secret.mp4"));
  assert.throws(() => safeExportPath(root, "2026-07-09T10-00", "notmp4.txt"));
  const ok = safeExportPath(root, "2026-07-09T10-00", "techsplains-01-x.mp4");
  assert.ok(ok.endsWith("2026-07-09T10-00/techsplains-01-x.mp4"));
});

test("loadBatch rejects an invalid stamp (traversal guard)", async () => {
  await assert.rejects(() => loadBatch(root, "../../etc"));
});

test("loadBatch ignores a malformed (non-array) manifest and falls back to captions.txt", async () => {
  const c = path.join(root, "2026-07-07T08-00");
  await fs.mkdir(c, { recursive: true });
  await fs.writeFile(path.join(c, "techsplains-01-z.mp4"), "fake");
  await fs.writeFile(path.join(c, "manifest.json"), "{}"); // object, not array
  await fs.writeFile(path.join(c, "captions.txt"),
    "#1 — Fallback Title\nfb cap\n----------------------------------------\n");
  const batch = await loadBatch(root, "2026-07-07T08-00");
  assert.equal(batch.videos[0].title, "Fallback Title");
});
