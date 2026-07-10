# Techsplains Course Production Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Markdown-to-themed-PDF pipeline for the Techsplains course (per `docs/superpowers/specs/2026-07-10-techsplains-pdf-course-design.md`), and prove it end-to-end by producing real Branded and Blank PDFs for one real module and one real bonus doc.

**Architecture:** Course content is authored as Markdown files with YAML frontmatter under `course/content/`. A shared content-loading library resolves `{{sidebar:N}}` placeholders against real Techsplains difference-pair data (text + already-sourced photos) already sitting in `out/techsplains-scripts-*.json` / `public/generated-diff/`. A render layer wraps the resulting HTML in one of two CSS themes (`branded` / `blank`) and prints it to PDF via a shared Puppeteer browser instance. A CLI orchestrator discovers all content files and writes the final `Techsplains-Editing-Course/{Branded,Blank}/*.pdf` folder structure.

**Tech Stack:** Node.js (ESM, `node:test` runner — matches existing `scripts/__tests__/*.test.mjs` convention), `gray-matter` (frontmatter), `marked` (Markdown→HTML), `puppeteer` (headless Chromium print-to-PDF, new dependency — no headless-browser tooling exists in this repo yet).

## Global Constraints

- Branded and Blank versions must be **word-for-word identical** in content — only the visual theme (logo, colors, follow-footer) differs. (spec, Folder & File Structure)
- The free lead magnet is Techsplains-branded only and is never duplicated for the Blank/second-page channel. (spec, Freebies) — not built in this plan; see Scope Note below.
- Reused sidebar content must come from **real, already-sourced** Techsplains video data (topic text + real photos) — never invented or re-worded. (spec, Visual Content Strategy)
- This pipeline only ever produces local files. No task in this plan posts to, schedules on, or otherwise touches any social platform. (spec, Out of Scope)
- Pipeline code lives under `research/content-studio/`, alongside the existing `scripts/lib/techsplains*.mjs` pipeline, following its conventions (`scripts/lib/*.mjs` for shared logic, `scripts/*.mjs` for CLI entry points, `scripts/__tests__/*.test.mjs` run via `node --test`). (spec, Production Pipeline)

## Scope Note

The full spec covers 8 modules, 5 bonus PDFs, and a free lead magnet — most of that is prose that doesn't exist yet and can't be faked without violating the "no placeholders" and "real sourced content only" rules above. This plan builds the **complete, reusable pipeline** (content loader, topic lookup, theming, PDF rendering, folder assembly) and proves it works by shipping **one real module (Module 2: "The Cut") and one real bonus doc (Quick-Reference Glossary)** — both built from difference-pair data that is verified present on disk right now (`out/techsplains-scripts-2026-07-09T21-20.json`, images in `public/generated-diff/2026-07-09T21-20/`). Writing the remaining 7 modules, 4 bonus PDFs, and the lead magnet is a separate, content-focused follow-up plan — the pipeline built here needs zero code changes to absorb them; dropping new `.md` files into `course/content/modules/` or `course/content/bonus/` is enough.

---

### Task 1: Extract shared image-sourcing helpers

**Files:**
- Create: `scripts/lib/image-sourcing.mjs`
- Modify: `scripts/generate-diff-images.mjs`
- Test: `scripts/__tests__/image-sourcing.test.mjs`

**Interfaces:**
- Produces: `pickBest(thumbBufs, label, query, otherLabel) => Promise<number>`, `fetchBuf(url, minBytes=1) => Promise<Buffer>`, `stockImage(query, label, otherLabel, usedIds, outAbs) => Promise<boolean>`, `genImage(prompt, outAbs, fallbackPrompt) => Promise<boolean>`, `STYLE_TAIL: string` — all exported from `scripts/lib/image-sourcing.mjs`. Task 3 (via a future mockup script) and `generate-diff-images.mjs` both depend on these exact names.

**Baseline note:** `generate-diff-images.mjs` currently has an *uncommitted* local edit that already removed the Google Images/Custom-Search source (Google closed that API to new customers — every call 403s regardless of key/billing). This task's "current file" is that post-removal version, not the older version with a `googleImage` function — extract only `pickBest`, `fetchBuf`, `stockImage`, `genImage`, `STYLE_TAIL`. This is a behavior-preserving extraction: `generate-diff-images.mjs` currently defines these functions inline. Pulling them into a shared module lets the course pipeline reuse the exact same vision-gated sourcing logic instead of duplicating ~130 lines, per the spec's Visual Content Strategy.

**Important ordering detail:** `generate-diff-images.mjs` currently calls `applyTechsplainsGcpEnv()` *before* constructing the `GoogleGenAI` client, because the client reads `GOOGLE_APPLICATION_CREDENTIALS` from `process.env` at construction time. ES module imports evaluate before the importing file's own top-level code runs, so if the credential-setting call stays in `generate-diff-images.mjs`, a future importer of `image-sourcing.mjs` that doesn't happen to call it first would construct the client with the wrong (or no) credentials. Move `applyTechsplainsGcpEnv()` into `image-sourcing.mjs` itself, at the top, before the client is constructed, so every importer gets correct credentials regardless of import order.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/image-sourcing.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import * as imageSourcing from "../lib/image-sourcing.mjs";

