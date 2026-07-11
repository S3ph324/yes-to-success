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

test("readQueue throws on corrupt JSON instead of silently returning {}", async () => {
  const { readQueue, QUEUE_PATH } = await import("../lib/techsplains-queue.mjs");
  await fs.writeFile(QUEUE_PATH, "{ this is not json");
  await assert.rejects(() => readQueue());
  await fs.rm(QUEUE_PATH, { force: true }); // reset so later ordering is clean
});

test("setEntry/readQueue honor an explicit per-client queue path", async () => {
  const { setEntry, readQueue } = await import("../lib/techsplains-queue.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tzq-"));
  const qp = path.join(dir, "tranzzie-video-queue.json");
  const k = "2026-07-11T09-00/tranzzie-01.mp4";
  await setEntry(k, { status: "approved" }, qp);
  // The write must land in qp…
  assert.equal((await readQueue(qp))[k].status, "approved");
  // …and NOT leak into the default (techsplains) queue — proving the path arg
  // is actually threaded, not ignored (which would make both hit the default).
  assert.equal((await readQueue())[k], undefined);
  await fs.rm(dir, { recursive: true, force: true });
});
