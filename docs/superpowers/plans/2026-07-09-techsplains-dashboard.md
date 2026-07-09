# Techsplains Control Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard for Techsplains: click-to-generate a video batch, review + approve/reject each video inline, and queue approved videos for automatic Facebook posting via Buffer.

**Architecture:** One self-contained local Express server (`scripts/techsplains-dashboard.mjs`) on `localhost:4318`, isolated from the other two dashboards. The front-end is a single static file (`scripts/techsplains-dashboard.html`) served as-is — no build step, no template nesting. Pure logic lives in small `scripts/lib/techsplains-*.mjs` modules that are unit-tested with the built-in `node --test` runner. State persists to `config/techsplains-queue.json`.

**Tech Stack:** Node 24, Express 5 (already a dep), vanilla JS front-end, `node:test` for unit tests, `child_process.spawn` to drive the existing `batch-techsplains.mjs` pipeline, Buffer GraphQL API for posting.

## Global Constraints

- **Isolation:** Create new files only. Do NOT edit `scripts/server.mjs`, `scripts/jurie-dashboard.mjs`, or any Jurie/Tranzzie/Calub config. The one exception is the additive manifest write in `scripts/render-diff-batch.mjs` (Task 1) and `.gitignore` (Task 9).
- **Zero new npm deps.** Node 24 has native `fetch`, `node:test`, `spawn`. Do not add packages.
- **Port:** `localhost:4318`, env override `TECHSPLAINS_DASHBOARD_PORT`.
- **Export dir:** `process.env.TECHSPLAINS_EXPORT_DIR || client.exportDir` where `client = await resolveClient("techsplains")` — resolves to `~/Downloads/Work/02_Clients/Techsplains/05_Exports/Difference Videos`.
- **Buffer channel:** Techsplains-specific env `BUFFER_TECHSPLAINS_CHANNEL` + shared `BUFFER_API_KEY`. Never reuse the Jurie/Tranzzie channel constants.
- **Autoposting fires only on explicit "Send to Buffer" click** — never on generate or approve.
- **Version bump:** bump `package.json` version and show `v{version}` in the dashboard header (Task 9).
- **Stamp format:** `YYYY-MM-DDTHH-MM` (regex `/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/`).
- **Commit after every task.** End commit messages with the Co-Authored-By trailer for Claude.

---

## File Structure

**Create:**
- `scripts/lib/techsplains-manifest.mjs` — `buildManifest(results)`, `parseCaptionsTxt(text)`
- `scripts/lib/techsplains-queue.mjs` — queue state read/write (`keyFor`, `readQueue`, `setEntry`, `getEntry`, `QUEUE_PATH`)
- `scripts/lib/techsplains-batches.mjs` — `listStamps`, `loadBatch`, `safeExportPath`
- `scripts/lib/techsplains-schedule.mjs` — `computeSlots`
- `scripts/lib/techsplains-buffer.mjs` — `bufferConfigured`, `uploadAndSchedule` (impl decided by Task 7 probe)
- `scripts/techsplains-dashboard.mjs` — the Express server
- `scripts/techsplains-dashboard.html` — the front-end SPA
- `scripts/_buffer-video-probe.mjs` — throwaway Buffer capability probe (Task 7)
- `scripts/__tests__/techsplains-manifest.test.mjs`
- `scripts/__tests__/techsplains-queue.test.mjs`
- `scripts/__tests__/techsplains-batches.test.mjs`
- `scripts/__tests__/techsplains-schedule.test.mjs`

**Modify:**
- `scripts/render-diff-batch.mjs` — write `manifest.json` (Task 1)
- `package.json` — add `techsplains:dashboard` script + version bump (Task 9)
- `.gitignore` — add `config/techsplains-queue.json` (Task 9)

---

## Task 1: Manifest emit + parser lib

**Files:**
- Create: `scripts/lib/techsplains-manifest.mjs`
- Create: `scripts/__tests__/techsplains-manifest.test.mjs`
- Modify: `scripts/render-diff-batch.mjs` (after the `captions.txt` write, ~line 125)

**Interfaces:**
- Produces: `buildManifest(results: {fname:string, v:object}[]) => {file,title,caption,variant,durationSec}[]` and `parseCaptionsTxt(text:string) => {title,caption}[]`. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/techsplains-manifest.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, parseCaptionsTxt } from "../lib/techsplains-manifest.mjs";

test("buildManifest maps render results to manifest rows", () => {
  const results = [
    { fname: "techsplains-01-codec.mp4", v: { title: "Codec vs Container", caption: "cap A", variant: "difference", durationSec: 40.2 } },
    { fname: "techsplains-02-dyk.mp4", v: { title: "Did You Know: MP", caption: "cap B", variant: "didyouknow", durationSec: 23 } },
  ];
  assert.deepEqual(buildManifest(results), [
    { file: "techsplains-01-codec.mp4", title: "Codec vs Container", caption: "cap A", variant: "difference", durationSec: 40.2 },
    { file: "techsplains-02-dyk.mp4", title: "Did You Know: MP", caption: "cap B", variant: "didyouknow", durationSec: 23 },
  ]);
});

test("buildManifest tolerates missing fields", () => {
  const [row] = buildManifest([{ fname: "x.mp4", v: { title: "T" } }]);
  assert.equal(row.caption, "");
  assert.equal(row.variant, "difference");
  assert.equal(row.durationSec, null);
});