test("image-sourcing exports the vision-gated sourcing functions", () => {
  assert.equal(typeof imageSourcing.pickBest, "function");
  assert.equal(typeof imageSourcing.fetchBuf, "function");
  assert.equal(typeof imageSourcing.stockImage, "function");
  assert.equal(imageSourcing.stockImage.length, 5);
  assert.equal(typeof imageSourcing.genImage, "function");
  assert.equal(imageSourcing.genImage.length, 3);
  assert.equal(typeof imageSourcing.STYLE_TAIL, "string");
  assert.match(imageSourcing.STYLE_TAIL, /No text, no words/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/__tests__/image-sourcing.test.mjs`
Expected: FAIL — `Cannot find module '../lib/image-sourcing.mjs'`

- [ ] **Step 3: Create `scripts/lib/image-sourcing.mjs`**

```js
// scripts/lib/image-sourcing.mjs
// Shared vision-gated image sourcing (Pexels → Gemini AI fallback),
// extracted from generate-diff-images.mjs so any Techsplains pipeline
// (videos, the PDF course) can source images at the same quality bar
// without duplicating this logic.
//
// (Google Images via Custom Search was removed 2026-07: Google closed the
// Custom Search JSON API to new customers — every call 403s with "This
// project does not have the access", regardless of key/billing/API-enable.
// Existing customers must migrate off it by 2027-01-01 anyway.)

import fs from "node:fs/promises";
import { GoogleGenAI } from "@google/genai";
import { applyTechsplainsGcpEnv, TS_GCP } from "./techsplains.mjs";

// Must run before constructing the client below — an importer of this
// module may not have called this itself yet, and GoogleGenAI reads
// GOOGLE_APPLICATION_CREDENTIALS at construction time.
applyTechsplainsGcpEnv();

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
// Fresh GCP projects get a low requests-per-minute quota on the image model —
// run sequentially and retry 429s with backoff rather than failing the slot.
const MAX_RETRIES = 5;

const ai = new GoogleGenAI({
  vertexai: true,
  project: TS_GCP.project,
  location: TS_GCP.imageLocation,
});

export const STYLE_TAIL =
  " Vertical-friendly square composition, subject fills the frame, bright and " +
  "clear at thumbnail size. No text, no words, no letters, no watermark, no logos.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Image sources: Pexels stock → AI generation ─────────────────────────────
const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
let warnedNoPexels = false;

// Vision gate: image search ranks by popularity, not accuracy — Pexels' first
// hit for "lavalier microphone" was a handheld Shure. Show the candidate
// thumbnails to gemini-2.5-flash and let it pick the one that actually
// depicts the thing; -1 means none qualify and the caller falls through.
export async function pickBest(thumbBufs, label, query, otherLabel) {
  const parts = thumbBufs.map((buf) => ({
    inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") },
  }));
  if (!parts.length) return -1;
  parts.push({
    text:
      `These ${parts.length} photos are numbered 1..${parts.length} in order. ` +
      `Which one best and unmistakably shows: "${label}" (search was "${query}")? ` +
      `Requirements, in priority order: ` +
      `(1) it actually depicts that specific thing — not a related or similar-looking object` +
      (otherLabel
        ? `, and NOT a ${otherLabel} (the video contrasts the two) or anything mistakable for one`
        : "") +
      `; (2) it reads like an OBVIOUS textbook/stock example: bright, simple, ` +
      `subject clear and centered, instantly readable at thumbnail size. ` +
      `Visible stock-site watermarks are perfectly acceptable. ` +
      `Reject moody, dark, artistic, heavily blurred, or cluttered shots even if the subject is right. ` +
      `Reply with ONLY the number, or NONE if none clearly qualifies.`,
  });
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
  });
  const answer = (resp.text || "").trim().toUpperCase();
  const n = parseInt(answer, 10);
  return Number.isInteger(n) && n >= 1 && n <= thumbBufs.length ? n - 1 : -1;
}

export const fetchBuf = async (url, minBytes = 1) => {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.startsWith("image/")) throw new Error(`not an image (${type})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < minBytes) throw new Error("too small");
  return buf;
};

export async function stockImage(query, label, otherLabel, usedIds, outAbs) {
  if (!PEXELS_KEY) {
    if (!warnedNoPexels) {
      console.warn("  PEXELS_API_KEY not set — falling back to AI image generation for ALL slots.");
      warnedNoPexels = true;
    }
    return false;
  }
  // Two searches: a "white background"-biased one for basic catalog shots,
  // then the plain query. Pexels ranks artsy/editorial photos first, which
  // the user rejected — the biased query surfaces plainer product shots.
  const collected = [];
  const seen = new Set();
  for (const q of [`${query} white background`, query]) {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=8&orientation=square`;
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } });
    if (res.status === 429) throw new Error("Pexels rate limit (429)");
    if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
    const json = await res.json();
    for (const p of json.photos || []) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        collected.push(p);
      }
    }
  }
  // Never reuse a photo already placed in this video — related search queries
  // (ring light / softbox) can rank the same popular photo first for both.
  const candidates = collected.filter(
    (p) => p.width >= 900 && p.height >= 900 && !usedIds.has(p.id),
  ).slice(0, 8);
  if (!candidates.length) return false;
  let pick;
  try {
    const thumbs = [];
    const valid = [];
    for (const p of candidates) {
      try {
        thumbs.push(await fetchBuf(p.src.medium || p.src.small));
        valid.push(p);
      } catch { /* skip unfetchable */ }
    }
    pick = await pickBest(thumbs, label, query, otherLabel);
    if (pick === -1) {
      console.log(`    vision gate: no Pexels hit actually shows "${label}" — AI fallback`);
      return false;
    }
    candidates.length = 0;
    candidates.push(...valid);
  } catch (err) {
    console.warn(`    vision gate failed (${String(err.message || err).slice(0, 50)}) — using first result`);
    pick = 0;
  }
  const photo = candidates[pick];
  const imgUrl = photo.src?.large2x || photo.src?.large || photo.src?.original;
  const imgRes = await fetch(imgUrl);
  if (!imgRes.ok) throw new Error(`Pexels download HTTP ${imgRes.status}`);
  await fs.writeFile(outAbs, Buffer.from(await imgRes.arrayBuffer()));
  usedIds.add(photo.id);
  return true;
}

