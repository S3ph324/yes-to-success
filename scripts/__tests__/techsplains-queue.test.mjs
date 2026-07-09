import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Point the lib at a temp queue file via env before importing it.
let tmpDir;
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tsq-"));
  process.env.TECHSPLAINS_QUEUE_PATH = path.join(tmpDir, "queue.json");
});
after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

test("keyFor joins stamp and file", async () => {
  const { keyFor } = await import("../lib/techsplains-queue.mjs");
  assert.equal(keyFor("2026-07-09T10-00", "a.mp4"), "2026-07-09T10-00/a.mp4");
});

test("readQueue returns {} when the file is absent", async () => {
  const { readQueue } = await import("../lib/techsplains-queue.mjs");
  assert.deepEqual(await readQueue(), {});
});

test("setEntry merges patches and getEntry reads them back", async () => {
  const { setEntry, getEntry } = await import("../lib/techsplains-queue.mjs");
  await setEntry("k1", { status: "approved" });
  await setEntry("k1", { caption: "edited" });
  assert.deepEqual(await getEntry("k1"), { status: "approved", caption: "edited" });
});

test("concurrent setEntry calls do not lose writes", async () => {
  const { setEntry, readQueue } = await import("../lib/techsplains-queue.mjs");
  await Promise.all([
    setEntry("a", { status: "approved" }),
    setEntry("b", { status: "rejected" }),
    setEntry("c", { status: "pending" }),
  ]);
  const q = await readQueue();
  assert.equal(q.a.status, "approved");
  assert.equal(q.b.status, "rejected");
  assert.equal(q.c.status, "pending");
});