test("parseCaptionsTxt splits the #N — Title / caption / dashes format", () => {
  const txt =
    "#1 — Codec vs Container\nFirst caption line. 🤔\n----------------------------------------\n\n" +
    "#2 — Did You Know: Megapixels\nSecond caption.\n----------------------------------------\n";
  assert.deepEqual(parseCaptionsTxt(txt), [
    { title: "Codec vs Container", caption: "First caption line. 🤔" },
    { title: "Did You Know: Megapixels", caption: "Second caption." },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/macbookpro/claude_code/research/content-studio && node --test scripts/__tests__/techsplains-manifest.test.mjs`
Expected: FAIL — `Cannot find module '../lib/techsplains-manifest.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/techsplains-manifest.mjs`:

```js
// Machine-readable manifest for a rendered Techsplains batch, plus a fallback
// parser for older batches that only have the human-readable captions.txt.

export function buildManifest(results) {
  return results.map(({ fname, v }) => ({
    file: fname,
    title: v.title || fname,
    caption: v.caption || "",
    variant: v.variant || "difference",
    durationSec: v.durationSec ?? null,
  }));
}

// captions.txt blocks are: "#N — Title" line, caption lines, then a run of
// dashes. Split on the dash rows and pull title + caption out of each block.
export function parseCaptionsTxt(text) {
  const out = [];
  for (const block of text.split(/^-{4,}$/m)) {
    const lines = block.trim().split("\n");
    if (!lines.length || !/^#\d+\s*—/.test(lines[0])) continue;
    out.push({
      title: lines[0].replace(/^#\d+\s*—\s*/, "").trim(),
      caption: lines.slice(1).join("\n").trim(),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/techsplains-manifest.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Wire the manifest write into the render script**

In `scripts/render-diff-batch.mjs`, add the import near the top (after the existing `techsplains.mjs` import):

```js
import { buildManifest } from "./lib/techsplains-manifest.mjs";
```

Then, immediately after the `captions.txt` `await fs.writeFile(...)` block (before the `console.log` summary), add:

```js
await fs.writeFile(
  path.join(exportDir, "manifest.json"),
  JSON.stringify(buildManifest(results), null, 2),
);
```

- [ ] **Step 6: Verify the wiring loads without executing a full render**

Run: `node -e "import('./scripts/render-diff-batch.mjs').catch(e=>{console.log(String(e.message).includes('Usage')?'OK: guard hit':e.message)})"`
Expected: the script's own usage guard prints `Usage: node scripts/render-diff-batch.mjs <scripts.json>` and exits — proving the new import resolves (no `ERR_MODULE_NOT_FOUND`).

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/techsplains-manifest.mjs scripts/__tests__/techsplains-manifest.test.mjs scripts/render-diff-batch.mjs
git commit -m "feat(techsplains): emit manifest.json + captions parser for dashboard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Queue state lib

**Files:**
- Create: `scripts/lib/techsplains-queue.mjs`
- Create: `scripts/__tests__/techsplains-queue.test.mjs`

**Interfaces:**
- Consumes: `projectRoot` from `./client.mjs`.
- Produces: `keyFor(stamp,file) => string`, `readQueue() => Promise<object>`, `setEntry(key, patch) => Promise<entry>`, `getEntry(key) => Promise<entry|null>`, `QUEUE_PATH`. Consumed by Tasks 5, 6, 8.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/techsplains-queue.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/techsplains-queue.test.mjs`
Expected: FAIL — cannot find `../lib/techsplains-queue.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/techsplains-queue.mjs`:

```js
// Local-only approval/queue state for the Techsplains dashboard.
// Keyed by "<stamp>/<file>". Whole-file rewrites serialized through a promise
// chain so overlapping requests from the single local operator never clobber.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./client.mjs";

export const QUEUE_PATH =
  process.env.TECHSPLAINS_QUEUE_PATH ||
  path.join(projectRoot, "config", "techsplains-queue.json");

export const keyFor = (stamp, file) => `${stamp}/${file}`;

export async function readQueue() {
  try {
    return JSON.parse(await fs.readFile(QUEUE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function writeQueue(obj) {
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  await fs.writeFile(QUEUE_PATH, JSON.stringify(obj, null, 2));
}

let chain = Promise.resolve();
export function setEntry(key, patch) {
  chain = chain.then(async () => {
    const q = await readQueue();
    q[key] = { ...(q[key] || {}), ...patch };
    await writeQueue(q);
    return q[key];
  });
  return chain;
}

export async function getEntry(key) {
  return (await readQueue())[key] || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/techsplains-queue.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/techsplains-queue.mjs scripts/__tests__/techsplains-queue.test.mjs
git commit -m "feat(techsplains): dashboard queue state lib

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Batch discovery lib

**Files:**
- Create: `scripts/lib/techsplains-batches.mjs`
- Create: `scripts/__tests__/techsplains-batches.test.mjs`

**Interfaces:**
- Consumes: `buildManifest`/`parseCaptionsTxt` (Task 1 — only `parseCaptionsTxt` here).
- Produces: `listStamps(exportDir) => Promise<string[]>` (newest first), `loadBatch(exportDir, stamp) => Promise<{stamp, videos:{file,title,caption,variant,durationSec}[]}>`, `safeExportPath(exportDir, stamp, file) => string` (throws on traversal). Consumed by Tasks 5, 6, 8.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/techsplains-batches.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/techsplains-batches.test.mjs`
Expected: FAIL — cannot find `../lib/techsplains-batches.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/techsplains-batches.mjs`:

```js
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
  const dir = path.join(exportDir, stamp);
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".mp4"))
    .sort();

  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf-8"));
  } catch {
    /* older batch */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/techsplains-batches.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Sanity-check against the real export folder**

Run: `node -e "import('./scripts/lib/techsplains-batches.mjs').then(async m=>{const {resolveClient}=await import('./scripts/lib/client.mjs');const c=await resolveClient('techsplains');const s=await m.listStamps(c.exportDir);console.log('stamps:',s.slice(0,3));if(s[0])console.log('first batch:',JSON.stringify((await m.loadBatch(c.exportDir,s[0])).videos.map(v=>v.title)));})"`
Expected: prints real stamps like `2026-07-04T17-15` and the titles of that batch's videos (proves the captions.txt fallback works on real data — those batches predate manifests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/techsplains-batches.mjs scripts/__tests__/techsplains-batches.test.mjs
git commit -m "feat(techsplains): batch discovery + path guard lib

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Schedule compute lib

**Files:**
- Create: `scripts/lib/techsplains-schedule.mjs`
- Create: `scripts/__tests__/techsplains-schedule.test.mjs`

**Interfaces:**
- Produces: `computeSlots({perDay, timeOfDay, startDate, count}) => string[]` (ISO datetimes). Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/techsplains-schedule.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSlots } from "../lib/techsplains-schedule.mjs";

test("one per day fills consecutive days at the given time", () => {
  const slots = computeSlots({ perDay: 1, timeOfDay: "09:00", startDate: "2026-07-10", count: 3 });
  assert.equal(slots.length, 3);
  const d0 = new Date(slots[0]);
  assert.equal(d0.getHours(), 9);
  assert.equal(d0.getMinutes(), 0);
  // Each subsequent slot is ~24h after the previous.
  const day = 24 * 60 * 60 * 1000;
  assert.equal(Math.round((new Date(slots[1]) - d0) / day), 1);
  assert.equal(Math.round((new Date(slots[2]) - d0) / day), 2);
});

test("multiple per day space posts 3h apart within a day, then roll over", () => {
  const slots = computeSlots({ perDay: 2, timeOfDay: "09:00", startDate: "2026-07-10", count: 3 });
  const [a, b, c] = slots.map((s) => new Date(s));
  assert.equal(a.getHours(), 9);
  assert.equal(b.getHours(), 12); // +3h same day
  assert.equal(a.toDateString(), b.toDateString());
  assert.notEqual(a.toDateString(), c.toDateString()); // third rolls to next day
  assert.equal(c.getHours(), 9);
});

test("count 0 returns empty", () => {
  assert.deepEqual(computeSlots({ perDay: 1, timeOfDay: "09:00", startDate: "2026-07-10", count: 0 }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/techsplains-schedule.test.mjs`
Expected: FAIL — cannot find `../lib/techsplains-schedule.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/techsplains-schedule.mjs`:

```js
// Assigns posting slots to queued videos: `perDay` posts per day starting at
// `timeOfDay`, spaced 3h apart within a day, rolling to the next day when full.

export function computeSlots({ perDay = 1, timeOfDay = "09:00", startDate, count }) {
  const [hh, mm] = timeOfDay.split(":").map(Number);
  const base = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  const slots = [];
  let day = 0;
  let idxInDay = 0;
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + day);
    d.setHours(hh + idxInDay * 3, mm, 0, 0);
    slots.push(d.toISOString());
    idxInDay += 1;
    if (idxInDay >= Math.max(1, perDay)) {
      idxInDay = 0;
      day += 1;
    }
  }
  return slots;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/techsplains-schedule.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/techsplains-schedule.mjs scripts/__tests__/techsplains-schedule.test.mjs
git commit -m "feat(techsplains): posting-slot schedule lib

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Dashboard server + Generate + Review + Approve

**Files:**
- Create: `scripts/techsplains-dashboard.mjs`
- Create: `scripts/techsplains-dashboard.html`

**Interfaces:**
- Consumes: `resolveClient`, `projectRoot` from `./lib/client.mjs`; `listStamps`, `loadBatch`, `safeExportPath` (Task 3); `readQueue`, `setEntry`, `keyFor` (Task 2).
- Produces: HTTP server on 4318 with routes `GET /`, `GET /api/health`, `POST /api/generate` (stream), `GET /api/batches`, `GET /api/batches/:stamp`, `GET /api/video/:stamp/:file`, `POST /api/approve`. The Queue route/view is stubbed here and filled in Task 6.

- [ ] **Step 1: Write the server**

Create `scripts/techsplains-dashboard.mjs`:

```js
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
import fsp from "node:fs/promises";
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
  const count = Math.max(1, parseInt(req.body?.count, 10) || 1);
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
    const [s, e] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : stat.size - 1;
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

app.listen(PORT, () => {
  console.log(`Techsplains dashboard v${VERSION} → http://localhost:${PORT}`);
  console.log(`  export dir: ${EXPORT_DIR}`);
});
```

- [ ] **Step 2: Write the front-end**

Create `scripts/techsplains-dashboard.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Techsplains Studio</title>
<style>
  :root { --bg:#111; --panel:#1c1c1c; --line:#2a2a2a; --ink:#eee; --sub:#9a9a9a; --yellow:#FFDD00; --green:#34d399; --red:#f87171; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:system-ui,sans-serif; }
  header { display:flex; align-items:center; gap:16px; padding:14px 22px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5; }
  header h1 { font-size:16px; margin:0; letter-spacing:.5px; }
  header .v { font-size:11px; color:var(--sub); }
  nav { display:flex; gap:6px; margin-left:auto; }
  nav button { background:var(--panel); color:var(--ink); border:1px solid var(--line); padding:7px 14px; border-radius:8px; cursor:pointer; font-size:13px; }
  nav button.on { background:var(--yellow); color:#111; font-weight:700; border-color:var(--yellow); }
  main { padding:22px; max-width:1100px; margin:0 auto; }
  .row { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; }
  label { display:block; font-size:12px; color:var(--sub); margin-bottom:4px; }
  input, textarea { background:#0d0d0d; color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:9px 11px; font-size:14px; font-family:inherit; }
  textarea { width:100%; min-height:64px; resize:vertical; }
  .btn { background:var(--yellow); color:#111; font-weight:700; border:none; padding:11px 20px; border-radius:9px; cursor:pointer; font-size:14px; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .btn.ghost { background:var(--panel); color:var(--ink); border:1px solid var(--line); font-weight:500; }
  pre#log { background:#0a0a0a; border:1px solid var(--line); border-radius:10px; padding:14px; height:340px; overflow:auto; font-size:12px; line-height:1.5; white-space:pre-wrap; margin-top:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:18px; margin-top:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .card video { width:100%; display:block; aspect-ratio:9/16; background:#000; }
  .card .body { padding:11px 13px; }
  .card h3 { font-size:14px; margin:0 0 8px; }
  .card .acts { display:flex; gap:8px; margin-top:9px; }
  .card .acts button { flex:1; padding:8px; border-radius:7px; border:1px solid var(--line); cursor:pointer; font-size:13px; background:#0d0d0d; color:var(--ink); }
  .badge { font-size:11px; padding:2px 8px; border-radius:20px; display:inline-block; }
  .badge.approved { background:rgba(52,211,153,.15); color:var(--green); }
  .badge.rejected { background:rgba(248,113,113,.15); color:var(--red); }
  .badge.pending { background:#2a2a2a; color:var(--sub); }
  .badge.scheduled,.badge.ready { background:rgba(255,221,0,.15); color:var(--yellow); }
  .muted { color:var(--sub); font-size:13px; }
  .batchsel { margin:10px 0 0; }
  select { background:#0d0d0d; color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:9px 11px; font-size:14px; }
</style>
</head>
<body>
<header>
  <h1>TECHSPLAINS <span style="color:var(--yellow)">STUDIO</span></h1>
  <span class="v" id="ver"></span>
  <nav>
    <button data-view="generate" class="on">Generate</button>
    <button data-view="review">Review</button>
    <button data-view="queue">Queue</button>
  </nav>
</header>
<main id="app"></main>

<script>
const app = document.getElementById("app");
let VIEW = "generate";

const api = async (p, opts) => {
  const r = await fetch(p, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
};

document.querySelectorAll("nav button").forEach((b) =>
  b.onclick = () => { setView(b.dataset.view); });
function setView(v) {
  VIEW = v;
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  render();
}

fetch("/api/health").then((r) => r.json()).then((h) => (document.getElementById("ver").textContent = "v" + h.version));

function render() {
  if (VIEW === "generate") return renderGenerate();
  if (VIEW === "review") return renderReview();
  if (VIEW === "queue") return renderQueue();
}

// ---- Generate --------------------------------------------------------------
function renderGenerate() {
  app.innerHTML = `
    <div class="row">
      <div><label>How many videos</label><input id="g-count" type="number" value="3" min="1" style="width:110px"></div>
      <div><label>Did-you-know videos</label><input id="g-dyk" type="number" value="1" min="0" style="width:150px"></div>
      <div style="flex:1;min-width:220px"><label>Topic (optional — blank = auto variety)</label><input id="g-topic" style="width:100%" placeholder="e.g. camera gear"></div>
      <button class="btn" id="g-run">Generate batch</button>
    </div>
    <pre id="log">Ready. Set a count and hit Generate — the pipeline log streams here.</pre>`;
  const log = document.getElementById("log");
  document.getElementById("g-run").onclick = async () => {
    const btn = document.getElementById("g-run");
    btn.disabled = true;
    log.textContent = "";
    const body = JSON.stringify({
      count: +document.getElementById("g-count").value,
      dyk: +document.getElementById("g-dyk").value,
      topic: document.getElementById("g-topic").value,
    });
    try {
      const resp = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        log.textContent += dec.decode(value, { stream: true });
        log.scrollTop = log.scrollHeight;
      }
      if (log.textContent.includes("__EXIT__ 0")) {
        log.textContent += "\n✓ Done — switching to Review…";
        setTimeout(() => setView("review"), 900);
      }
    } catch (e) {
      log.textContent += "\n!! " + e.message;
    } finally {
      btn.disabled = false;
    }
  };
}

// ---- Review ----------------------------------------------------------------
let REVIEW_STAMP = null;
async function renderReview() {
  app.innerHTML = `<p class="muted">Loading batches…</p>`;
  let batches;
  try { batches = await api("/api/batches"); } catch (e) { app.innerHTML = `<p class="muted">Error: ${e.message}</p>`; return; }
  if (!batches.length) { app.innerHTML = `<p class="muted">No batches yet. Generate one first.</p>`; return; }
  if (!REVIEW_STAMP || !batches.find((b) => b.stamp === REVIEW_STAMP)) REVIEW_STAMP = batches[0].stamp;
  const opts = batches.map((b) => `<option value="${b.stamp}" ${b.stamp === REVIEW_STAMP ? "selected" : ""}>${b.stamp} (${b.videos.length})</option>`).join("");
  const batch = batches.find((b) => b.stamp === REVIEW_STAMP);
  app.innerHTML = `
    <div class="batchsel"><label>Batch</label><select id="r-sel">${opts}</select></div>
    <div class="grid" id="r-grid"></div>`;
  document.getElementById("r-sel").onchange = (e) => { REVIEW_STAMP = e.target.value; renderReview(); };
  const grid = document.getElementById("r-grid");
  grid.innerHTML = batch.videos.map((v) => cardHTML(batch.stamp, v)).join("");
  batch.videos.forEach((v) => wireCard(batch.stamp, v));
}

function cardHTML(stamp, v) {
  const id = btoa(unescape(encodeURIComponent(stamp + "|" + v.file))).replace(/=/g, "");
  return `
    <div class="card" data-id="${id}">
      <video src="/api/video/${stamp}/${encodeURIComponent(v.file)}" controls preload="metadata"></video>
      <div class="body">
        <h3>${escapeHTML(v.title)} <span class="badge ${v.status}" id="b-${id}">${v.status}</span></h3>
        <textarea id="t-${id}">${escapeHTML(v.caption || "")}</textarea>
        <div class="acts">
          <button id="a-${id}" style="color:var(--green)">Approve</button>
          <button id="x-${id}" style="color:var(--red)">Reject</button>
        </div>
      </div>
    </div>`;
}

function wireCard(stamp, v) {
  const id = btoa(unescape(encodeURIComponent(stamp + "|" + v.file))).replace(/=/g, "");
  const set = async (status) => {
    const caption = document.getElementById("t-" + id).value;
    await api("/api/approve", { method: "POST", body: JSON.stringify({ stamp, file: v.file, status, caption }) });
    const badge = document.getElementById("b-" + id);
    badge.className = "badge " + status;
    badge.textContent = status;
  };
  document.getElementById("a-" + id).onclick = () => set("approved");
  document.getElementById("x-" + id).onclick = () => set("rejected");
}

// ---- Queue (filled in Task 6) ----------------------------------------------
function renderQueue() {
  app.innerHTML = `<p class="muted">Queue — coming next.</p>`;
}

function escapeHTML(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

render();
</script>
</body>
</html>
```

- [ ] **Step 3: Add the run script temporarily and start the server**

Run: `TECHSPLAINS_DASHBOARD_PORT=4318 node scripts/techsplains-dashboard.mjs &`
Then: `sleep 2 && curl -s localhost:4318/api/health`
Expected: `{"ok":true,"version":"0.38.0"}` (or current version).

- [ ] **Step 4: Verify batches + video serving against real data**

Run: `curl -s localhost:4318/api/batches | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);console.log('batches:',b.length,'first video:',b[0]?.videos[0]?.title,'status:',b[0]?.videos[0]?.status)})"`
Expected: prints batch count ≥ 4 and the first video's title + `pending`.

Run (path traversal guard): `curl -s -o /dev/null -w "%{http_code}\n" "localhost:4318/api/video/2026-07-04T17-15/..%2f..%2fpackage.json"`
Expected: `400`.

Run (real video, expect 200/206 + mp4): `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" -r 0-1023 "localhost:4318/api/video/2026-07-04T17-15/$(curl -s localhost:4318/api/batches | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(encodeURIComponent(JSON.parse(d).find(b=>b.stamp==='2026-07-04T17-15').videos[0].file)))")"`
Expected: `206 video/mp4`.

- [ ] **Step 5: Verify approve persists**

Run: `curl -s -X POST localhost:4318/api/approve -H 'content-type: application/json' -d '{"stamp":"2026-07-04T17-15","file":"__probe__.mp4","status":"approved","caption":"hi"}' && cat config/techsplains-queue.json`
Expected: response `{"ok":true,...}` and the file contains the `2026-07-04T17-15/__probe__.mp4` key with `status:"approved"`. Then remove the probe key:
Run: `node -e "const f='config/techsplains-queue.json';const q=require('./'+f);delete q['2026-07-04T17-15/__probe__.mp4'];require('fs').writeFileSync(f,JSON.stringify(q,null,2))"`

- [ ] **Step 6: Visual check with preview tools, then stop the server**

Use `preview_start` (add a `.claude/launch.json` entry named `techsplains-dash` running `node scripts/techsplains-dashboard.mjs` on port 4318) → `preview_screenshot` the Generate screen, click the Review nav (`preview_click` `nav button[data-view="review"]`), `preview_screenshot` to confirm video cards render with Approve/Reject. Then stop the background server: `kill %1` (or the pid printed at launch).

- [ ] **Step 7: Commit**

```bash
git add scripts/techsplains-dashboard.mjs scripts/techsplains-dashboard.html .claude/launch.json
git commit -m "feat(techsplains): dashboard server + generate/review/approve

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Queue screen + scheduling

**Files:**
- Modify: `scripts/techsplains-dashboard.mjs` (add `GET /api/queue`, `POST /api/queue/schedule`)
- Modify: `scripts/techsplains-dashboard.html` (replace `renderQueue`)

**Interfaces:**
- Consumes: `computeSlots` (Task 4), queue lib (Task 2), batches lib (Task 3).
- Produces: `GET /api/queue` → approved-or-later videos with any stored `scheduledAt`; `POST /api/queue/schedule` (body `{items:[{stamp,file,scheduledAt}]}`) persists `scheduledAt` per entry. Consumed by Task 8's send flow.

- [ ] **Step 1: Add the import + queue routes to the server**

In `scripts/techsplains-dashboard.mjs`, add to the imports:

```js
import { computeSlots } from "./lib/techsplains-schedule.mjs";
```

Then add these routes before `app.listen(...)`:

```js
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

// Persist per-item scheduled times (from the client's computeSlots plan).
app.post("/api/queue/schedule", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    for (const it of items) {
      if (!it.stamp || !it.file || !it.scheduledAt) continue;
      await setEntry(keyFor(it.stamp, it.file), { scheduledAt: it.scheduledAt });
    }
    res.json({ ok: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Replace `renderQueue` in the HTML**

In `scripts/techsplains-dashboard.html`, replace the placeholder `renderQueue` function with:

```js
async function renderQueue() {
  app.innerHTML = `<p class="muted">Loading queue…</p>`;
  let items;
  try { items = await api("/api/queue"); } catch (e) { app.innerHTML = `<p class="muted">Error: ${e.message}</p>`; return; }
  if (!items.length) { app.innerHTML = `<p class="muted">Nothing approved yet. Approve videos in Review to queue them.</p>`; return; }

  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  app.innerHTML = `
    <div class="row">
      <div><label>Posts per day</label><input id="q-per" type="number" value="1" min="1" style="width:120px"></div>
      <div><label>Time of day</label><input id="q-time" type="time" value="09:00"></div>
      <div><label>Start date</label><input id="q-start" type="date" value="${tomorrow}"></div>
      <button class="btn ghost" id="q-plan">Auto-schedule</button>
      <button class="btn" id="q-send">Send to Buffer</button>
    </div>
    <p class="muted" id="q-msg" style="margin-top:10px"></p>
    <div class="grid" id="q-grid"></div>`;

  const draw = () => {
    document.getElementById("q-grid").innerHTML = items.map((it, i) => `
      <div class="card">
        <video src="/api/video/${it.stamp}/${encodeURIComponent(it.file)}" controls preload="metadata"></video>
        <div class="body">
          <h3>${escapeHTML(it.title)} <span class="badge ${it.status}">${it.status}</span></h3>
          <label>Scheduled</label>
          <input type="datetime-local" data-i="${i}" class="q-when"
            value="${it.scheduledAt ? new Date(it.scheduledAt).toISOString().slice(0,16) : ""}">
          ${it.bufferUrl ? `<div class="muted" style="margin-top:6px"><a href="${it.bufferUrl}" target="_blank" style="color:var(--yellow)">View in Buffer ↗</a></div>` : ""}
        </div>
      </div>`).join("");
    document.querySelectorAll(".q-when").forEach((el) =>
      el.onchange = (e) => { items[+e.target.dataset.i].scheduledAt = new Date(e.target.value).toISOString(); });
  };
  draw();

  document.getElementById("q-plan").onclick = () => {
    const slots = planSlots(
      +document.getElementById("q-per").value,
      document.getElementById("q-time").value,
      document.getElementById("q-start").value,
      items.length,
    );
    items.forEach((it, i) => (it.scheduledAt = slots[i]));
    draw();
  };

  document.getElementById("q-send").onclick = async () => {
    const msg = document.getElementById("q-msg");
    // Persist schedule first.
    await api("/api/queue/schedule", { method: "POST", body: JSON.stringify({ items: items.map((it) => ({ stamp: it.stamp, file: it.file, scheduledAt: it.scheduledAt })) }) });
    msg.textContent = "Sending to Buffer…";
    try {
      const r = await api("/api/queue/send", { method: "POST", body: JSON.stringify({}) });
      msg.textContent = r.mode === "manual"
        ? `Buffer video upload unavailable — ${r.sent} item(s) marked ready. Export folder: ${r.exportHint || EXPORT_DIR}`
        : `Scheduled ${r.sent} post(s) to Buffer.` + (r.failed ? ` ${r.failed} failed.` : "");
      renderQueue();
    } catch (e) {
      msg.textContent = "!! " + e.message;
    }
  };
}

// Client mirror of computeSlots (perDay posts/day, 3h apart, roll over).
function planSlots(perDay, timeOfDay, startDate, count) {
  const [hh, mm] = timeOfDay.split(":").map(Number);
  const base = new Date(startDate + "T00:00:00");
  const out = [];
  let day = 0, idx = 0;
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + day);
    d.setHours(hh + idx * 3, mm, 0, 0);
    out.push(d.toISOString());
    if (++idx >= Math.max(1, perDay)) { idx = 0; day++; }
  }
  return out;
}
```

Also add near the top of the `<script>` (after `let VIEW`): `const EXPORT_DIR = "";` — a harmless placeholder the manual-mode message references; the server sends the real hint.

- [ ] **Step 3: Start the server and verify the queue endpoint**

Run: `node scripts/techsplains-dashboard.mjs & sleep 2`
Approve one real video so the queue is non-empty:
Run: `F=$(curl -s localhost:4318/api/batches | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d).find(b=>b.stamp==='2026-07-04T17-15').videos[0].file))"); curl -s -X POST localhost:4318/api/approve -H 'content-type: application/json' -d "{\"stamp\":\"2026-07-04T17-15\",\"file\":\"$F\",\"status\":\"approved\"}"`
Run: `curl -s localhost:4318/api/queue`
Expected: a JSON array containing that video with `"status":"approved"`.

- [ ] **Step 4: Verify schedule persist**

Run: `F=$(curl -s localhost:4318/api/queue | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d)[0].file))"); curl -s -X POST localhost:4318/api/queue/schedule -H 'content-type: application/json' -d "{\"items\":[{\"stamp\":\"2026-07-04T17-15\",\"file\":\"$F\",\"scheduledAt\":\"2026-07-10T09:00:00.000Z\"}]}"; curl -s localhost:4318/api/queue | grep -o '2026-07-10T09:00'`
Expected: `{"ok":true,"count":1}` then `2026-07-10T09:00` echoed back.

- [ ] **Step 5: Visual check + stop**

`preview_screenshot` the Queue view, click Auto-schedule, confirm datetime inputs populate. Stop the server (`kill %1`). Reset the queue file if you approved test items you don't want kept.

- [ ] **Step 6: Commit**

```bash
git add scripts/techsplains-dashboard.mjs scripts/techsplains-dashboard.html
git commit -m "feat(techsplains): queue screen + auto-scheduling

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Buffer capability probe (decision gate)

**Files:**
- Create: `scripts/_buffer-video-probe.mjs` (throwaway — deleted after the decision)

**Interfaces:**
- Produces: a printed verdict — **A** (direct video upload works) or **C** (fall back to manual handoff) — that determines Task 8's `uploadAndSchedule` implementation.

**Precondition:** `BUFFER_API_KEY` and `BUFFER_TECHSPLAINS_CHANNEL` must be in `.env`. If the user hasn't connected the Techsplains Facebook page to Buffer yet, PAUSE here — Tasks 5–6 are fully usable without Buffer; only Task 8 depends on this. Ask the user to finish Buffer connection, then resume.

- [ ] **Step 1: Write the probe**

Create `scripts/_buffer-video-probe.mjs`:

```js
#!/usr/bin/env node
// THROWAWAY: probes whether Buffer's API accepts a direct video upload from a
// local file, so we know whether the dashboard can auto-post (A) or must fall
// back to manual handoff (C). Delete after running once.
//
//   node scripts/_buffer-video-probe.mjs <path-to-any.mp4>

import fs from "node:fs";
import { applyTechsplainsGcpEnv } from "./lib/techsplains.mjs";

// Load repo .env the same minimal way lib/techsplains.mjs does.
applyTechsplainsGcpEnv();
const KEY = process.env.BUFFER_API_KEY;
const CHANNEL = process.env.BUFFER_TECHSPLAINS_CHANNEL;
const mp4 = process.argv[2];

if (!KEY || !CHANNEL) { console.error("Need BUFFER_API_KEY and BUFFER_TECHSPLAINS_CHANNEL in .env"); process.exit(2); }
if (!mp4 || !fs.existsSync(mp4)) { console.error("Pass a path to an existing .mp4"); process.exit(2); }

const API = "https://api.buffer.com";
const gql = async (query, variables = {}) => {
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
};

// 1) Ask the schema what media/upload mutations exist (introspection).
const intro = await gql(`{ __schema { mutationType { fields { name args { name } } } } }`);
const mutations = intro?.data?.__schema?.mutationType?.fields?.map((f) => f.name) || [];
const uploadish = mutations.filter((n) => /upload|media|asset|video/i.test(n));
console.log("Upload-ish mutations exposed:", uploadish.length ? uploadish.join(", ") : "(none)");

if (!uploadish.length) {
  console.log("\nVERDICT: C — no direct upload mutation. Dashboard uses manual handoff.");
  process.exit(0);
}

console.log("\nVERDICT: A (likely) — direct upload mutation(s) present:", uploadish.join(", "));
console.log("Task 8 implements uploadAndSchedule against:", uploadish[0]);
console.log("(Inspect its args above to finalize the multipart/URL shape.)");
```

- [ ] **Step 2: Run the probe against a real rendered video**

Run: `node scripts/_buffer-video-probe.mjs "$(node -e "const {resolveClient}=require('./scripts/lib/client.mjs')" 2>/dev/null; ls "/Users/macbookpro/Downloads/Work/02_Clients/Techsplains/05_Exports/Difference Videos/2026-07-04T17-15/"*.mp4 | head -1)"`
Expected: prints the exposed upload-ish mutations and a `VERDICT: A` or `VERDICT: C` line.

- [ ] **Step 3: Record the verdict in the plan and delete the probe**

Write the verdict (A or C, and the mutation name + arg shape if A) as a comment at the top of `scripts/lib/techsplains-buffer.mjs` when you create it in Task 8. Then:
Run: `rm scripts/_buffer-video-probe.mjs`

- [ ] **Step 4: Commit the decision**

```bash
git add -A
git commit -m "chore(techsplains): probe Buffer video-upload capability (verdict recorded)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Buffer send endpoint (upload + schedule, with manual fallback)

**Files:**
- Create: `scripts/lib/techsplains-buffer.mjs`
- Modify: `scripts/techsplains-dashboard.mjs` (add `POST /api/queue/send`)

**Interfaces:**
- Consumes: queue lib (Task 2), batches lib (`safeExportPath`, Task 3), the Task 7 verdict.
- Produces: `bufferConfigured() => boolean`; `uploadAndSchedule({videoPath, caption, dueAt}) => Promise<{postId, url}>` (throws `BufferUnsupported` if verdict was C). Server route `POST /api/queue/send` → `{mode:"buffer"|"manual", sent, failed, exportHint}`.

> **Implementation note:** the `uploadAndSchedule` body below is the **verdict-A** path using the existing June-2026 GraphQL `createPost` shape from `buffer-poster.mjs` plus the upload mutation the probe found. If the probe returned **C**, implement `uploadAndSchedule` as a single `throw new BufferUnsupported()` and skip its network code — the server route already handles that by switching to manual mode.

- [ ] **Step 1: Write the Buffer lib**

Create `scripts/lib/techsplains-buffer.mjs`:

```js
// Buffer posting for Techsplains videos.
// VERDICT FROM TASK 7 PROBE: <A or C — fill in>. If C, uploadAndSchedule just
// throws BufferUnsupported and the dashboard falls back to manual handoff.

import fs from "node:fs";

const API = "https://api.buffer.com";

export class BufferUnsupported extends Error {
  constructor(msg = "Buffer video upload unavailable") { super(msg); this.name = "BufferUnsupported"; }
}

export function bufferConfigured() {
  return Boolean(process.env.BUFFER_API_KEY && process.env.BUFFER_TECHSPLAINS_CHANNEL);
}

async function gql(query, variables = {}) {
  const r = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.BUFFER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

// --- VERDICT A path --------------------------------------------------------
// Fill the exact upload mutation + fields from the probe output. This mirrors
// the createPost shape buffer-poster.mjs already uses (June-2026 schema).
export async function uploadAndSchedule({ videoPath, caption, dueAt }) {
  if (!bufferConfigured()) throw new BufferUnsupported("Buffer not configured");

  // 1) Upload the local MP4 → media handle. (Mutation name/args from probe.)
  //    If the probe showed a signed-URL flow instead, request the URL here,
  //    PUT the bytes, then reference the returned id.
  const bytes = fs.readFileSync(videoPath);
  const uploaded = await gql(
    `mutation($file: Upload!) { uploadVideo(file: $file) { id } }`, // <- replace with probe's mutation
    { file: bytes },
  );
  const mediaId = uploaded?.uploadVideo?.id;
  if (!mediaId) throw new Error("upload returned no media id");

  // 2) Create the scheduled post referencing the media handle.
  const channelId = process.env.BUFFER_TECHSPLAINS_CHANNEL;
  const data = await gql(
    `mutation($input: PostCreateInput!) { createPost(input: $input) { id url } }`,
    { input: { channelId, text: caption, dueAt, media: [{ id: mediaId }] } },
  );
  const post = data?.createPost;
  if (!post?.id) throw new Error("createPost returned no id");
  return { postId: post.id, url: post.url || null };
}
```

- [ ] **Step 2: Add the send route to the server**

In `scripts/techsplains-dashboard.mjs`, add to imports:

```js
import { bufferConfigured, uploadAndSchedule, BufferUnsupported } from "./lib/techsplains-buffer.mjs";
```

Add before `app.listen(...)`:

```js
// --- Send approved+scheduled videos to Buffer (or mark ready for manual) ----
app.post("/api/queue/send", async (_req, res) => {
  try {
    const queue = await readQueue();
    const stamps = await listStamps(EXPORT_DIR);
    const targets = [];
    for (const stamp of stamps) {
      const { videos } = await loadBatch(EXPORT_DIR, stamp);
      for (const v of videos) {
        const entry = queue[keyFor(stamp, v.file)];
        if (entry?.status === "approved") targets.push({ stamp, file: v.file, entry, caption: entry.caption ?? v.caption });
      }
    }

    if (!bufferConfigured()) {
      for (const t of targets) await setEntry(keyFor(t.stamp, t.file), { status: "ready" });
      return res.json({ mode: "manual", sent: targets.length, failed: 0, exportHint: EXPORT_DIR });
    }

    let sent = 0, failed = 0, manual = false;
    for (const t of targets) {
      try {
        const abs = safeExportPath(EXPORT_DIR, t.stamp, t.file);
        const dueAt = t.entry.scheduledAt || new Date(Date.now() + 3600e3).toISOString();
        const { postId, url } = await uploadAndSchedule({ videoPath: abs, caption: t.caption, dueAt });
        await setEntry(keyFor(t.stamp, t.file), { status: "scheduled", bufferPostId: postId, bufferUrl: url });
        sent += 1;
      } catch (err) {
        if (err instanceof BufferUnsupported) { manual = true; break; }
        failed += 1;
        console.warn(`Buffer send failed ${t.file}: ${err.message}`);
      }
    }
    if (manual) {
      for (const t of targets) await setEntry(keyFor(t.stamp, t.file), { status: "ready" });
      return res.json({ mode: "manual", sent: targets.length, failed: 0, exportHint: EXPORT_DIR });
    }
    res.json({ mode: "buffer", sent, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Verify the manual-fallback path (works with no Buffer config)**

Temporarily ensure Buffer is unconfigured for this check:
Run: `env -u BUFFER_API_KEY -u BUFFER_TECHSPLAINS_CHANNEL node scripts/techsplains-dashboard.mjs & sleep 2`
Approve a video (as in Task 6 Step 3), then:
Run: `curl -s -X POST localhost:4318/api/queue/send -d '{}' -H 'content-type: application/json'`
Expected: `{"mode":"manual","sent":N,"failed":0,"exportHint":"…/Difference Videos"}` and the approved item's status is now `ready` in `config/techsplains-queue.json`. Stop the server.

- [ ] **Step 4: Verify the Buffer path (only if verdict A and Buffer configured)**

Run: `node scripts/techsplains-dashboard.mjs & sleep 2`
Approve one video, hit send:
Run: `curl -s -X POST localhost:4318/api/queue/send -d '{}' -H 'content-type: application/json'`
Expected (verdict A): `{"mode":"buffer","sent":1,"failed":0}` and the item shows `scheduled` with a `bufferUrl`. Confirm the draft/scheduled post appears in the Buffer web UI. If it errors, read the message, fix the mutation shape per the probe, re-run. Stop the server. (If verdict was C, skip this step — manual mode is the shipped behavior.)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/techsplains-buffer.mjs scripts/techsplains-dashboard.mjs
git commit -m "feat(techsplains): Buffer send endpoint with manual fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Wiring — run script, version bump, gitignore

**Files:**
- Modify: `package.json` (add script, bump version)
- Modify: `.gitignore`
- Modify: `scripts/techsplains-dashboard.html` (header shows the new version automatically via `/api/health` — no change needed beyond confirming)

- [ ] **Step 1: Add the npm script**

In `package.json` `"scripts"`, after the existing `"techsplains:batch"` line, add:

```json
"techsplains:dashboard": "node scripts/techsplains-dashboard.mjs",
```

- [ ] **Step 2: Bump the version**

In `package.json`, change `"version": "0.38.0"` to `"version": "0.39.0"`.

- [ ] **Step 3: Gitignore the local queue state**

Append to `.gitignore`:

```
# Techsplains dashboard local-only queue/approval state
config/techsplains-queue.json
```

- [ ] **Step 4: Verify the whole thing end-to-end from the npm script**

Run: `npm run techsplains:dashboard & sleep 2 && curl -s localhost:4318/api/health`
Expected: `{"ok":true,"version":"0.39.0"}`.

`preview_screenshot` the header — confirm it reads `v0.39.0`. Stop the server.

Run: `git status --porcelain config/techsplains-queue.json`
Expected: no output (the file is now ignored).

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore
git commit -m "chore(techsplains): dashboard run script, v0.39.0, gitignore queue state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** Generate (Task 5) · Review + approve + editable caption (Task 5) · inline video (Task 5) · Queue + scheduling (Task 6) · manifest emit + captions fallback (Tasks 1, 3) · queue state file + gitignore (Tasks 2, 9) · path-traversal guard (Task 3, verified Task 5) · Buffer A-with-C-fallback (Tasks 7, 8) · isolation (Global Constraints) · version bump + header (Task 9). All spec sections map to a task.
- **Buffer risk is quarantined:** everything through Task 6 is a working, useful tool with zero Buffer dependency. If the user hasn't connected Buffer yet, ship Tasks 1–6 and 9 (drop the `techsplains:dashboard` version-bump note to whatever's current), and land Tasks 7–8 when Buffer is ready.
- **No new deps.** `node --test`, `express` (existing), native `fetch`/`spawn` only.
- **Type consistency:** `keyFor(stamp,file)`, `{status,caption,scheduledAt,bufferPostId,bufferUrl}` entry shape, and `{stamp,file,title,caption,variant,durationSec,status}` video shape are used identically across Tasks 2–8.
```