export async function genImage(prompt, outAbs, fallbackPrompt) {
  let lastErr;
  let textOnlyCount = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // A prompt that keeps producing text-only replies is usually internally
    // contradictory (e.g. "binary code … no letters") — after two of those,
    // stop re-asking the impossible and switch to the simple label fallback.
    const usePrompt = textOnlyCount >= 2 && fallbackPrompt ? fallbackPrompt : prompt;
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: usePrompt + STYLE_TAIL,
        config: { responseModalities: ["TEXT", "IMAGE"] },
      });
      const parts = resp.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          await fs.writeFile(outAbs, Buffer.from(p.inlineData.data, "base64"));
          return true;
        }
      }
      textOnlyCount++;
      throw new Error("no image in response");
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      const retryable = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("no image in response") || msg.includes("503");
      if (!retryable || attempt === MAX_RETRIES) break;
      const wait = msg.includes("no image in response")
        ? 2000
        : Math.min(60000, 8000 * 2 ** attempt);
      console.log(`    …retry ${attempt + 1}/${MAX_RETRIES} in ${wait / 1000}s (${msg.slice(0, 60)})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/__tests__/image-sourcing.test.mjs`
Expected: PASS (1 test, all assertions green)

- [ ] **Step 5: Update `scripts/generate-diff-images.mjs` to import from the shared module**

Replace the full file contents with:

```js
#!/usr/bin/env node
// Techsplains step 2/4 — source the two comparison images per segment
// (4 per video). REAL STOCK PHOTOS first (Pexels search on the script's
// searchQuery — the user rejected AI-rendered examples); Vertex image gen
// (gemini-2.5-flash-image) only as the fallback when the stock search misses.
//
// Usage:
//   PEXELS_API_KEY=... node scripts/generate-diff-images.mjs <scripts.json>
//
// Writes images to public/generated-diff/<stamp>/ and adds aImg/bImg (paths
// relative to public/) to each segment in the JSON, in place.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./lib/client.mjs";
import { stockImage, genImage } from "./lib/image-sourcing.mjs";

const scriptsArg = process.argv[2];
if (!scriptsArg) {
  console.error("Usage: node scripts/generate-diff-images.mjs <scripts.json>");
  process.exit(1);
}
const scriptsPath = path.isAbsolute(scriptsArg)
  ? scriptsArg
  : path.join(process.cwd(), scriptsArg);
const videos = JSON.parse(await fs.readFile(scriptsPath, "utf-8"));

// Batch stamp from the scripts filename so all steps share one folder name.
const stamp =
  scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] ||
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const relDir = path.posix.join("generated-diff", stamp);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const PEXELS_KEY = process.env.PEXELS_API_KEY || "";
const CONCURRENCY = parseInt(process.env.TECHSPLAINS_IMG_CONCURRENCY || "1", 10);

// Flatten all slots, run with bounded concurrency (same idea as poster-batch).
const jobs = [];
videos.forEach((v, vi) => {
  v.segments.forEach((s, si) => {
    jobs.push({ v, s, vi, si, side: "a", prompt: s.aImagePrompt, query: s.aSearchQuery });
    // "didyouknow" segments are single-image: no B side.
    if (s.bLabel) jobs.push({ v, s, vi, si, side: "b", prompt: s.bImagePrompt, query: s.bSearchQuery });
  });
});

console.log(
  `Sourcing ${jobs.length} comparison image(s) — Pexels stock${PEXELS_KEY ? "" : " (NO KEY)"} → image-gen fallback…`,
);
let done = 0;
let failed = 0;
let cursor = 0;
const usedByVideo = new Map();
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const base = `${String(job.vi + 1).padStart(2, "0")}-${job.si + 1}${job.side}`;
    const label = job.side === "a" ? job.s.aLabel : job.s.bLabel;
    const otherLabel = job.side === "a" ? job.s.bLabel : job.s.aLabel;
    if (!usedByVideo.has(job.vi)) usedByVideo.set(job.vi, new Set());
    const usedIds = usedByVideo.get(job.vi);
    // Context matters: without it the model illustrates the WORD, not the
    // concept — "Thunderbolt" (the port) came back as a storm cloud. For
    // "general" videos the literal meaning IS the subject (frog, jam, moth),
    // so only steer away from it on tech categories.
    const fallback =
      `clean minimal flat illustration representing "${label}" in the context of ` +
      `"${job.v.title}" (a ${job.v.category} explainer video). ` +
      (job.v.category === "general"
        ? `Depict the everyday subject itself, literally and recognizably. `
        : `Depict the actual tech concept, never the literal/weather/food meaning of the word. `) +
      `Single centered subject, friendly and clear.`;
    // Resume support: a slot that already generated (path in JSON + file on
    // disk) is skipped, so quota-starved reruns only pay for the gaps.
    const existingRel = job.s[job.side === "a" ? "aImg" : "bImg"];
    if (existingRel) {
      try {
        await fs.access(path.join(projectRoot, "public", existingRel));
        done++;
        console.log(`  [${done + failed}/${jobs.length}] SKIP ${base} (already sourced)`);
        continue;
      } catch { /* file gone — regenerate */ }
    }
    try {
      // Source order: Pexels stock → AI generation.
      let rel;
      let source = "";
      const stockOut = path.join(absDir, `${base}.jpg`);
      try {
        if (await stockImage(job.query || label, label, otherLabel, usedIds, stockOut))
          source = "pexels";
      } catch (err) {
        console.warn(`    pexels search failed (${String(err.message || err).slice(0, 60)})`);
      }
      if (source) {
        rel = path.posix.join(relDir, `${base}.jpg`);
      } else {
        await genImage(job.prompt, path.join(absDir, `${base}.png`), fallback);
        rel = path.posix.join(relDir, `${base}.png`);
        source = "AI";
      }
      job.s[job.side === "a" ? "aImg" : "bImg"] = rel;
      done++;
      console.log(`  [${done + failed}/${jobs.length}] ${path.posix.basename(rel)} [${source}]  (${job.v.title} — ${label})`);
    } catch (err) {
      failed++;
      console.warn(`  [${done + failed}/${jobs.length}] FAILED ${base}: ${String(err.message || err).slice(0, 140)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await fs.writeFile(scriptsPath, JSON.stringify(videos, null, 2));
console.log(`\n✓ ${done}/${jobs.length} image(s) → public/${relDir}`);
if (failed) console.log(`  (${failed} failed — render step will skip incomplete videos)`);
```

- [ ] **Step 6: Verify the refactor didn't break syntax**

Run: `node --check scripts/generate-diff-images.mjs && node --check scripts/lib/image-sourcing.mjs`
Expected: both exit silently (no output = valid syntax)

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/image-sourcing.mjs scripts/generate-diff-images.mjs scripts/__tests__/image-sourcing.test.mjs
git commit -m "$(cat <<'EOF'
Extract vision-gated image sourcing into scripts/lib/image-sourcing.mjs

Behavior-preserving refactor so the course pipeline can reuse the exact
same Pexels/Gemini sourcing logic instead of duplicating it.
EOF
)"
```

---

### Task 2: Content-loading library (topic lookup + Markdown rendering)

**Files:**
- Create: `scripts/lib/course-content.mjs`
- Test: `scripts/__tests__/course-content.test.mjs`
- Test fixtures: `scripts/__tests__/fixtures/course/out/techsplains-scripts-fixture.json`, `scripts/__tests__/fixtures/course/public/generated-diff/fixture/01-1a.jpg`, `scripts/__tests__/fixtures/course/public/generated-diff/fixture/01-1b.jpg`, `scripts/__tests__/fixtures/course/sample-module.md`

**Interfaces:**
- Consumes: none (first pipeline-specific module; only depends on `projectRoot` from `scripts/lib/client.mjs`, already used throughout the repo).
- Produces: `escapeHtml(s) => string`, `buildTopicIndex(dir?) => Promise<Map>`, `findTopic(index, aLabel, bLabel, {publicDir}?) => Promise<{title,aLabel,bLabel,defA,defB,aImg,bImg}>`, `renderModuleMarkdown(filePath, topicIndex, {publicDir}?) => Promise<{title,moduleNumber,tier,bodyHtml}>` — all exported from `scripts/lib/course-content.mjs`. Task 3's `course-render.mjs` imports `escapeHtml`; Task 4's `course-assemble.mjs` imports `buildTopicIndex` and `renderModuleMarkdown`.

**Setup — install the two new dependencies this task needs:**

```bash
npm install marked gray-matter
```

- [ ] **Step 1: Write the failing tests**

Create the fixture directory and files first:

```bash
mkdir -p scripts/__tests__/fixtures/course/out
mkdir -p scripts/__tests__/fixtures/course/public/generated-diff/fixture
```

Create `scripts/__tests__/fixtures/course/out/techsplains-scripts-fixture.json`:

```json
[
  {
    "title": "Cut vs Transition & J-cut vs L-cut",
    "category": "editing",
    "variant": "difference",
    "segments": [
      {
        "aLabel": "Cut",
        "bLabel": "Transition",
        "defA": "A cut instantly changes from one shot to the next.",
        "defB": "A transition is a visual effect that smoothly connects two shots.",
        "aImg": "generated-diff/fixture/01-1a.jpg",
        "bImg": "generated-diff/fixture/01-1b.jpg"
      }
    ]
  }
]
```

Create the two placeholder image files (existence is all `findTopic` checks — contents don't need to be valid JPEGs):

```bash
echo "fixture" > scripts/__tests__/fixtures/course/public/generated-diff/fixture/01-1a.jpg
echo "fixture" > scripts/__tests__/fixtures/course/public/generated-diff/fixture/01-1b.jpg
```

Create `scripts/__tests__/fixtures/course/sample-module.md`:

```markdown
---
title: "Sample Module"
moduleNumber: 99
tier: fundamentals
sidebars:
  - a: "Cut"
    b: "Transition"
---

# Sample Module

Intro text.

{{sidebar:0}}

More text.
```

Create `scripts/__tests__/course-content.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";
import { buildTopicIndex, findTopic, renderModuleMarkdown, escapeHtml } from "../lib/course-content.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_OUT = path.join(__dirname, "fixtures", "course", "out");
const FIXTURE_PUBLIC = path.join(__dirname, "fixtures", "course", "public");
const FIXTURE_MODULE = path.join(__dirname, "fixtures", "course", "sample-module.md");

test("escapeHtml escapes the five HTML-significant characters", () => {
  assert.equal(escapeHtml(`<a href="x">T&om's</a>`), "&lt;a href=&quot;x&quot;&gt;T&amp;om&#39;s&lt;/a&gt;");
});

test("buildTopicIndex + findTopic resolves a known difference-pair by label", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  const topic = await findTopic(index, "Cut", "Transition", { publicDir: FIXTURE_PUBLIC });
  assert.equal(topic.defA, "A cut instantly changes from one shot to the next.");
  assert.equal(topic.defB, "A transition is a visual effect that smoothly connects two shots.");
  assert.equal(topic.aImg, "generated-diff/fixture/01-1a.jpg");
});

test("findTopic is case/whitespace-insensitive on labels", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  const topic = await findTopic(index, "  cut ", "TRANSITION", { publicDir: FIXTURE_PUBLIC });
  assert.equal(topic.aLabel, "Cut");
});

test("findTopic throws a clear, actionable error for an unsourced pair", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  await assert.rejects(
    () => findTopic(index, "Codec", "Container", { publicDir: FIXTURE_PUBLIC }),
    /No sourced topic found for "Codec" vs "Container"/,
  );
});

test("findTopic throws when the image file is missing on disk", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  await assert.rejects(
    () => findTopic(index, "Cut", "Transition", { publicDir: path.join(__dirname, "fixtures", "course", "nonexistent-public") }),
    /file is missing on disk/,
  );
});

test("renderModuleMarkdown resolves {{sidebar:N}} into a Did-You-Know box", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  const { title, moduleNumber, tier, bodyHtml } = await renderModuleMarkdown(FIXTURE_MODULE, index, { publicDir: FIXTURE_PUBLIC });
  assert.equal(title, "Sample Module");
  assert.equal(moduleNumber, 99);
  assert.equal(tier, "fundamentals");
  // Tolerant of marked possibly adding heading attributes across versions —
  // the point of this assertion is "the heading rendered", not its exact tag.
  assert.match(bodyHtml, /<h1[^>]*>Sample Module<\/h1>/);
  assert.match(bodyHtml, /class="sidebar"/);
  assert.match(bodyHtml, /A cut instantly changes from one shot to the next\./);
  assert.match(bodyHtml, /src="generated-diff\/fixture\/01-1a\.jpg"/);
});

test("renderModuleMarkdown throws if a {{sidebar:N}} has no matching frontmatter entry", async () => {
  const badPath = path.join(__dirname, "fixtures", "course", "bad-module.md");
  const fs = await import("node:fs/promises");
  await fs.writeFile(badPath, `---\ntitle: "Bad"\nsidebars: []\n---\n\nBody {{sidebar:0}}\n`);
  const index = await buildTopicIndex(FIXTURE_OUT);
  await assert.rejects(
    () => renderModuleMarkdown(badPath, index, { publicDir: FIXTURE_PUBLIC }),
    /only defines 0 sidebar\(s\)/,
  );
  await fs.rm(badPath);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/__tests__/course-content.test.mjs`
Expected: FAIL — `Cannot find module '../lib/course-content.mjs'`

- [ ] **Step 3: Create `scripts/lib/course-content.mjs`**

```js
// scripts/lib/course-content.mjs
// Content-loading layer for the Techsplains PDF course: looks up reused
// difference-pair topics (text + real sourced images) from the existing
// video pipeline's output, and turns course Markdown files into HTML with
// {{sidebar:N}} placeholders resolved into "Did You Know?" boxes.

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { projectRoot } from "./client.mjs";

const norm = (s) => String(s || "").trim().toLowerCase();

export function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Scans every techsplains-scripts-*.json in `dir` and indexes every segment
// by its normalized "aLabel|bLabel" key. `out/` (and public/generated-diff/)
// are gitignored/local-only — this index only ever reflects whatever batches
// currently exist on the machine running it.
export async function buildTopicIndex(dir = path.join(projectRoot, "out")) {
  const index = new Map();
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => /^techsplains-scripts-.*\.json$/.test(f));
  } catch {
    return index;
  }
  for (const f of files.sort()) {
    let videos;
    try {
      videos = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    for (const v of videos) {
      for (const s of v.segments || []) {
        if (!s.aLabel) continue;
        const key = `${norm(s.aLabel)}|${norm(s.bLabel)}`;
        index.set(key, {
          title: v.title,
          aLabel: s.aLabel,
          bLabel: s.bLabel,
          defA: s.defA || "",
          defB: s.defB || "",
          aImg: s.aImg || "",
          bImg: s.bImg || "",
        });
      }
    }
  }
  return index;
}

// Looks up a reused difference-pair by its two labels and verifies its
// images still exist on disk. Throws a clear, actionable error rather than
// silently producing a course page with a broken image.
export async function findTopic(
  index,
  aLabel,
  bLabel,
  { publicDir = path.join(projectRoot, "public") } = {},
) {
  const key = `${norm(aLabel)}|${norm(bLabel)}`;
  const hit = index.get(key);
  if (!hit) {
    throw new Error(
      `No sourced topic found for "${aLabel}" vs "${bLabel}". Re-run ` +
        `"npm run techsplains:gen" and "npm run techsplains:images" for ` +
        `this pair before referencing it from course content.`,
    );
  }
  for (const [side, rel] of [["aImg", hit.aImg], ["bImg", hit.bImg]]) {
    if (!rel) continue;
    try {
      await fs.access(path.join(publicDir, rel));
    } catch {
      throw new Error(
        `Topic "${aLabel}" vs "${bLabel}" has ${side}="${rel}" but that ` +
          `file is missing on disk — re-run "npm run techsplains:images".`,
      );
    }
  }
  return hit;
}

function sidebarHtml(t) {
  const figure = (label, rel) =>
    rel
      ? `<figure><img src="${rel}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`
      : "";
  return `
<aside class="sidebar">
  <p class="sidebar-eyebrow">Did You Know?</p>
  <h4>${escapeHtml(t.aLabel)}${t.bLabel ? ` vs ${escapeHtml(t.bLabel)}` : ""}</h4>
  <div class="sidebar-pair">
    ${figure(t.aLabel, t.aImg)}
    ${figure(t.bLabel, t.bImg)}
  </div>
  <p><strong>${escapeHtml(t.aLabel)}:</strong> ${escapeHtml(t.defA)}</p>
  ${t.defB ? `<p><strong>${escapeHtml(t.bLabel)}:</strong> ${escapeHtml(t.defB)}</p>` : ""}
</aside>`;
}

const SIDEBAR_RE = /\{\{sidebar:(\d+)\}\}/g;

// Parses a course content Markdown file (YAML frontmatter + body), resolves
// any {{sidebar:N}} placeholders against `sidebars[N]` in frontmatter, and
// returns { title, moduleNumber, tier, bodyHtml }.
//
// The placeholder substitution runs on the RAW markdown `content`, before
// marked.parse() — not on the parsed HTML. marked wraps bare-text lines in
// <p>, so substituting after parsing would nest the sidebar's block-level
// <aside> inside a <p> (invalid HTML, silently auto-corrected by browsers,
// but avoidable). Substituting first means marked sees a real HTML block
// (a line starting with a block tag, blank-line-delimited) and passes it
// through unwrapped, per how marked's tokenizer treats raw HTML blocks.
export async function renderModuleMarkdown(filePath, topicIndex, { publicDir } = {}) {
  const raw = await fs.readFile(filePath, "utf-8");
  const { data, content } = matter(raw);
  const sidebarDefs = data.sidebars || [];
  const resolved = [];
  for (const sb of sidebarDefs) {
    resolved.push(await findTopic(topicIndex, sb.a, sb.b, { publicDir }));
  }
  const withSidebars = content.replace(SIDEBAR_RE, (match, idxStr) => {
    const idx = Number(idxStr);
    const t = resolved[idx];
    if (!t) {
      throw new Error(
        `${filePath} references {{sidebar:${idx}}} but frontmatter only ` +
          `defines ${resolved.length} sidebar(s).`,
      );
    }
    return sidebarHtml(t);
  });
  const bodyHtml = marked.parse(withSidebars);
  return {
    title: data.title || path.basename(filePath, ".md"),
    moduleNumber: data.moduleNumber ?? null,
    tier: data.tier ?? null,
    bodyHtml,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/__tests__/course-content.test.mjs`
Expected: PASS (7 tests, all green)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/lib/course-content.mjs scripts/__tests__/course-content.test.mjs scripts/__tests__/fixtures/course
git commit -m "$(cat <<'EOF'
Add course-content.mjs: topic lookup + Markdown rendering for the course

Resolves {{sidebar:N}} placeholders against real, already-sourced
Techsplains difference-pair data (text + photos), with hermetic
fixture-backed tests so this doesn't depend on the gitignored out/ dir.
EOF
)"
```

---

### Task 3: Theming + PDF rendering

**Files:**
- Create: `course/templates/branded.css`
- Create: `course/templates/blank.css`
- Create: `scripts/lib/course-render.mjs`
- Test: `scripts/__tests__/course-render.test.mjs`

**Interfaces:**
- Consumes: `escapeHtml` from `scripts/lib/course-content.mjs` (Task 2).
- Produces: `buildPage({theme, title, sections}) => Promise<string>` (HTML string), `renderPdf(browser, html, outPath) => Promise<void>`, `planOutputs(moduleFiles, bonusFiles) => Array<{kind, files, outName}>` — all exported from `scripts/lib/course-render.mjs`. Task 4's `course-assemble.mjs` imports all three.

**Setup — install the PDF-rendering dependency this task needs:**

```bash
npm install puppeteer
```

This downloads a bundled Chromium (may take a minute or two on first install).

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/course-render.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPage, planOutputs } from "../lib/course-render.mjs";

test("buildPage embeds the theme CSS and section HTML", async () => {
  const html = await buildPage({
    theme: "branded",
    title: "Test Doc",
    sections: [{ bodyHtml: "<h1>Hello</h1>" }],
  });
  assert.match(html, /<title>Test Doc<\/title>/);
  assert.match(html, /<h1>Hello<\/h1>/);
});

test("buildPage adds the follow-footer and brand accent color only for the branded theme", async () => {
  const branded = await buildPage({ theme: "branded", title: "T", sections: [{ bodyHtml: "<p>x</p>" }] });
  const blank = await buildPage({ theme: "blank", title: "T", sections: [{ bodyHtml: "<p>x</p>" }] });
  assert.match(branded, /Follow @techsplains/);
  assert.match(branded, /#FFDD00/);
  assert.doesNotMatch(blank, /Follow @techsplains/);
  assert.doesNotMatch(blank, /#FFDD00/);
});

test("buildPage throws on an unknown theme name", async () => {
  await assert.rejects(
    () => buildPage({ theme: "neon", title: "T", sections: [] }),
    /Unknown theme "neon"/,
  );
});

test("planOutputs combines all modules into one Main-Course doc and keeps bonus docs separate", () => {
  const docs = planOutputs(["01-welcome.md", "02-the-cut.md"], ["02-Glossary.md", "03-Checklist.md"]);
  assert.deepEqual(docs, [
    { kind: "main", files: ["01-welcome.md", "02-the-cut.md"], outName: "01-Main-Course.pdf" },
    { kind: "bonus", files: ["02-Glossary.md"], outName: "02-Glossary.pdf" },
    { kind: "bonus", files: ["03-Checklist.md"], outName: "03-Checklist.pdf" },
  ]);
});

test("planOutputs returns no main doc when there are no modules yet", () => {
  const docs = planOutputs([], ["04-Hooks-List.md"]);
  assert.deepEqual(docs, [{ kind: "bonus", files: ["04-Hooks-List.md"], outName: "04-Hooks-List.pdf" }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/__tests__/course-render.test.mjs`
Expected: FAIL — `Cannot find module '../lib/course-render.mjs'`

- [ ] **Step 3: Create the theme CSS files**

Create `course/templates/branded.css` (Techsplains brand colors verified against `src/Root.tsx:421` accent `#FFDD00` and `src/DifferenceCard/DifferenceCard.tsx` background gradient/text colors):

```css
@page { size: Letter; margin: 0; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  color: #111;
  background: linear-gradient(180deg,#F7F6F4 0%,#E9E7E3 100%);
}
.course-page {
  page-break-after: always;
  padding: 0.4in 0.2in;
}
.course-page:last-child { page-break-after: auto; }
h1, h2, h3 { font-family: Helvetica, Arial, sans-serif; color: #111; }
h1 { font-size: 28pt; border-bottom: 4px solid #FFDD00; padding-bottom: 8px; }
h2 { font-size: 18pt; margin-top: 1.4em; }
p { font-size: 11.5pt; line-height: 1.55; }
a { color: #9B4F00; }
strong:first-child { color: #9B4F00; }
.sidebar {
  border-left: 6px solid #FFDD00;
  background: #FFFDF5;
  padding: 14px 18px;
  margin: 1.2em 0;
  border-radius: 4px;
}
.sidebar-eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 9pt;
  color: #9B968F;
  font-family: Helvetica, Arial, sans-serif;
  margin: 0 0 4px;
}
.sidebar h4 { margin: 0 0 10px; font-size: 13pt; }
.sidebar-pair { display: flex; gap: 12px; margin-bottom: 10px; }
.sidebar-pair figure { margin: 0; flex: 1; text-align: center; }
.sidebar-pair img { width: 100%; height: 120px; object-fit: cover; border-radius: 4px; border: 1px solid #DDD9D4; }
.sidebar-pair figcaption { font-size: 9pt; color: #9B968F; margin-top: 4px; font-family: Helvetica, Arial, sans-serif; }
.brand-footer {
  margin-top: 2em;
  padding-top: 10px;
  border-top: 2px solid #DDD9D4;
  font-family: Helvetica, Arial, sans-serif;
  font-size: 9.5pt;
  color: #9B968F;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.brand-logo { width: 22px; height: 22px; border-radius: 50%; }
```

Create `course/templates/blank.css` (neutral palette — no Techsplains yellow, no logo references):

```css
@page { size: Letter; margin: 0; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  color: #1A1A1A;
  background: #FFFFFF;
}
.course-page {
  page-break-after: always;
  padding: 0.4in 0.2in;
}
.course-page:last-child { page-break-after: auto; }
h1, h2, h3 { font-family: Helvetica, Arial, sans-serif; color: #1A1A1A; }
h1 { font-size: 28pt; border-bottom: 4px solid #3A5A78; padding-bottom: 8px; }
h2 { font-size: 18pt; margin-top: 1.4em; }
p { font-size: 11.5pt; line-height: 1.55; }
a { color: #3A5A78; }
strong:first-child { color: #3A5A78; }
.sidebar {
  border-left: 6px solid #3A5A78;
  background: #F5F7F9;
  padding: 14px 18px;
  margin: 1.2em 0;
  border-radius: 4px;
}
.sidebar-eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 9pt;
  color: #6B7A85;
  font-family: Helvetica, Arial, sans-serif;
  margin: 0 0 4px;
}
.sidebar h4 { margin: 0 0 10px; font-size: 13pt; }
.sidebar-pair { display: flex; gap: 12px; margin-bottom: 10px; }
.sidebar-pair figure { margin: 0; flex: 1; text-align: center; }
.sidebar-pair img { width: 100%; height: 120px; object-fit: cover; border-radius: 4px; border: 1px solid #DDD9D4; }
.sidebar-pair figcaption { font-size: 9pt; color: #6B7A85; margin-top: 4px; font-family: Helvetica, Arial, sans-serif; }
```

- [ ] **Step 4: Create `scripts/lib/course-render.mjs`**

```js
// scripts/lib/course-render.mjs
// Wraps rendered module/bonus sections in the branded or blank HTML theme
// and prints the result to PDF via a shared Puppeteer browser instance.
// Also plans which content files become which output PDF (one combined
// Main-Course PDF from all modules; one PDF per bonus doc).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./client.mjs";
import { escapeHtml } from "./course-content.mjs";

const TEMPLATES_DIR = path.join(projectRoot, "course", "templates");
const PUBLIC_DIR = path.join(projectRoot, "public");
const LOGO_ABS = path.join(
  os.homedir(), "Downloads", "Work", "02_Clients", "Techsplains", "06_Branding", "profile-1024.png",
);

const THEME_CSS_FILE = { branded: "branded.css", blank: "blank.css" };

async function loadThemeCss(theme) {
  const file = THEME_CSS_FILE[theme];
  if (!file) throw new Error(`Unknown theme "${theme}". Expected "branded" or "blank".`);
  return fs.readFile(path.join(TEMPLATES_DIR, file), "utf-8");
}

// sections: array of { bodyHtml }, each rendered on its own printed page.
export async function buildPage({ theme, title, sections }) {
  const css = await loadThemeCss(theme);
  const brandFooter =
    theme === "branded"
      ? `<div class="brand-footer"><img class="brand-logo" src="file://${LOGO_ABS}" alt="Techsplains"><span>Follow @techsplains for more byte-sized tech explainers.</span></div>`
      : "";
  const body = sections
    .map((s) => `<section class="course-page">${s.bodyHtml}${brandFooter}</section>`)
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="file://${PUBLIC_DIR}/">
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// Prints `html` to a PDF at `outPath` using a page on the given (already
// launched) Puppeteer browser. Writes the composed HTML to a temp file and
// navigates to it via file:// — page.setContent() + <base href="file://">
// is unreliable for loading local images from a non-file:// origin;
// navigating directly to a file:// URL is the standard, reliable pattern.
export async function renderPdf(browser, html, outPath) {
  const page = await browser.newPage();
  const tmpDir = path.join(projectRoot, "course", "out", ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpHtmlPath = path.join(tmpDir, `${path.basename(outPath, ".pdf")}-${Date.now()}.html`);
  try {
    await fs.writeFile(tmpHtmlPath, html, "utf-8");
    await page.goto(`file://${tmpHtmlPath}`, { waitUntil: "load" });
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath,
      format: "Letter",
      printBackground: true,
      margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
    });
  } finally {
    await page.close();
    await fs.rm(tmpHtmlPath, { force: true });
  }
}

// Pure planning helper — given discovered module/bonus filenames (already
// sorted), returns the list of documents to render. All modules concatenate
// into one Main-Course doc; each bonus file becomes its own PDF named after
// itself.
export function planOutputs(moduleFiles, bonusFiles) {
  const docs = [];
  if (moduleFiles.length) {
    docs.push({ kind: "main", files: moduleFiles, outName: "01-Main-Course.pdf" });
  }
  for (const f of bonusFiles) {
    docs.push({ kind: "bonus", files: [f], outName: f.replace(/\.md$/, ".pdf") });
  }
  return docs;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test scripts/__tests__/course-render.test.mjs`
Expected: PASS (5 tests, all green)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json course/templates scripts/lib/course-render.mjs scripts/__tests__/course-render.test.mjs
git commit -m "$(cat <<'EOF'
Add course-render.mjs: branded/blank theming + PDF printing

Two verified-brand-color CSS themes (accent #FFDD00 branded vs neutral
#3A5A78 blank), a shared-browser PDF print function, and a pure output
planner (all modules -> one Main-Course PDF, each bonus doc -> its own).
EOF
)"
```

---

### Task 4: Folder-assembly CLI

**Files:**
- Create: `scripts/course-assemble.mjs`
- Modify: `package.json` (add `course:assemble` script)

**Interfaces:**
- Consumes: `buildTopicIndex`, `renderModuleMarkdown` (Task 2); `buildPage`, `renderPdf`, `planOutputs` (Task 3); `projectRoot` from `scripts/lib/client.mjs`.
- Produces: `course/out/Techsplains-Editing-Course/{Branded,Blank}/*.pdf` on disk. Nothing downstream in this plan imports this file — it's a CLI entry point, exercised end-to-end in Task 7.

- [ ] **Step 1: Create `scripts/course-assemble.mjs`**

```js
#!/usr/bin/env node
// Renders every course content Markdown file into the final sellable folder
// structure: course/out/Techsplains-Editing-Course/{Branded,Blank}/*.pdf
//
// Usage:
//   node scripts/course-assemble.mjs                 # both themes
//   node scripts/course-assemble.mjs --theme branded  # one theme only

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { projectRoot } from "./lib/client.mjs";
import { buildTopicIndex, renderModuleMarkdown } from "./lib/course-content.mjs";
import { buildPage, renderPdf, planOutputs } from "./lib/course-render.mjs";

const courseDir = path.join(projectRoot, "course");
const modulesDir = path.join(courseDir, "content", "modules");
const bonusDir = path.join(courseDir, "content", "bonus");
const outRoot = path.join(courseDir, "out", "Techsplains-Editing-Course");

const themeFlagIdx = process.argv.indexOf("--theme");
const themes = themeFlagIdx !== -1 ? [process.argv[themeFlagIdx + 1]] : ["branded", "blank"];

async function listMd(dir) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function main() {
  const topicIndex = await buildTopicIndex();
  const moduleFiles = await listMd(modulesDir);
  const bonusFiles = await listMd(bonusDir);
  const docs = planOutputs(moduleFiles, bonusFiles);
  if (!docs.length) {
    console.error(`No course content found under ${courseDir}/content/ — nothing to render.`);
    process.exit(1);
  }

  const browser = await puppeteer.launch();
  try {
    for (const theme of themes) {
      const destDir = path.join(outRoot, theme === "branded" ? "Branded" : "Blank");
      for (const doc of docs) {
        const srcDir = doc.kind === "main" ? modulesDir : bonusDir;
        const sections = [];
        let title = "Editing Explained: The Techsplains Beginner-to-Creator Course";
        for (const f of doc.files) {
          const rendered = await renderModuleMarkdown(path.join(srcDir, f), topicIndex);
          sections.push(rendered);
          if (doc.kind === "bonus") title = rendered.title;
        }
        const html = await buildPage({ theme, title, sections });
        const outPath = path.join(destDir, doc.outName);
        await renderPdf(browser, html, outPath);
        console.log(`✓ [${theme}] ${doc.outName}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone → ${outRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check scripts/course-assemble.mjs`
Expected: exits silently (no output = valid syntax)

- [ ] **Step 3: Add the npm script**

In `package.json`, add to the `"scripts"` object (alongside the existing `"techsplains:*"` entries):

```json
    "course:assemble": "node scripts/course-assemble.mjs",
```

- [ ] **Step 4: Commit**

```bash
git add scripts/course-assemble.mjs package.json
git commit -m "$(cat <<'EOF'
Add course-assemble.mjs: CLI to render the full course folder structure

Discovers all content/modules and content/bonus Markdown files and
renders them into Techsplains-Editing-Course/{Branded,Blank}/*.pdf.
Functional verification happens end-to-end in the next task, once real
content exists to render.
EOF
)"
```

---

### Task 5: Real content — Module 2 "The Cut"

**Files:**
- Create: `course/content/modules/02-the-cut.md`

**Interfaces:**
- Consumes: `renderModuleMarkdown` from Task 2 (used only to verify this file during Step 2 below — the module itself has no code interface).
- Produces: the first real module content file, discovered by `course-assemble.mjs` (Task 4) via `listMd(modulesDir)`.

This is the proof-of-concept module: 100% of its sidebar content is verified present on disk right now (`out/techsplains-scripts-2026-07-09T21-20.json`, images in `public/generated-diff/2026-07-09T21-20/`).

- [ ] **Step 1: Write the content**

Create `course/content/modules/02-the-cut.md`:

```markdown
---
title: "Module 2: The Cut"
moduleNumber: 2
tier: fundamentals
sidebars:
  - a: "Cut"
    b: "Transition"
  - a: "J-cut"
    b: "L-cut"
---

# Module 2: The Cut

Every video you've ever watched is built out of one basic move, repeated hundreds of times: showing one shot, then showing a different shot. That's it. That's editing. Everything else — the fancy transitions, the perfectly timed reveals, the way a good creator's video feels "smooth" — is just variations on how that one move gets made.

This module covers the two building blocks you'll use in almost every edit you ever make: the cut, and the pieces that make a cut feel invisible instead of jarring.

## The most common edit you'll ever make

{{sidebar:0}}

A hard cut is the default. It's fast, it's honest, and 90% of the footage in a well-edited video is connected by plain cuts, not fancy effects. New editors often reach for transitions to make their video feel "professional" — but overusing transitions is one of the fastest ways to make an edit feel amateur instead. A clean cut on a strong moment (the punchline of a sentence, the peak of an action) almost always beats a fade or a wipe.

**Rule of thumb:** if you're not sure whether a moment needs a transition, it doesn't. Cut.

## Making a cut disappear: J-cuts and L-cuts

{{sidebar:1}}

Once you're comfortable cutting on picture, the next-level move is cutting picture and audio *separately*. That's what J-cuts and L-cuts are for — and once you notice them, you'll see them in almost every well-edited interview, vlog, or documentary you watch.

A J-cut is what you use to lead an audience *into* a new scene — they hear it before they see it, which primes them for what's coming. An L-cut is what you use to let a moment *breathe* — the audio lingers a beat after the picture has already moved on, so a reaction shot doesn't feel abruptly cut off.

**Try it:** take any talking-head clip you have lying around. Find a spot where the speaker finishes a sentence, then cut the video half a second early or half a second late relative to the audio. That tiny offset is the entire technique — it just takes practice to feel where it belongs.

## What's next

Module 3 covers the file-format side of editing — codecs, containers, and why "export" and "render" aren't the same word, even though creators use them interchangeably.
```

- [ ] **Step 2: Verify it resolves against real data (no mocking, no fixtures)**

Run:

```bash
node -e "
import('./scripts/lib/course-content.mjs').then(async ({ buildTopicIndex, renderModuleMarkdown }) => {
  const index = await buildTopicIndex();
  const result = await renderModuleMarkdown('course/content/modules/02-the-cut.md', index);
  console.log('title:', result.title);
  console.log('has sidebar class:', result.bodyHtml.includes('class=\"sidebar\"'));
  console.log('has Cut definition:', result.bodyHtml.includes('A cut instantly changes'));
  console.log('has J-cut definition:', result.bodyHtml.includes(\"next scene's audio begin\"));
});
"
```

Expected output:
```
title: Module 2: The Cut
has sidebar class: true
has Cut definition: true
has J-cut definition: true
```

If this throws `No sourced topic found`, the `out/techsplains-scripts-2026-07-09T21-20.json` file (or its images in `public/generated-diff/2026-07-09T21-20/`) has been cleaned up since this plan was written — re-run `npm run techsplains:gen` / `npm run techsplains:images` for the "Cut vs Transition" / "J-cut vs L-cut" topics before continuing.

- [ ] **Step 3: Commit**

```bash
git add course/content/modules/02-the-cut.md
git commit -m "$(cat <<'EOF'
Add Module 2 "The Cut" — first real course content

Uses the real Cut vs Transition / J-cut vs L-cut difference-pair data
and photos already sourced for the Techsplains video pipeline.
EOF
)"
```

---

### Task 6: Real content — Quick-Reference Glossary (bonus doc)

**Files:**
- Create: `course/content/bonus/02-Glossary.md`

**Interfaces:**
- Consumes: none directly (plain Markdown, no `{{sidebar:N}}` placeholders — bonus docs get the "lighter visual treatment" per spec, styled via the `strong:first-child` CSS rule already added in Task 3 rather than full sidebar boxes).
- Produces: the first real bonus content file, discovered by `course-assemble.mjs` (Task 4) via `listMd(bonusDir)`. Output filename is derived directly from this source filename: `02-Glossary.md` → `02-Glossary.pdf`, matching the spec's folder structure.

- [ ] **Step 1: Write the content**

Create `course/content/bonus/02-Glossary.md`:

```markdown
---
title: "Quick-Reference Glossary"
---

# Quick-Reference Glossary

Every term from the course, defined in one line. Keep this page open while you edit.

**Cut** — instantly changes from one shot to the next.

**Transition** — a visual effect that smoothly connects two shots.

**J-cut** — the next scene's audio begins before its video appears.

**L-cut** — the previous scene's audio continues after its video ends.

More terms get added here as later modules ship.
```

Note: this Glossary intentionally covers only Module 2's terms — it's honest about being partial rather than claiming to be the full course glossary described in the spec (which needs the other 7 modules to exist first).

- [ ] **Step 2: Verify it parses correctly**

Run:

```bash
node -e "
import('./scripts/lib/course-content.mjs').then(async ({ buildTopicIndex, renderModuleMarkdown }) => {
  const index = await buildTopicIndex();
  const result = await renderModuleMarkdown('course/content/bonus/02-Glossary.md', index);
  console.log('title:', result.title);
  console.log('has Cut term:', result.bodyHtml.includes('<strong>Cut</strong>'));
});
"
```

Expected output:
```
title: Quick-Reference Glossary
has Cut term: true
```

- [ ] **Step 3: Commit**

```bash
git add course/content/bonus/02-Glossary.md
git commit -m "$(cat <<'EOF'
Add Quick-Reference Glossary bonus doc — first real bonus content

Scoped to Module 2's terms only; expands as later modules are written.
EOF
)"
```

---

### Task 7: End-to-end verification

**Files:** none created — this task exercises Tasks 1–6 together.

**Interfaces:** none produced — terminal task of this plan.

- [ ] **Step 1: Run the full assembly for both themes**

Run: `npm run course:assemble`

Expected output (order of bonus/module lines may vary slightly, but both themes and both documents must appear):
```
✓ [branded] 01-Main-Course.pdf
✓ [branded] 02-Glossary.pdf
✓ [blank] 01-Main-Course.pdf
✓ [blank] 02-Glossary.pdf

Done → .../course/out/Techsplains-Editing-Course
```

- [ ] **Step 2: Verify the output files exist with real content**

Run:

```bash
ls -la course/out/Techsplains-Editing-Course/Branded/
ls -la course/out/Techsplains-Editing-Course/Blank/
```

Expected: both directories list `01-Main-Course.pdf` and `02-Glossary.pdf`, each with a non-trivial size (tens to low hundreds of KB — a PDF with two embedded JPEG/PNG images should clear at least 50KB; a bare few-KB file signals the images didn't embed).

- [ ] **Step 3: Confirm the Blank version is actually free of Techsplains branding text**

Run:

```bash
grep -a -i "techsplains" course/out/Techsplains-Editing-Course/Blank/01-Main-Course.pdf || echo "CLEAN: no 'techsplains' text found in Blank PDF"
```

Expected: `CLEAN: no 'techsplains' text found in Blank PDF`. (This is a best-effort automated proxy — PDF text isn't always cleanly grep-able depending on font encoding — so Step 4's visual check is authoritative.)

- [ ] **Step 4: Open all four PDFs and visually confirm**

Open each file (e.g. `open course/out/Techsplains-Editing-Course/Branded/01-Main-Course.pdf`) and confirm:
- Branded `01-Main-Course.pdf`: Module 2 heading, both "Did You Know?" sidebar boxes show real photos (not broken-image icons) for Cut/Transition and J-cut/L-cut, yellow accent color visible, Techsplains logo + "Follow @techsplains" footer visible.
- Blank `01-Main-Course.pdf`: identical text content to the Branded version, but neutral blue accent, no logo, no follow footer.
- Branded and Blank `02-Glossary.pdf`: four term definitions present, styled term labels, no broken layout.

- [ ] **Step 5: Report results to the user**

Summarize in the conversation: which files were generated, their sizes, and explicitly flag anything that didn't look right in Step 4 (broken images, wrong colors, missing branding) so it can be fixed before Task 5/6's approach is reused for the remaining 7 modules and 4 bonus docs in the follow-up content plan.
