# Tranzzie Video Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the Techsplains difference-video pipeline into a config-driven, multi-brand "video studio" and add a second brand — Tranzzie Eyeglasses — with Taglish narration and a photoreal Jurie presenter (a reusable pose set generated once from Jurie's reference sheet).

**Architecture:** All brand-specific behavior (GCP creds, TTS voice, brand strings, template, presenter poses, paths) moves out of hardcoded constants into a `video` block per client in `config/clients.json`, resolved by a new `scripts/lib/diff-config.mjs`. The six pipeline scripts (`generate-diff-*`, `render-diff-batch`, orchestrator) take a `--client` flag and read everything from the resolved config. A new Remotion composition `TranzzieDiffCard` renders Tranzzie's dark gold/red/white look with Jurie composited in as the presenter (pose-swapped per phase like the Techsplains mascot). Techsplains keeps byte-identical behavior — its current constants simply become its config block.

**Tech Stack:** Node 18+ ESM (`.mjs`), `@google/genai` (Vertex AI — Gemini text, `gemini-2.5-flash-image`, `gemini-2.5-flash-tts`), Remotion 4 + React 19 + Zod, Express (dashboard), `node:test` + `node:assert/strict` for tests, `mlx_whisper` + `ffmpeg` (already required by the audio step).

## Global Constraints

- **Techsplains behavior must stay byte-identical.** Its `video` config block reproduces today's exact constants: accent `#FFDD00`, handle `@techsplains`, outro `Follow Techsplains for more!`, DYK opener `Did you know`, voice `Orus`, `targetSec` 31, `maxTempo` 1.28, whisper `en`, isolated GCP (`adc-techsplains.json`, project `techsplains`), compositions `DifferenceCard`/`DidYouKnowCard`, and the exact mascot pose map.
- **GCP isolation:** `video.gcp` is a keyword — `"techsplains"` → isolated `adc-techsplains.json` + project `techsplains`; `"shared"` → `lib/client.mjs`'s `applyGcpEnv()` (Jurie project `jurie-quote-posters`, `adc-jurie.json`). Tranzzie video runs on `"shared"` — same credential as Tranzzie posters. Never create `adc-tranzzie.json`.
- **Autoposting stays inert for Tranzzie** (per `JURIE.md`): no `BUFFER_TRANZZIE_*` env, so the dashboard degrades to the manual "ready" handoff. Do not wire Tranzzie Buffer.
- **No medical-cure claims for Tranzzie** — the voice profile carries `brief_tranzzie.bannedPhrases`, and the director QC rejects/repairs them.
- **Zero new npm dependencies** (project ethos). No bg-removal lib — Jurie poses are generated on a pure-black studio background and feathered via CSS mask.
- **Tests run with** `node --test scripts/__tests__/<file>.test.mjs` (Node built-in runner; there is no `test` npm script). Test files use `import { test } from "node:test"` and `import assert from "node:assert/strict"`.
- **Bump `package.json` version on every change** (user rule — verified via the dashboard header `v{version}`). Current: `0.44.0`.
- **Lint/typecheck:** `npm run lint` = `eslint src && tsc`. Run it after any `src/` (`.tsx`) change.

---

## File Structure

**New files:**
- `scripts/lib/diff-config.mjs` — `resolveDiffClient(id)`, per-client GCP applier, `makeStamp`/`slugify` (moved from techsplains.mjs).
- `scripts/lib/diff-prompt.mjs` — pure `buildDiffInstruction(cfg, opts)` / `buildDykInstruction(cfg, opts)` prompt assembly (brand-parametrized), extracted for testing.
- `scripts/generate-presenter-poses.mjs` — one-time Jurie pose-set generator.
- `scripts/voice-profile-tranzzie-video.md` — Tranzzie narrated-video voice profile.
- `scripts/batch-diff.mjs` — client-parametrized orchestrator (replaces batch-techsplains.mjs; a shim keeps the old name).
- `src/TranzzieDiffCard/TranzzieDiffCard.tsx` — Tranzzie photo + Jurie presenter composition (and `TranzzieDidYouKnowCard` in the same file).
- `public/characters/tranzzie/jurie-*.png` — generated presenter poses (produced by the generator, not hand-written).
- `config/tranzzie-video-ledger.json` — created on first run (empty `{ "used": [] }`).
- Tests: `scripts/__tests__/diff-config.test.mjs`, `diff-prompt.test.mjs`, `presenter-poses.test.mjs`, `render-diff-helpers.test.mjs`, `batch-diff.test.mjs`.

**Modified files:**
- `config/clients.json` — add `video` block to `techsplains` + `tranzzie`.
- `scripts/lib/techsplains.mjs` — becomes a thin shim re-exporting from diff-config.
- `scripts/generate-diff-scripts.mjs`, `generate-diff-images.mjs`, `generate-diff-director.mjs`, `generate-diff-audio.mjs`, `render-diff-batch.mjs` — `--client` threaded; config-driven.
- `scripts/lib/techsplains-queue.mjs` — accept per-client queue path.
- `scripts/techsplains-dashboard.mjs` / `.html` — client switcher, per-client state.
- `config/briefs.json` — add face-shape / why-invest DYK prompts to `brief_tranzzie`.
- `package.json` — new scripts, version bump.
- `.gitignore` — ignore `config/tranzzie-video-queue.json`.

---

## Task 1: Config resolver — `lib/diff-config.mjs` + `video` blocks + techsplains shim

**Files:**
- Modify: `config/clients.json` (add `video` blocks to `techsplains` and `tranzzie`)
- Create: `scripts/lib/diff-config.mjs`
- Modify: `scripts/lib/techsplains.mjs` (becomes a shim)
- Test: `scripts/__tests__/diff-config.test.mjs`

**Interfaces:**
- Consumes: `resolveClient`, `projectRoot`, `applyGcpEnv` (shared, Jurie) from `scripts/lib/client.mjs`.
- Produces:
  - `resolveDiffClient(id: string) → Promise<DiffClient>` where `DiffClient = { id, brandName, handle, template, accent, outro, dykOpener, language, whisperLang, tts:{model,voice,stylePrompt,targetSec,maxTempo}, presenter:{characterId,poseDir,poses}, voiceProfilePath, briefId, brief, contentMix:{dykDefault,generalDefault,allowGeneral}, ledgerPath, queuePath, exportDir, gcp:{project,location,imageLocation,adc}, applyGcpEnv():void }`
  - `makeStamp() → string`, `slugify(s) → string` (moved here).
  - `poseFileFor(cfg, kind: string) → string` — POSIX path `<poseDir>/<poses[kind]>` (used by render).

- [ ] **Step 1: Add the `video` block to `techsplains` in `config/clients.json`**

Open `config/clients.json` and replace the `techsplains` object with (keep existing top-level fields, add `video`):

```jsonc
{
  "id": "techsplains",
  "label": "Techsplains",
  "voiceProfile": "voice-profile-techsplains.md",
  "briefId": "brief_techsplains",
  "exportDir": "/Users/macbookpro/Downloads/Work/02_Clients/Techsplains/05_Exports/Difference Videos",
  "gcpProject": "techsplains",
  "gcpAdc": "~/.config/gcloud/adc-techsplains.json",
  "ttsVoice": "en-US-Chirp3-HD-Orus",
  "handle": "@techsplains",
  "video": {
    "brandName": "Techsplains",
    "handle": "@techsplains",
    "template": "mascot",
    "accent": "#FFDD00",
    "outro": "Follow Techsplains for more!",
    "dykOpener": "Did you know",
    "language": "en",
    "whisperLang": "en",
    "gcp": "techsplains",
    "tts": {
      "model": "gemini-2.5-flash-tts",
      "voice": "Orus",
      "stylePrompt": "Read this narration in a natural, friendly, QUICK voice — energetic and up-tempo like a viral shorts narrator excited to share a fact, but still human and clearly enunciated, never rushed into mumbling. Keep the tone steady and consistent start to finish, no dramatic swings or over-acting. Only the briefest beat between sentences:",
      "targetSec": 31,
      "maxTempo": 1.28
    },
    "presenter": {
      "characterId": null,
      "poseDir": "characters/techsplains",
      "poses": {
        "hook": "pose-point.png", "introA": "pose-point.png",
        "introB": "pose-point.png", "question": "pose-confused.png",
        "defA": "pose-think.png", "defB": "pose-point.png",
        "outro": "pose-base.png"
      }
    },
    "voiceProfile": "voice-profile-techsplains.md",
    "briefId": "brief_techsplains",
    "contentMix": { "dykDefault": 0.25, "generalDefault": 0.20, "allowGeneral": true },
    "ledger": "config/techsplains-topic-ledger.json",
    "queue": "config/techsplains-queue.json",
    "exportDir": "/Users/macbookpro/Downloads/Work/02_Clients/Techsplains/05_Exports/Difference Videos"
  }
}
```

- [ ] **Step 2: Add the `video` block to `tranzzie` in `config/clients.json`**

Replace the `tranzzie` object with (keep existing top-level fields, add `video`):

```jsonc
{
  "id": "tranzzie",
  "label": "Tranzzie Eyeglasses",
  "voiceProfile": "voice-profile-tranzzie.md",
  "briefId": "brief_tranzzie",
  "brandPresetId": "preset_tranzzie",
  "characterId": "char_tranzzie_enhanced",
  "exportDir": "/Users/macbookpro/Downloads/Work/02_Clients/Tranzzie/05_Exports/Quote Posters",
  "video": {
    "brandName": "Tranzzie",
    "handle": "@tranzzie",
    "template": "photo",
    "accent": "#F5C13B",
    "outro": "Follow Tranzzie for more!",
    "dykOpener": "Alam mo ba",
    "language": "taglish",
    "whisperLang": "auto",
    "gcp": "shared",
    "tts": {
      "model": "gemini-2.5-flash-tts",
      "voice": "Leda",
      "stylePrompt": "Basahin ito na parang mabait at maalalahanin na ate optometrist na nagpapaliwanag sa isang kaibigan — mainit, may malasakit, malinaw, at hindi nagmamadali. Panatilihing steady at natural ang tono, Taglish, tulad ng kwentuhan. Maikling hinto lang bawat pangungusap:",
      "targetSec": 34,
      "maxTempo": 1.22
    },
    "presenter": {
      "characterId": "char_tranzzie_enhanced",
      "poseDir": "characters/tranzzie",
      "poses": {
        "hook": "jurie-point.png", "introA": "jurie-point.png",
        "introB": "jurie-present.png", "question": "jurie-think.png",
        "defA": "jurie-explain.png", "defB": "jurie-point.png",
        "outro": "jurie-base.png"
      }
    },
    "voiceProfile": "voice-profile-tranzzie-video.md",
    "briefId": "brief_tranzzie",
    "contentMix": { "dykDefault": 0.34, "generalDefault": 0, "allowGeneral": false },
    "ledger": "config/tranzzie-video-ledger.json",
    "queue": "config/tranzzie-video-queue.json",
    "exportDir": "/Users/macbookpro/Downloads/Work/02_Clients/Tranzzie/05_Exports/Difference Videos"
  }
}
```

Validate the JSON parses:

Run: `node -e "JSON.parse(require('fs').readFileSync('config/clients.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Write the failing test for `diff-config.mjs`**

Create `scripts/__tests__/diff-config.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDiffClient, poseFileFor, makeStamp, slugify } from "../lib/diff-config.mjs";

test("resolveDiffClient(techsplains) returns the legacy constants unchanged", async () => {
  const c = await resolveDiffClient("techsplains");
  assert.equal(c.accent, "#FFDD00");
  assert.equal(c.handle, "@techsplains");
  assert.equal(c.outro, "Follow Techsplains for more!");
  assert.equal(c.dykOpener, "Did you know");
  assert.equal(c.template, "mascot");
  assert.equal(c.tts.voice, "Orus");
  assert.equal(c.tts.targetSec, 31);
  assert.equal(c.tts.maxTempo, 1.28);
  assert.equal(c.whisperLang, "en");
  assert.equal(c.gcp.project, "techsplains");
  assert.match(c.gcp.adc, /adc-techsplains\.json$/);
  assert.equal(c.contentMix.allowGeneral, true);
  assert.equal(c.presenter.poses.question, "pose-confused.png");
});

test("resolveDiffClient(tranzzie) uses shared GCP + Tranzzie brand", async () => {
  const c = await resolveDiffClient("tranzzie");
  assert.equal(c.brandName, "Tranzzie");
  assert.equal(c.template, "photo");
  assert.equal(c.accent, "#F5C13B");
  assert.equal(c.dykOpener, "Alam mo ba");
  assert.equal(c.contentMix.allowGeneral, false);
  assert.equal(c.gcp.project, "jurie-quote-posters"); // shared Jurie project
  assert.match(c.gcp.adc, /adc-jurie\.json$/);
  assert.equal(c.presenter.characterId, "char_tranzzie_enhanced");
  assert.match(c.voiceProfilePath, /voice-profile-tranzzie-video\.md$/);
});

test("resolveDiffClient attaches the resolved brief object", async () => {
  const c = await resolveDiffClient("tranzzie");
  assert.equal(c.brief.id, "brief_tranzzie");
  assert.ok(Array.isArray(c.brief.topics) && c.brief.topics.length > 0);
});

test("poseFileFor builds a POSIX poseDir/pose path", async () => {
  const c = await resolveDiffClient("techsplains");
  assert.equal(poseFileFor(c, "defA"), "characters/techsplains/pose-think.png");
});

test("applyGcpEnv(shared) sets Jurie creds", async () => {
  const saved = { a: process.env.GOOGLE_APPLICATION_CREDENTIALS, p: process.env.GOOGLE_CLOUD_PROJECT };
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  const c = await resolveDiffClient("tranzzie");
  c.applyGcpEnv();
  assert.match(process.env.GOOGLE_APPLICATION_CREDENTIALS, /adc-jurie\.json$/);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = saved.a || "";
  process.env.GOOGLE_CLOUD_PROJECT = saved.p || "";
});

test("makeStamp/slugify still exported", () => {
  assert.match(makeStamp(), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
  assert.equal(slugify("Codec vs Container!"), "codec-vs-container");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test scripts/__tests__/diff-config.test.mjs`
Expected: FAIL — `Cannot find module '../lib/diff-config.mjs'`.

- [ ] **Step 5: Implement `scripts/lib/diff-config.mjs`**

Create `scripts/lib/diff-config.mjs`:

```js
// Config resolver for the multi-brand difference-video pipeline (Techsplains,
// Tranzzie, …). Reads each client's `video` block from clients.json and returns
// a fully-resolved DiffClient, including the correct GCP-env applier (isolated
// techsplains key vs the shared Jurie key). Generalizes lib/techsplains.mjs.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot, applyGcpEnv as applySharedGcpEnv } from "./client.mjs";

// Same PERSIST_BASE-aware config dir as resolveClient, so Railway runtime edits win.
const configBase = () =>
  process.env.PERSIST_BASE
    ? path.join(process.env.PERSIST_BASE, "config")
    : path.join(projectRoot, "config");
const scriptsDir = path.join(projectRoot, "scripts");

const expandHome = (p) =>
  p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

async function readJson(abs, fallback) {
  try { return JSON.parse(await fs.readFile(abs, "utf-8")); }
  catch { return fallback; }
}

export const makeStamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

export const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

// POSIX <poseDir>/<pose file> for a phase kind (used by staticFile in render).
export const poseFileFor = (cfg, kind) =>
  path.posix.join(cfg.presenter.poseDir, cfg.presenter.poses[kind]);

// GCP resolution per keyword. "techsplains" = its own isolated key/project.
// "shared" = the Jurie project (lib/client.mjs default) — same as Tranzzie posters.
function resolveGcp(keyword) {
  if (keyword === "shared") {
    return {
      project: process.env.GOOGLE_CLOUD_PROJECT || "jurie-quote-posters",
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
      imageLocation: process.env.GOOGLE_CLOUD_IMAGE_LOCATION || "us-central1",
      adc:
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        path.join(os.homedir(), ".config", "gcloud", "adc-jurie.json"),
      apply: () => applySharedGcpEnv(),
    };
  }
  // default: techsplains isolated
  const project = process.env.TECHSPLAINS_GCP_PROJECT || "techsplains";
  const adc =
    process.env.TECHSPLAINS_GCP_ADC ||
    path.join(os.homedir(), ".config", "gcloud", "adc-techsplains.json");
  return {
    project,
    location: process.env.TECHSPLAINS_GCP_LOCATION || "global",
    imageLocation: process.env.TECHSPLAINS_GCP_IMAGE_LOCATION || "us-central1",
    adc,
    apply: () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
      process.env.GOOGLE_CLOUD_PROJECT = project;
    },
  };
}

export async function resolveDiffClient(id) {
  const cfgDir = configBase();
  let clients = await readJson(path.join(cfgDir, "clients.json"), null);
  if (!clients)
    clients = await readJson(path.join(projectRoot, "config", "clients.json"), []);
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error(`Unknown client "${id}". Known: ${clients.map((c) => c.id).join(", ")}`);
  const v = client.video;
  if (!v) throw new Error(`Client "${id}" has no "video" config block.`);

  const briefs = await readJson(path.join(cfgDir, "briefs.json"), []);
  const brief = briefs.find((b) => b.id === v.briefId) || null;
  const gcp = resolveGcp(v.gcp);

  return {
    id,
    brandName: v.brandName,
    handle: v.handle,
    template: v.template,
    accent: v.accent,
    outro: v.outro,
    dykOpener: v.dykOpener,
    language: v.language,
    whisperLang: v.whisperLang,
    tts: v.tts,
    presenter: v.presenter,
    voiceProfilePath: path.join(scriptsDir, v.voiceProfile),
    briefId: v.briefId,
    brief,
    contentMix: v.contentMix,
    ledgerPath: path.join(cfgDir, path.basename(v.ledger)),
    queuePath: path.join(cfgDir, path.basename(v.queue)),
    exportDir: expandHome(v.exportDir),
    gcp: { project: gcp.project, location: gcp.location, imageLocation: gcp.imageLocation, adc: expandHome(gcp.adc) },
    applyGcpEnv: gcp.apply,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test scripts/__tests__/diff-config.test.mjs`
Expected: PASS — 6 tests pass.

- [ ] **Step 7: Turn `lib/techsplains.mjs` into a shim**

Replace the entire contents of `scripts/lib/techsplains.mjs` with:

```js
// SHIM — Techsplains config now lives in clients.json's `video` block and is
// resolved by lib/diff-config.mjs. These exports preserve the old surface so
// any not-yet-migrated importer keeps working. New code should use
// resolveDiffClient("techsplains") directly.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { resolveDiffClient, makeStamp, slugify } from "./diff-config.mjs";

// Preserve the .env side-load the old module did (repo-root .env → process.env).
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
try {
  const envText = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env — fine */ }

const ts = await resolveDiffClient("techsplains");

export const TS_GCP = { project: ts.gcp.project, location: ts.gcp.location, imageLocation: ts.gcp.imageLocation, adc: ts.gcp.adc };
export const TS_TTS = { ...ts.tts };
export const TS_HANDLE = ts.handle;
export const TS_OUTRO = ts.outro;
export const applyTechsplainsGcpEnv = ts.applyGcpEnv;
export { makeStamp, slugify };
```

- [ ] **Step 8: Verify the shim keeps the existing suite green**

Run: `node --test scripts/__tests__/techsplains-batches.test.mjs scripts/__tests__/techsplains-queue.test.mjs scripts/__tests__/techsplains-manifest.test.mjs`
Expected: PASS — all existing tests still pass (they don't import techsplains.mjs, but confirms no import graph breakage).

Run: `node -e "import('./scripts/lib/techsplains.mjs').then(m=>console.log(m.TS_HANDLE, m.TS_TTS.voice, m.TS_GCP.project))"`
Expected: `@techsplains Orus techsplains`

- [ ] **Step 9: Commit**

```bash
git add config/clients.json scripts/lib/diff-config.mjs scripts/lib/techsplains.mjs scripts/__tests__/diff-config.test.mjs
git commit -m "feat(video): config-driven diff-config resolver + video blocks; techsplains.mjs shim

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Brand-parametrized prompt builder + wire `generate-diff-scripts.mjs`

**Files:**
- Create: `scripts/lib/diff-prompt.mjs`
- Test: `scripts/__tests__/diff-prompt.test.mjs`
- Modify: `scripts/generate-diff-scripts.mjs`

**Interfaces:**
- Consumes: `DiffClient` from Task 1 (`brandName`, `outro`, `dykOpener`, `contentMix`, `brief`), `takeClientArg` from `lib/client.mjs`.
- Produces:
  - `buildInstructions(cfg, voiceProfile, ledger, { count, topic, dyk, general }) → { diffInstruction, dykInstruction, DIFF_COUNT, DYK_COUNT, GENERAL_COUNT }` — pure, brand-parametrized.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/diff-prompt.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstructions } from "../lib/diff-prompt.mjs";

const techsplains = {
  brandName: "Techsplains", outro: "Follow Techsplains for more!", dykOpener: "Did you know",
  contentMix: { dykDefault: 0.25, generalDefault: 0.2, allowGeneral: true },
  brief: { topics: ["codec vs container"], generalTopics: ["frog vs toad"] },
};
const tranzzie = {
  brandName: "Tranzzie", outro: "Follow Tranzzie for more!", dykOpener: "Alam mo ba",
  contentMix: { dykDefault: 0.34, generalDefault: 0, allowGeneral: false },
  brief: { topics: ["blue-light vs regular lenses"], generalTopics: [] },
};

test("brand strings are interpolated, not hardcoded", () => {
  const r = buildInstructions(tranzzie, "VOICE", { used: [] }, { count: 3, dyk: 1, general: 0 });
  assert.match(r.diffInstruction, /Tranzzie/);
  assert.doesNotMatch(r.diffInstruction, /Techsplains/);
  assert.match(r.dykInstruction, /Alam mo ba/);
  assert.match(r.dykInstruction, /Follow Tranzzie for more!/);
});

test("allowGeneral:false forbids the general category", () => {
  const r = buildInstructions(tranzzie, "VOICE", { used: [] }, { count: 4, dyk: 1, general: 2 });
  assert.equal(r.GENERAL_COUNT, 0);
  assert.match(r.diffInstruction, /do not use the GENERAL/i);
});

test("techsplains keeps the general split when requested", () => {
  const r = buildInstructions(techsplains, "VOICE", { used: [] }, { count: 4, dyk: 1, general: 1 });
  assert.equal(r.GENERAL_COUNT, 1);
  assert.equal(r.DIFF_COUNT, 3);
  assert.equal(r.DYK_COUNT, 1);
  assert.match(r.dykInstruction, /Did you know/);
});

test("ledger lines are appended when present", () => {
  const r = buildInstructions(techsplains, "VOICE", { used: ["codec vs container"] }, { count: 1, dyk: 0, general: 0 });
  assert.match(r.diffInstruction, /codec vs container/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/__tests__/diff-prompt.test.mjs`
Expected: FAIL — `Cannot find module '../lib/diff-prompt.mjs'`.

- [ ] **Step 3: Implement `scripts/lib/diff-prompt.mjs`**

This lifts the prompt-assembly logic currently inline in `generate-diff-scripts.mjs` (lines ~41–155) into a pure function, with every literal "Techsplains" / "Did you know" / "Follow Techsplains for more!" replaced by `cfg.brandName` / `cfg.dykOpener` / `cfg.outro`, and the GENERAL category gated on `cfg.contentMix.allowGeneral`.

Create `scripts/lib/diff-prompt.mjs`:

```js
// Pure, brand-parametrized prompt assembly for generate-diff-scripts.mjs.
// Extracted so the brand interpolation (no hardcoded "Techsplains") is unit-tested.

export function buildInstructions(cfg, voiceProfile, ledger, { count, topic = "", dyk = 0, general = 0 }) {
  const brief = cfg.brief || {};
  const allowGeneral = !!cfg.contentMix?.allowGeneral;

  const briefBlock = brief.topics?.length
    ? `\n\n## TOPIC POOLS (category "editing", "creation", "tech", or eyewear):\n` +
      brief.topics.map((t) => `- ${t}`).join("\n") +
      (brief.voiceNotes ? `\n\nVoice notes: ${brief.voiceNotes}` : "")
    : "";

  const generalBlock = allowGeneral && brief.generalTopics?.length
    ? `\n\n## GENERAL TOPIC POOLS (category "general" — NOT tech):\n` +
      brief.generalTopics.map((t) => `- ${t}`).join("\n")
    : "";

  const ledgerBlock = ledger.used?.length
    ? `\n\n## ALREADY PUBLISHED — never generate any of these again, avoid near-duplicates:\n` +
      ledger.used.map((t) => `- ${t}`).join("\n")
    : "";

  const DYK_COUNT = Math.min(count, Math.max(0, dyk | 0));
  const GENERAL_COUNT = allowGeneral ? Math.min(count, Math.max(0, general | 0)) : 0;
  const DIFF_COUNT = count - DYK_COUNT;
  const GENERAL_DIFF = Math.min(GENERAL_COUNT, DIFF_COUNT);
  const GENERAL_DYK = Math.min(DYK_COUNT, GENERAL_COUNT - GENERAL_DIFF);

  const sharedBlocks = `${voiceProfile}${briefBlock}${generalBlock}${ledgerBlock}

CLARITY & ENGAGEMENT (applies to EVERY sentence):
- Write like you're telling a friend a fun fact, never like a manual or textbook.
- Simple, common words only. Someone with zero background should get it on first listen.
- Each definition should earn a "huh, I didn't know that" — lead with the surprising/useful part, keep A and B mirrored.
- The HOOK must open a curiosity gap or pick a friendly fight, never a flat topic announcement.
- The OUTRO question must be answerable in ONE WORD in the comments.
${allowGeneral ? `- ABSTRACT pairs are welcome when people genuinely mistake one for the other, but every searchQuery/imagePrompt must describe a CONCRETE photographable scene.\n` : ""}
VARIETY RULES:
- Every video comes from a DIFFERENT topic pool line.
- Vary the hook style across the batch.
- No two videos may share a comparison or fact.

Output ONLY valid JSON.`;

  const generalLine = (n, total) => {
    if (topic) return "";
    if (!allowGeneral) return `\nEvery video comes from the TOPIC POOLS — do not use the GENERAL pools in this batch.`;
    return n > 0
      ? `\nExactly ${n} of the ${total} video(s) must be GENERAL (category "general"): everyday fun facts with NOTHING to do with tech. The other ${total - n} come from the topic pools.`
      : `\nEvery video comes from the TOPIC POOLS — do not use the GENERAL pools in this batch.`;
  };
  const topicLine = topic
    ? `\nEVERY video must be about: "${topic}"${allowGeneral ? ` (use category "general" if that topic isn't tech/editing related)` : ""}.`
    : "\nRotate across the topic pools.";

  const diffInstruction = `${sharedBlocks}

You are generating ${DIFF_COUNT} "difference" video script(s) (variant="difference").${generalLine(GENERAL_DIFF, DIFF_COUNT)}${topicLine}

Each video's segments array contains exactly 2 entries — two RELATED comparisons from the same topic family. Each segment compares its own A/B pair following the script formula from the profile EXACTLY — the renderer depends on the sentence structure. Use natural articles in the intro sentences.`;

  const dykInstruction = `${sharedBlocks}

You are generating ${DYK_COUNT} "didyouknow" video script(s) (variant="didyouknow").${generalLine(GENERAL_DYK, DYK_COUNT)}${topicLine}

Each video has ONE segment: one genuinely surprising true fact.
- hook: MUST literally start with the words "${cfg.dykOpener}" — max 11 words total.
- The segment's introA = the FACT itself, one punchy sentence, max 16 words.
- The segment's defA = WHY/how it works, one sentence, max 16 words.
- aLabel = short display label; aSearchQuery + aImagePrompt for its single visual.
  Leave bLabel, introB, defB, bSearchQuery, bImagePrompt as empty strings.
- aSearchQuery doubles as a STOCK VIDEO search — prefer a scene with natural MOTION.
- outro: engagement question + "${cfg.outro}"`;

  return { diffInstruction, dykInstruction, DIFF_COUNT, DYK_COUNT, GENERAL_COUNT };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/__tests__/diff-prompt.test.mjs`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Wire `generate-diff-scripts.mjs` to use the config + builder**

In `scripts/generate-diff-scripts.mjs`, make these edits:

Replace the imports + client resolution (lines ~12–24) — the current block that imports `resolveClient` and `applyTechsplainsGcpEnv` — with:

```js
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient, makeStamp, slugify } from "./lib/diff-config.mjs";
import { buildInstructions } from "./lib/diff-prompt.mjs";

const { client: CLIENT_ID, rest } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
cfg.applyGcpEnv();

const COUNT = parseInt(rest[0] || "3", 10);
const TOPIC = rest.slice(1).join(" ").trim();
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const voiceProfile = await fs.readFile(cfg.voiceProfilePath, "utf-8");
```

Replace the brief-loading, ledger-loading, DYK/GENERAL split, and the two big `diffInstruction`/`dykInstruction` template literals (everything from the old `let brief = null;` down to the end of the `dykInstruction` template, ~lines 33–155) with:

```js
const ledgerPath = cfg.ledgerPath;
let ledger = { used: [] };
try { ledger = JSON.parse(await fs.readFile(ledgerPath, "utf-8")); } catch { /* first run */ }

const DYK = parseInt(process.env.DIFF_DYK ?? process.env.TECHSPLAINS_DYK ?? String(Math.round(COUNT * (cfg.contentMix.dykDefault || 0))), 10) || 0;
const GENERAL = parseInt(process.env.DIFF_GENERAL ?? process.env.TECHSPLAINS_GENERAL ?? String(Math.round(COUNT * (cfg.contentMix.generalDefault || 0))), 10) || 0;

const { diffInstruction, dykInstruction, DIFF_COUNT, DYK_COUNT, GENERAL_COUNT } =
  buildInstructions(cfg, voiceProfile, ledger, { count: COUNT, topic: TOPIC, dyk: DYK, general: GENERAL });
```

Update the Vertex client construction (currently `project: TS_GCP.project, location: TS_GCP.location`) to use `cfg.gcp`:

```js
const ai = new GoogleGenAI({ vertexai: true, project: cfg.gcp.project, location: cfg.gcp.location });
```

Update the console banner and the two `generateVariant(... "Techsplains ...")` content strings and the output filename + ledger write. Specifically:
- The `generateContent` `contents` strings: replace `"Techsplains"` with `cfg.brandName` (2 occurrences in `generateVariant`).
- Output path: change `techsplains-scripts-${stamp}.json` to `` `${cfg.id}-scripts-${stamp}.json` ``.
- The `v.outro = v.outro || TS_OUTRO;` line → `v.outro = v.outro || cfg.outro;`.
- The final ledger `await fs.writeFile(ledgerPath, ...)` already uses `ledgerPath` (now `cfg.ledgerPath`).
- The DYK hook-guard regex `/^did you know/i` → build from opener: `const dykRe = new RegExp("^" + cfg.dykOpener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");` and use `dykRe.test(...)`; the auto-prefix fallback becomes `` v.hook = `${cfg.dykOpener} ${v.hook.trim()...}` ``.

- [ ] **Step 6: Smoke-test the wiring without calling Gemini**

Run: `node -e "import('./scripts/lib/diff-config.mjs').then(async m => { const c = await m.resolveDiffClient('tranzzie'); const p = await import('./scripts/lib/diff-prompt.mjs'); const vp = await (await import('node:fs/promises')).readFile(c.voiceProfilePath,'utf8').catch(()=> 'VOICE'); const r = p.buildInstructions(c, vp, {used:[]}, {count:2,dyk:1,general:0}); console.log(r.diffInstruction.includes('Tranzzie') && !r.diffInstruction.includes('Techsplains') ? 'OK brand' : 'FAIL brand'); })"`
Expected: `OK brand` (note: `voice-profile-tranzzie-video.md` may not exist yet — the `.catch` falls back so this still runs).

Run: `node --test scripts/__tests__/diff-prompt.test.mjs scripts/__tests__/diff-config.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/diff-prompt.mjs scripts/__tests__/diff-prompt.test.mjs scripts/generate-diff-scripts.mjs
git commit -m "feat(video): brand-parametrized prompt builder; --client in generate-diff-scripts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Thread `--client` through images, director, audio steps

**Files:**
- Create: `scripts/lib/diff-stamp.mjs`
- Test: `scripts/__tests__/render-diff-helpers.test.mjs` (stamp helper only in this task)
- Modify: `scripts/generate-diff-images.mjs`, `scripts/generate-diff-director.mjs`, `scripts/generate-diff-audio.mjs`

**Interfaces:**
- Produces: `stampFromScriptsPath(p: string) → string` — parses the batch stamp from either `<client>-scripts-<stamp>.json` or the legacy `techsplains-scripts-<stamp>.json`.
- Consumes: `resolveDiffClient`, `takeClientArg`.

- [ ] **Step 1: Write the failing test for the stamp helper**

Create `scripts/__tests__/render-diff-helpers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { stampFromScriptsPath } from "../lib/diff-stamp.mjs";

test("parses stamp from a client-prefixed scripts filename", () => {
  assert.equal(stampFromScriptsPath("/x/out/tranzzie-scripts-2026-07-11T09-30.json"), "2026-07-11T09-30");
});
test("parses stamp from the legacy techsplains filename", () => {
  assert.equal(stampFromScriptsPath("out/techsplains-scripts-2026-07-10T08-00.json"), "2026-07-10T08-00");
});
test("falls back to a generated stamp for an unrecognized name", () => {
  assert.match(stampFromScriptsPath("out/weird.json"), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/__tests__/render-diff-helpers.test.mjs`
Expected: FAIL — `Cannot find module '../lib/diff-stamp.mjs'`.

- [ ] **Step 3: Implement `scripts/lib/diff-stamp.mjs`**

```js
// Parse the shared batch stamp from a <client>-scripts-<stamp>.json filename.
// Accepts any lowercase client prefix and the legacy "techsplains-" prefix.
export function stampFromScriptsPath(p) {
  const m = String(p).match(/[a-z0-9]+-scripts-(.+)\.json$/i);
  return m ? m[1] : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/__tests__/render-diff-helpers.test.mjs`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Update `generate-diff-images.mjs`**

- Replace the stamp derivation (the `const stamp = scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] || …` block) with:

```js
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";
// …
const stamp = stampFromScriptsPath(scriptsPath);
```

- Accept and ignore a leading `--client <id>` so the orchestrator can pass it uniformly. At the top, after `const scriptsArg = process.argv[2];`, change argv handling to strip the client flag:

```js
import { takeClientArg } from "./lib/client.mjs";
const { rest: imgArgs } = takeClientArg(process.argv.slice(2));
const scriptsArg = imgArgs[0];
```

(The image step is brand-neutral — it needs no other config. The `category === "general"` steering stays as-is; Tranzzie videos are never `general`, so they take the non-general branch, which is correct for eyewear.)

- [ ] **Step 6: Update `generate-diff-director.mjs`**

- Replace the `applyTechsplainsGcpEnv()` import/call and `TS_GCP` usage with config:

```js
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";
// …
const { client: CLIENT_ID, rest: dirArgs } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
cfg.applyGcpEnv();
const scriptsArg = dirArgs[0];
```

- Change the env kill-switch `TECHSPLAINS_DIRECTOR === "0"` to also accept `DIFF_DIRECTOR === "0"` (keep the old name working): `if (process.env.DIFF_DIRECTOR === "0" || process.env.TECHSPLAINS_DIRECTOR === "0")`.
- Replace `const stamp = scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] || "unknown";` with `const stamp = stampFromScriptsPath(scriptsPath);`.
- `new GoogleGenAI({ … project: TS_GCP.project, location: TS_GCP.location })` → `project: cfg.gcp.project, location: cfg.gcp.location`.
- In `reviewInstruction`, replace the literal `Techsplains` brand references and the two hardcoded checks (`/follow techsplains/i` in the fix-guard, and the `"Follow Techsplains for more!"` rule text) with `cfg.brandName` / a regex built from `cfg.outro`. Specifically the outro fix-guard becomes:

```js
const outroRe = new RegExp("follow " + cfg.brandName, "i");
// …
if (r.outro && words(r.outro) <= 16 && outroRe.test(r.outro)) v.outro = r.outro;
```

- The DYK hook fix-guard `/^did you know/i` → `new RegExp("^" + cfg.dykOpener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")`.
- **Add the Tranzzie banned-phrase guardrail** to the review instruction, only when the brief carries one:

```js
const banned = (cfg.brief?.bannedPhrases || []);
const bannedBlock = banned.length
  ? `\n\nHARD BRAND RULE: This brand makes NO medical-cure claims. Reject or repair any script containing or implying: ${banned.join(", ")}. Rewrite to an encouraging, non-cure phrasing (e.g. suggest an eye check) rather than dropping the video when possible.`
  : "";
```

Append `${bannedBlock}` to `reviewInstruction`.

- [ ] **Step 7: Update `generate-diff-audio.mjs`**

- Swap the techsplains import for config + client flag:

```js
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";
// …
const { client: CLIENT_ID, rest: audArgs } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
cfg.applyGcpEnv();
const scriptsArg = audArgs[0];
```

- `const WHISPER_MODEL = process.env.TECHSPLAINS_WHISPER_MODEL || "mlx-community/whisper-large-v3-mlx";` — keep, but add a per-client whisper language.
- Replace `const stamp = scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] || …` with `const stamp = stampFromScriptsPath(scriptsPath);`.
- `new GoogleGenAI({ … project: TS_GCP.project, location: TS_GCP.location })` → `cfg.gcp`.
- In `ttsFull`, replace `TS_TTS.stylePrompt`, `TS_TTS.model`, `TS_TTS.voice` with `cfg.tts.stylePrompt`, `cfg.tts.model`, `cfg.tts.voice`.
- Tempo correction: replace `TS_TTS.maxTempo` / `TS_TTS.targetSec` with `cfg.tts.maxTempo` / `cfg.tts.targetSec`.
- Whisper language: the `mlx_whisper` call currently passes `"--language", "en"`. Change to honor config:

```js
const whisperArgs = [fullWav, "--model", WHISPER_MODEL];
if (cfg.whisperLang && cfg.whisperLang !== "auto") whisperArgs.push("--language", cfg.whisperLang);
whisperArgs.push("--word-timestamps", "True", "--output-format", "json", "--output-dir", absDir, "--output-name", `${vid}-voice`);
await run("mlx_whisper", whisperArgs, { maxBuffer: 32 * 1024 * 1024 });
```

(For Tranzzie `whisperLang:"auto"`, mlx_whisper auto-detects Tagalog/English — captions still use the script text, whisper only supplies timing.)

- [ ] **Step 8: Smoke-check all three still import cleanly**

Run: `node --check scripts/generate-diff-images.mjs && node --check scripts/generate-diff-director.mjs && node --check scripts/generate-diff-audio.mjs && echo "syntax ok"`
Expected: `syntax ok`

Run: `node --test scripts/__tests__/render-diff-helpers.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/lib/diff-stamp.mjs scripts/__tests__/render-diff-helpers.test.mjs scripts/generate-diff-images.mjs scripts/generate-diff-director.mjs scripts/generate-diff-audio.mjs
git commit -m "feat(video): --client + config-driven TTS/whisper/QC for images, director, audio

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `render-diff-batch.mjs` — template select + presenter poses from config

**Files:**
- Modify: `scripts/render-diff-batch.mjs`
- Test: `scripts/__tests__/render-diff-helpers.test.mjs` (extend with composition + poses helpers)

**Interfaces:**
- Produces:
  - `compositionFor(template, variant) → string` — `"mascot"`+`"didyouknow"`→`"DidYouKnowCard"`, `"mascot"`+else→`"DifferenceCard"`, `"photo"`+`"didyouknow"`→`"TranzzieDidYouKnowCard"`, `"photo"`+else→`"TranzzieDiffCard"`.
  - `posePropsFor(cfg) → Record<string,string>` — phase kind → `staticFile`-relative pose path (`poseFileFor`).
- Consumes: `resolveDiffClient`, `stampFromScriptsPath`, `takeClientArg`.

- [ ] **Step 1: Extend the failing test**

Append to `scripts/__tests__/render-diff-helpers.test.mjs`:

```js
import { compositionFor, posePropsFor } from "../lib/render-diff-helpers.mjs";
import { resolveDiffClient } from "../lib/diff-config.mjs";

test("compositionFor maps template+variant to a Remotion id", () => {
  assert.equal(compositionFor("mascot", "difference"), "DifferenceCard");
  assert.equal(compositionFor("mascot", "didyouknow"), "DidYouKnowCard");
  assert.equal(compositionFor("photo", "difference"), "TranzzieDiffCard");
  assert.equal(compositionFor("photo", "didyouknow"), "TranzzieDidYouKnowCard");
});

test("posePropsFor resolves each phase kind to its poseDir path", async () => {
  const c = await resolveDiffClient("tranzzie");
  const poses = posePropsFor(c);
  assert.equal(poses.defA, "characters/tranzzie/jurie-explain.png");
  assert.equal(poses.outro, "characters/tranzzie/jurie-base.png");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/__tests__/render-diff-helpers.test.mjs`
Expected: FAIL — `Cannot find module '../lib/render-diff-helpers.mjs'`.

- [ ] **Step 3: Implement `scripts/lib/render-diff-helpers.mjs`**

```js
// Pure helpers for render-diff-batch.mjs: pick the Remotion composition for a
// brand template + variant, and build the phase-kind → pose-path map.
import { poseFileFor } from "./diff-config.mjs";

export function compositionFor(template, variant) {
  const dyk = variant === "didyouknow";
  if (template === "photo") return dyk ? "TranzzieDidYouKnowCard" : "TranzzieDiffCard";
  return dyk ? "DidYouKnowCard" : "DifferenceCard";
}

export function posePropsFor(cfg) {
  const out = {};
  for (const kind of Object.keys(cfg.presenter.poses)) out[kind] = poseFileFor(cfg, kind);
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/__tests__/render-diff-helpers.test.mjs`
Expected: PASS — all tests pass.

- [ ] **Step 5: Wire `render-diff-batch.mjs`**

- Replace the client resolution + imports:

```js
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient, slugify } from "./lib/diff-config.mjs";
import { stampFromScriptsPath } from "./lib/diff-stamp.mjs";
import { compositionFor, posePropsFor } from "./lib/render-diff-helpers.mjs";
import { buildManifest } from "./lib/techsplains-manifest.mjs";

const { client: CLIENT_ID, rest: renderArgs } = takeClientArg(process.argv.slice(2));
const cfg = await resolveDiffClient(CLIENT_ID || "techsplains");
const scriptsArg = renderArgs[0];
```

- `const stamp = scriptsPath.match(/techsplains-scripts-(.+)\.json$/)?.[1] || …` → `const stamp = stampFromScriptsPath(scriptsPath);`.
- `const EXPORT_DIR = process.env.TECHSPLAINS_EXPORT_DIR || client.exportDir;` → `const EXPORT_DIR = process.env.DIFF_EXPORT_DIR || process.env.TECHSPLAINS_EXPORT_DIR || cfg.exportDir;`.
- Add poses once before the loop: `const poses = posePropsFor(cfg);`.
- In `inputProps`, replace the hardcoded `handle: TS_HANDLE, accent: "#FFDD00",` with `handle: cfg.handle, accent: cfg.accent, poses,`.
- Replace the composition select:

```js
const composition = await selectComposition({
  serveUrl: bundleLocation,
  id: compositionFor(cfg.template, v.variant),
  inputProps,
});
```

- The cleanup block references `process.env.TECHSPLAINS_KEEP_TEMP` — leave it, but also accept `DIFF_KEEP_TEMP`: `if (process.env.DIFF_KEEP_TEMP !== "1" && process.env.TECHSPLAINS_KEEP_TEMP !== "1")`.
- The gallery HTML `<title>Techsplains videos …` and `<h1>Techsplains — …` → use `${cfg.brandName}`.

- [ ] **Step 6: Syntax + helper check**

Run: `node --check scripts/render-diff-batch.mjs && node --test scripts/__tests__/render-diff-helpers.test.mjs && echo ok`
Expected: `ok` then PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/render-diff-helpers.mjs scripts/__tests__/render-diff-helpers.test.mjs scripts/render-diff-batch.mjs
git commit -m "feat(video): render selects composition + presenter poses from client config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `batch-diff.mjs` orchestrator (+ batch-techsplains shim)

**Files:**
- Create: `scripts/batch-diff.mjs`
- Create: `scripts/batch-techsplains.mjs` (replace contents with a shim)
- Test: `scripts/__tests__/batch-diff.test.mjs`

**Interfaces:**
- Produces: `newestScriptsFile(files: string[], clientId: string) → string | null` — newest `<clientId>-scripts-*.json` by lexical sort.

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/batch-diff.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestScriptsFile } from "../lib/diff-stamp.mjs";

test("picks the newest scripts file for the given client", () => {
  const files = [
    "tranzzie-scripts-2026-07-10T09-00.json",
    "tranzzie-scripts-2026-07-11T09-00.json",
    "techsplains-scripts-2026-07-11T10-00.json",
    "random.txt",
  ];
  assert.equal(newestScriptsFile(files, "tranzzie"), "tranzzie-scripts-2026-07-11T09-00.json");
  assert.equal(newestScriptsFile(files, "techsplains"), "techsplains-scripts-2026-07-11T10-00.json");
  assert.equal(newestScriptsFile(files, "nobody"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/__tests__/batch-diff.test.mjs`
Expected: FAIL — `newestScriptsFile is not a function` (it's not exported yet).

- [ ] **Step 3: Add `newestScriptsFile` to `scripts/lib/diff-stamp.mjs`**

Append:

```js
export function newestScriptsFile(files, clientId) {
  const re = new RegExp(`^${clientId}-scripts-.*\\.json$`);
  const matches = files.filter((f) => re.test(f)).sort();
  return matches.length ? matches[matches.length - 1] : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/__tests__/batch-diff.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement `scripts/batch-diff.mjs`**

```js
#!/usr/bin/env node
// One-shot multi-brand difference-video batch: scripts → images → director →
// voice → render. Client-parametrized via --client (default techsplains).
//
//   node scripts/batch-diff.mjs --client tranzzie 3 "blue-light lenses"
//   npm run techsplains:batch -- 3 "camera gear"

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { takeClientArg } from "./lib/client.mjs";
import { newestScriptsFile } from "./lib/diff-stamp.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const { client, rest } = takeClientArg(process.argv.slice(2));
const CLIENT_ID = client || "techsplains";
const clientFlag = ["--client", CLIENT_ID];

const step = (label, script, stepArgs) =>
  new Promise((resolve, reject) => {
    console.log(`\n━━━ ${label} ━━━`);
    const p = spawn(process.execPath, [path.join(__dirname, script), ...stepArgs], {
      stdio: "inherit",
      cwd: projectRoot,
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });

// 1) Scripts — client flag + the passthrough count/topic args.
await step("1/5 Scripts (Gemini)", "generate-diff-scripts.mjs", [...clientFlag, ...rest]);

const outDir = path.join(projectRoot, "out");
const scriptsFile = newestScriptsFile(await fs.readdir(outDir), CLIENT_ID);
if (!scriptsFile) {
  console.error(`No ${CLIENT_ID}-scripts-*.json found in out/ — generation failed?`);
  process.exit(1);
}
const scriptsPath = path.join(outDir, scriptsFile);

await step("2/5 Visuals", "generate-diff-images.mjs", [...clientFlag, scriptsPath]);
await step("3/5 Director QC", "generate-diff-director.mjs", [...clientFlag, scriptsPath]);
await step("4/5 Voiceover + timings", "generate-diff-audio.mjs", [...clientFlag, scriptsPath]);
await step("5/5 Render + export", "render-diff-batch.mjs", [...clientFlag, scriptsPath]);

console.log(`\n✓ ${CLIENT_ID} batch complete.`);
```

- [ ] **Step 6: Replace `scripts/batch-techsplains.mjs` with a shim**

Replace the entire contents of `scripts/batch-techsplains.mjs` with:

```js
#!/usr/bin/env node
// SHIM — batch-techsplains.mjs now delegates to the multi-brand batch-diff.mjs
// with --client techsplains. Kept so `npm run techsplains:batch` and any direct
// callers keep working unchanged.
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [path.join(__dirname, "batch-diff.mjs"), "--client", "techsplains", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("close", (code) => process.exit(code ?? 0));
```

- [ ] **Step 7: Syntax check both**

Run: `node --check scripts/batch-diff.mjs && node --check scripts/batch-techsplains.mjs && node --test scripts/__tests__/batch-diff.test.mjs && echo ok`
Expected: `ok` then PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/batch-diff.mjs scripts/batch-techsplains.mjs scripts/lib/diff-stamp.mjs scripts/__tests__/batch-diff.test.mjs
git commit -m "feat(video): batch-diff orchestrator with --client; batch-techsplains shim

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Tranzzie voice profile + brief DYK prompts + config state files

**Files:**
- Create: `scripts/voice-profile-tranzzie-video.md`
- Modify: `config/briefs.json` (add DYK-friendly prompts to `brief_tranzzie`)
- Create: `config/tranzzie-video-ledger.json`
- Modify: `.gitignore`
- Test: `scripts/__tests__/diff-prompt.test.mjs` (add a Tranzzie-profile integration assertion)

**Interfaces:** none (content + config).

- [ ] **Step 1: Write `scripts/voice-profile-tranzzie-video.md`**

Create the file with Tranzzie's narrated-video voice (mirrors the Techsplains profile's *structure* so the same script schema/formula holds, but in Taglish and Tranzzie's rules):

```markdown
# Tranzzie — video voice profile

Tranzzie Eyeglasses is a warm, trustworthy Filipino optical clinic (since 2019).
These are short vertical explainer videos about eyewear and eye care. The
presenter is Jurie — a friendly "ate/tito optometrist" who explains simply and
cares about your eyes. Audience: everyday Filipinos — students, screen/office
workers, drivers, commuters, parents. Educational first, never a hard seller,
never fear-mongering.

## Hard tone rules
- Taglish — natural Tagalog + English mix, punchy, simple, readable aloud.
- **No medical cure claims.** Never say glasses "cure" or "heal" the eyes,
  never "100% guaranteed", never "no need for a doctor". Encourage an eye check
  instead. Banned: cure, gagaling ang mata mo, permanenteng solusyon, 100%
  guaranteed, no need for doctor, instant na malinaw.
- Never shame the viewer. Warm, caring, helpful.

## The script formula (never deviate)
Each VIDEO opens with a HOOK, then TWO segments (difference) or ONE (did-you-know),
and closes with an engagement OUTRO.

**Hook** (≤ 9 words): one relatable line that makes scrolling past feel like
missing out — a vision/eyewear pain or a curiosity gap. e.g. "Mali ang pagpili
mo ng salamin?" / "Bakit mahal ang tamang salamin?"

**difference** — each SEGMENT compares two commonly confused eyewear things,
exact sentence pattern (the renderer depends on it):
1. `Ito ay <X>.`
2. `Ito ay <Y>.`
3. `Ano ang pagkakaiba?` — always verbatim
4. One sentence defining X, starts with the term, ≤ 16 words, Taglish.
5. One sentence defining Y, mirrored structure, ≤ 16 words.

**didyouknow** — one segment, one true, useful eyewear/eye-care fact:
- hook MUST literally start with "Alam mo ba".
- introA = the fact; defA = why it matters. Each one sentence, ≤ 16 words.

**Outro** (2 short sentences): a one-word-answerable engagement question + the
follow CTA. Invite a one-word comment (default "EYECARE").

## Topic selection
On-brief eyewear / eye care ONLY (no non-tech "fun facts"): lens types
(single-vision vs progressive, blue-light vs regular, photochromic vs
sunglasses), frame types (acetate vs metal, full-rim vs rimless), how to pick
frames for your FACE SHAPE, and WHY it's worth investing in good eyewear / an
eye check. Prefer pairs people genuinely mix up, with a "ganun pala" payoff.

## Image sourcing (real photos first)
For every segment item provide BOTH searchQuery (2–4 plain keywords for a
photo/video search — real eyewear/scenes: "progressive lens glasses", "man
squinting sun glare driving", "woman trying eyeglasses optical shop") and
imagePrompt (AI fallback: "professional stock photo of <thing>, clean neutral
background, soft lighting"). Concrete, photographable subjects only. Do NOT add
"no text / no watermark" — the pipeline appends that.

## Facebook caption
1–3 short Taglish sentences that tease the video and invite a one-word comment
of the CTA keyword. End with: Comment "EYECARE" — Tranzzie Eyeglasses. No
hashtag walls (0–2 max), no medical claims.
```

- [ ] **Step 2: Add DYK-friendly angles to `brief_tranzzie` in `config/briefs.json`**

In `config/briefs.json`, find the `brief_tranzzie` object and add a `generalTopics`-style set of DYK prompts under a new `videoDykTopics` key (used as extra hints; `allowGeneral:false` means the generic GENERAL pool stays off, so this is just richer topic material). Add these keys to the object (do not remove existing `topics`/`voiceNotes`/`bannedPhrases`):

```jsonc
"videoDykTopics": [
  "how to pick eyeglass frames for your face shape (round, square, heart, oval)",
  "why investing in good eyeglasses / an eye check is worth it",
  "how blue-light lenses help daily screen users",
  "why UV protection matters for your eyes outdoors",
  "signs it's time for an eye check or new eyeglasses"
]
```

Then, so these reach the prompt, in `scripts/lib/diff-prompt.mjs` extend the `briefBlock` to also list `brief.videoDykTopics` when present. Edit the `briefBlock` assignment to append:

```js
  const dykTopicBlock = brief.videoDykTopics?.length
    ? `\n\n## DID-YOU-KNOW / GUIDE ANGLES (use for variant "didyouknow"):\n` +
      brief.videoDykTopics.map((t) => `- ${t}`).join("\n")
    : "";
```

and include `${dykTopicBlock}` in the `sharedBlocks` template (right after `${generalBlock}`).

- [ ] **Step 3: Add a test asserting the Tranzzie DYK angles reach the prompt**

Append to `scripts/__tests__/diff-prompt.test.mjs`:

```js
test("videoDykTopics are surfaced in the shared blocks", () => {
  const cfg = {
    brandName: "Tranzzie", outro: "Follow Tranzzie for more!", dykOpener: "Alam mo ba",
    contentMix: { dykDefault: 0.34, generalDefault: 0, allowGeneral: false },
    brief: { topics: ["blue-light vs regular"], videoDykTopics: ["how to pick frames for your face shape"] },
  };
  const r = buildInstructions(cfg, "VOICE", { used: [] }, { count: 2, dyk: 1, general: 0 });
  assert.match(r.dykInstruction, /face shape/);
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/__tests__/diff-prompt.test.mjs`
Expected: PASS — all diff-prompt tests pass (including the new one).

- [ ] **Step 5: Create the empty ledger + gitignore the queue**

```bash
echo '{ "used": [] }' > config/tranzzie-video-ledger.json
```

Add to `.gitignore` (after the existing `config/techsplains-queue.json` line):

```
config/tranzzie-video-queue.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/voice-profile-tranzzie-video.md config/briefs.json config/tranzzie-video-ledger.json scripts/lib/diff-prompt.mjs scripts/__tests__/diff-prompt.test.mjs .gitignore
git commit -m "feat(video): Tranzzie video voice profile + DYK angles + state files

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: One-time Jurie pose-set generator

**Files:**
- Create: `scripts/generate-presenter-poses.mjs`
- Create: `scripts/lib/presenter-poses.mjs` (pure helpers)
- Test: `scripts/__tests__/presenter-poses.test.mjs`

**Interfaces:**
- Produces:
  - `posesToGenerate(presenter, existsFn) → Array<{kind, file, prompt}>` — the distinct pose files not yet on disk (dedupes files shared across kinds, e.g. `hook`/`introA` both `jurie-point.png`).
  - `posePrompt(file, brandName) → string` — the identity+attitude prompt for a given pose file (keyed by filename stem).

- [ ] **Step 1: Write the failing test**

Create `scripts/__tests__/presenter-poses.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { posesToGenerate, posePrompt } from "../lib/presenter-poses.mjs";

const presenter = {
  poseDir: "characters/tranzzie",
  poses: {
    hook: "jurie-point.png", introA: "jurie-point.png", introB: "jurie-present.png",
    question: "jurie-think.png", defA: "jurie-explain.png", defB: "jurie-point.png",
    outro: "jurie-base.png",
  },
};

test("dedupes pose FILES (point appears 3× → generated once)", () => {
  const jobs = posesToGenerate(presenter, () => false);
  const files = jobs.map((j) => j.file).sort();
  assert.deepEqual(files, ["jurie-base.png", "jurie-explain.png", "jurie-point.png", "jurie-present.png", "jurie-think.png"]);
});

test("skips files that already exist on disk", () => {
  const jobs = posesToGenerate(presenter, (f) => f.endsWith("jurie-point.png"));
  assert.ok(!jobs.some((j) => j.file === "jurie-point.png"));
  assert.equal(jobs.length, 4);
});

test("posePrompt forces a black studio background and the same person", () => {
  const p = posePrompt("jurie-point.png", "Tranzzie");
  assert.match(p, /black/i);
  assert.match(p, /point/i);
  assert.doesNotMatch(p, /text|watermark|logo/i); // pipeline never asks for text
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/__tests__/presenter-poses.test.mjs`
Expected: FAIL — `Cannot find module '../lib/presenter-poses.mjs'`.

- [ ] **Step 3: Implement `scripts/lib/presenter-poses.mjs`**

```js
// Pure helpers for the one-time Jurie pose-set generator.
import path from "node:path";

// Attitude per pose-file stem. Every prompt keeps the SAME person on a PURE
// BLACK studio background (so she composites onto the dark card with a feathered
// top edge — no bg-removal dependency), upper-body, facing camera, friendly.
const ATTITUDE = {
  "jurie-point": "pointing/gesturing to one side with an open hand, as if directing attention to something beside her",
  "jurie-present": "presenting with an open upturned palm, welcoming gesture",
  "jurie-think": "one hand near her chin, thoughtful and curious expression",
  "jurie-explain": "mid-explanation, calm relaxed hands, warm approachable expression",
  "jurie-base": "friendly neutral standing pose, gentle smile, hands relaxed",
};

export function posePrompt(file, brandName) {
  const stem = file.replace(/\.png$/i, "");
  const attitude = ATTITUDE[stem] || "friendly neutral pose, gentle smile";
  return (
    `Photorealistic upper-body portrait of the SAME young man from the reference photos ` +
    `(same face, same glasses, same hair) — the ${brandName} presenter. He is ${attitude}. ` +
    `Shot on a PURE SOLID BLACK studio background (#000000), soft key light, sharp focus, ` +
    `natural skin, casual modern outfit consistent across shots, centered, waist-up, ` +
    `looking toward the camera. Vertical 9:16 friendly explainer-host energy.`
  );
}

export function posesToGenerate(presenter, existsFn) {
  const seen = new Set();
  const jobs = [];
  // Stable order by first appearance in the poses map.
  for (const [kind, file] of Object.entries(presenter.poses)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.posix.join(presenter.poseDir, file);
    if (existsFn(rel) || existsFn(file)) continue;
    jobs.push({ kind, file, prompt: posePrompt(file, presenter._brandName || "the") });
  }
  return jobs;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/__tests__/presenter-poses.test.mjs`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Implement `scripts/generate-presenter-poses.mjs`**

This loads the client's `presenter.characterId` reference photos, and for each pose-file calls `gemini-2.5-flash-image` with those photos as `inlineData` (identity lock — the exact mechanism from `generate-backgrounds-jurie.mjs`) plus the pose prompt, saving to `public/<poseDir>/<file>`.

```js
#!/usr/bin/env node
// ONE-TIME presenter pose-set generator. Produces the photoreal Jurie poses the
// video render composites per phase (like the Techsplains mascot, but real).
// Idempotent: skips any pose file that already exists.
//
//   node scripts/generate-presenter-poses.mjs --client tranzzie
//   node scripts/generate-presenter-poses.mjs --client tranzzie --force

import fs from "node:fs/promises";
import { accessSync } from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { projectRoot, takeClientArg } from "./lib/client.mjs";
import { resolveDiffClient } from "./lib/diff-config.mjs";
import { posesToGenerate, posePrompt } from "./lib/presenter-poses.mjs";

const { client: CLIENT_ID, rest } = takeClientArg(process.argv.slice(2));
const FORCE = rest.includes("--force");
const cfg = await resolveDiffClient(CLIENT_ID || "tranzzie");
cfg.applyGcpEnv();

const presenter = { ...cfg.presenter, _brandName: cfg.brandName };
if (!presenter.characterId) {
  console.error(`Client "${cfg.id}" has no presenter.characterId (static mascot). Nothing to generate.`);
  process.exit(0);
}

// Resolve the character's reference photos from characters.json.
const chars = JSON.parse(await fs.readFile(path.join(projectRoot, "config", "characters.json"), "utf-8"));
const character = chars.find((c) => c.id === presenter.characterId);
if (!character?.photos?.length) {
  console.error(`Character "${presenter.characterId}" not found or has no photos.`);
  process.exit(1);
}

const mimeFor = (p) => {
  const ext = path.extname(p).toLowerCase().slice(1);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  return "image/png";
};

const refParts = [];
for (const rel of character.photos.slice(0, 3)) {
  try {
    const buf = await fs.readFile(path.join(projectRoot, "public", rel));
    refParts.push({ inlineData: { mimeType: mimeFor(rel), data: buf.toString("base64") } });
  } catch { console.warn(`  ref photo missing, skipping: ${rel}`); }
}
if (!refParts.length) { console.error("No usable reference photos — aborting."); process.exit(1); }

const outDir = path.join(projectRoot, "public", presenter.poseDir);
await fs.mkdir(outDir, { recursive: true });

const poseExists = (rel) => {
  const abs = rel.startsWith(presenter.poseDir) ? path.join(projectRoot, "public", rel) : path.join(outDir, rel);
  try { accessSync(abs); return true; } catch { return false; }
};
// FORCE regenerates every distinct pose file; otherwise skip existing.
const jobs = FORCE
  ? posesToGenerate(presenter, () => false)
  : posesToGenerate(presenter, poseExists);

if (!jobs.length) { console.log("All presenter poses already exist. Use --force to regenerate."); process.exit(0); }

const ai = new GoogleGenAI({ vertexai: true, project: cfg.gcp.project, location: cfg.gcp.imageLocation });
const MODEL = process.env.REF_MODEL || "gemini-2.5-flash-image";

console.log(`Generating ${jobs.length} presenter pose(s) for ${cfg.brandName} from ${refParts.length} ref photo(s)…`);
let ok = 0;
for (const job of jobs) {
  const prompt = job.prompt || posePrompt(job.file, cfg.brandName);
  const parts = [...refParts, { text: prompt }];
  let buf = null;
  for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
    try {
      const resp = await ai.models.generateContent({ model: MODEL, contents: [{ role: "user", parts }] });
      const rp = resp.candidates?.[0]?.content?.parts || [];
      for (const p of rp) if (p.inlineData?.data) { buf = Buffer.from(p.inlineData.data, "base64"); break; }
      if (!buf) console.warn(`  ${job.file}: no image (attempt ${attempt}/3)`);
    } catch (err) {
      console.warn(`  ${job.file}: ${String(err.message || err).slice(0, 100)} (attempt ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  if (!buf) { console.error(`  ✗ FAILED ${job.file}`); continue; }
  await fs.writeFile(path.join(outDir, job.file), buf);
  ok++;
  console.log(`  ✓ ${presenter.poseDir}/${job.file}`);
}
console.log(`\n✓ ${ok}/${jobs.length} presenter pose(s) written to public/${presenter.poseDir}/`);
console.log(`Review them, then regenerate any that drift with --force after deleting the file.`);
process.exit(ok === 0 ? 1 : 0);
```

- [ ] **Step 6: Syntax-check the generator**

Run: `node --check scripts/generate-presenter-poses.mjs && node --test scripts/__tests__/presenter-poses.test.mjs && echo ok`
Expected: `ok` then PASS.

- [ ] **Step 7: Generate the actual Jurie poses (real API call — needs Jurie GCP creds)**

This step requires the shared Jurie ADC to be present at `~/.config/gcloud/adc-jurie.json`. Run:

Run: `node scripts/generate-presenter-poses.mjs --client tranzzie`
Expected: `✓ 5/5 presenter pose(s) written to public/characters/tranzzie/` and five `jurie-*.png` files created.

Then eyeball each PNG (`public/characters/tranzzie/jurie-*.png`) — same face across all five, upper-body, black background. If one drifts, delete it and rerun (it regenerates only the missing file). If the environment has no Jurie creds available, skip the real generation and note it for the user; the render task (Task 8) tolerates missing pose files by showing a placeholder, and the assets can be generated later with this same command.

- [ ] **Step 8: Commit**

```bash
git add scripts/generate-presenter-poses.mjs scripts/lib/presenter-poses.mjs scripts/__tests__/presenter-poses.test.mjs public/characters/tranzzie/ 2>/dev/null
git commit -m "feat(video): one-time Jurie presenter pose-set generator (Nano-Banana identity lock)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `TranzzieDiffCard` + `TranzzieDidYouKnowCard` compositions

**Files:**
- Create: `src/TranzzieDiffCard/TranzzieDiffCard.tsx`
- Modify: `src/Root.tsx` (register both compositions)
- Test: `npm run lint` (eslint + tsc) is the gate; plus a runtime render smoke.

**Interfaces:**
- Consumes (from render-diff-batch inputProps): `{ segments, phases, audioSrc, durationSec, handle, accent, poses }` where `poses: Record<phaseKind,string>`.
- Reuses from `../DifferenceCard/DifferenceCard`: `chunkPhase`, `differenceCardSchema` (extended), `displayWord` (NOT used — Tranzzie keeps authored case).

- [ ] **Step 1: Extend the schema to accept `poses`**

In `src/DifferenceCard/DifferenceCard.tsx`, the exported `differenceCardSchema` currently has no `poses`. Add an optional `poses` field so both the mascot and photo cards can share the schema. Edit the schema object:

```ts
export const differenceCardSchema = z.object({
  segments: z.array(segmentSchema),
  phases: z.array(phaseSchema),
  audioSrc: z.string(),
  durationSec: z.number(),
  handle: z.string(),
  accent: z.string(),
  poses: z.record(z.string(), z.string()).optional(),
});
```

(Optional keeps `DifferenceCard`/`DidYouKnowCard` behavior identical — they ignore `poses` and use their hardcoded `POSE` maps.)

- [ ] **Step 2: Create `src/TranzzieDiffCard/TranzzieDiffCard.tsx`**

A dark-canvas composition: two comparison photos up top, gold/red/white word-pop captions (authored case), and the photoreal Jurie presenter pinned to a fixed lower zone, pose-swapped per phase from `poses`, with a feathered top edge (CSS mask) so the black-background portrait blends into the dark card.

```tsx
import { useEffect, useState } from "react";
import {
  AbsoluteFill, Audio, Img, Loop, OffthreadVideo,
  continueRender, delayRender, spring, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import { z } from "zod";
import { chunkPhase, differenceCardSchema } from "../DifferenceCard/DifferenceCard";

export const tranzzieDiffCardSchema = differenceCardSchema;
type Props = z.infer<typeof tranzzieDiffCardSchema>;
type Phase = Props["phases"][number];

export const calcMetaTranzzieDiffCard = ({ props }: { props: Props }) => ({
  durationInFrames: Math.max(60, Math.ceil((props.durationSec + 0.6) * 30)),
  fps: 30, width: 1080, height: 1920,
});

// Diff-video word objects carry only { w, s, e } timings — no poster-style
// per-word emphasis — so captions use one hero color (gold) rather than the
// rb/r/g highlight the posters use. Brand red lives in the DYK stamp accent.
const GOLD = "#F5C13B", GOLD_LIGHT = "#FFE27A", GOLD_DEEP = "#C7902A";

// Feathered black-background presenter: mask fades the top so the portrait's
// black studio bg blends into the dark card, no hard rectangle edge.
const Presenter: React.FC<{ src?: string; pop: number; bob: number }> = ({ src, pop, bob }) =>
  src ? (
    <div style={{ position: "absolute", bottom: 0, width: "100%", display: "flex", justifyContent: "center" }}>
      <Img
        src={staticFile(src)}
        style={{
          height: 760,
          transform: `scale(${0.92 + 0.08 * pop}) translateY(${bob}px)`,
          transformOrigin: "center bottom",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 22%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 22%)",
        }}
      />
    </div>
  ) : null;

export const TranzzieDiffCard: React.FC<Props> = ({ segments, phases, audioSrc, handle, poses }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;

  const [fontHandle] = useState(() => delayRender("load-fonts-tranzzie"));
  useEffect(() => {
    const face = new FontFace("Montserrat", `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`, { weight: "100 900" });
    face.load().then((f) => { document.fonts.add(f); continueRender(fontHandle); }).catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  let phaseIdx = 0;
  for (let i = 0; i < phases.length; i++) if (t >= phases[i].start - 0.01) phaseIdx = i;
  const phase: Phase = phases[phaseIdx];
  const segIdx = phase.seg >= 0 ? phase.seg : segments.length - 1;
  const seg = segments[segIdx];

  const startOf = (kind: string, s: number) => phases.find((p) => p.seg === s && p.kind === kind)?.start ?? 0;
  const aStart = startOf("introA", segIdx), bStart = startOf("introB", segIdx);
  const aVisible = t >= aStart - 0.02, bVisible = t >= bStart - 0.02;
  const popIn = (since: number) => spring({ frame: Math.max(0, (t - since) * fps), fps, config: { damping: 14, mass: 0.6 } });

  const single = !seg.bLabel;
  const imgSize = single ? 620 : 470;
  const imgY = 210;
  const slotX = (side: "a" | "b") => (single ? (width - imgSize) / 2 : side === "a" ? 45 : width - 45 - imgSize);

  const slot = (side: "a" | "b") => {
    if (side === "b" && single) return null;
    const visible = side === "a" ? aVisible : bVisible;
    if (!visible) return null;
    const src = side === "a" ? seg.aImg : seg.bImg;
    const label = side === "a" ? seg.aLabel : seg.bLabel;
    const pop = popIn(side === "a" ? aStart : bStart);
    return (
      <div style={{ position: "absolute", left: slotX(side), top: imgY, width: imgSize, transform: `scale(${pop})`, transformOrigin: "center top" }}>
        <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 800, fontSize: label.length > 12 ? 44 : 54, lineHeight: 1.15, color: "#fff", textAlign: "center", height: 140, marginBottom: 18, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div>{label}</div>
        </div>
        <div style={{ width: imgSize, height: imgSize, borderRadius: 28, overflow: "hidden", boxShadow: "0 10px 34px rgba(0,0,0,0.5)", border: `2px solid ${GOLD_DEEP}` }}>
          {side === "a" && seg.aVideo ? (
            <Loop durationInFrames={Math.max(fps, Math.round((seg.aVideoDurationSec || 8) * fps))} layout="none">
              <OffthreadVideo muted src={staticFile(seg.aVideo)} style={{ width: imgSize, height: imgSize, objectFit: "cover" }} />
            </Loop>
          ) : src ? (
            <Img src={staticFile(src)} style={{ width: imgSize, height: imgSize, objectFit: "cover" }} />
          ) : (
            <div style={{ width: imgSize, height: imgSize, background: "#222" }} />
          )}
        </div>
      </div>
    );
  };

  const chunks = chunkPhase(phase);
  const chunk = chunks.find((c) => t >= c.s - 0.04 && t <= c.e + 0.22);
  const chunkPop = chunk ? spring({ frame: Math.max(0, (t - chunk.s) * fps), fps, config: { damping: 12, mass: 0.5 } }) : 0;

  const posePop = spring({ frame: Math.max(0, (t - phase.start) * fps), fps, config: { damping: 13, mass: 0.7 } });
  const bob = Math.sin(frame / 14) * 8;
  const poseSrc = poses?.[phase.kind];

  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 30%, #17140C 0%, #0A0A0A 60%, #080810 100%)" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      {slot("a")}
      {slot("b")}

      {/* Caption band — between the photos and the presenter */}
      <div style={{ position: "absolute", top: 880, left: 60, width: width - 120, height: 250, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3 }}>
        {chunk ? (
          <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 92, lineHeight: 1.05, textAlign: "center", color: GOLD_LIGHT, WebkitTextStroke: "4px rgba(0,0,0,0.6)", paintOrder: "stroke fill", transform: `scale(${0.82 + 0.18 * chunkPop})` }}>
            {chunk.words.map((w) => w.w).join(" ")}
          </div>
        ) : null}
      </div>

      {/* Jurie presenter, pose-swapped per phase */}
      <Presenter src={poseSrc} pop={posePop} bob={bob} />

      {/* Handle watermark */}
      <div style={{ position: "absolute", bottom: 28, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 34, color: GOLD, opacity: 0.85, zIndex: 4 }}>
        {handle}
      </div>
    </AbsoluteFill>
  );
};

// "Alam mo ba" full-bleed variant.
export const tranzzieDidYouKnowCardSchema = differenceCardSchema;
export const calcMetaTranzzieDidYouKnowCard = calcMetaTranzzieDiffCard;

export const TranzzieDidYouKnowCard: React.FC<Props> = ({ segments, phases, audioSrc, handle, poses }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  const [fontHandle] = useState(() => delayRender("load-fonts-tz-dyk"));
  useEffect(() => {
    const face = new FontFace("Montserrat", `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`, { weight: "100 900" });
    face.load().then((f) => { document.fonts.add(f); continueRender(fontHandle); }).catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  let phaseIdx = 0;
  for (let i = 0; i < phases.length; i++) if (t >= phases[i].start - 0.01) phaseIdx = i;
  const phase: Phase = phases[phaseIdx];
  const seg = segments[0];
  const bgSrc = seg?.aVideo || seg?.aImg;

  const chunks = chunkPhase(phase);
  const chunk = chunks.find((c) => t >= c.s - 0.04 && t <= c.e + 0.22);
  const chunkPop = chunk ? spring({ frame: Math.max(0, (t - chunk.s) * fps), fps, config: { damping: 12, mass: 0.5 } }) : 0;
  const kb = 1 + Math.min(0.14, Math.max(0, t) * 0.008);
  const posePop = spring({ frame: Math.max(0, (t - phase.start) * fps), fps, config: { damping: 13, mass: 0.7 } });
  const poseSrc = poses?.[phase.kind];

  return (
    <AbsoluteFill style={{ background: "#0A0A0A" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}
      {bgSrc ? (
        seg.aVideo ? (
          <Loop durationInFrames={Math.max(fps, Math.round((seg.aVideoDurationSec || 8) * fps))} layout="none">
            <OffthreadVideo muted src={staticFile(seg.aVideo)} style={{ width, height, objectFit: "cover" }} />
          </Loop>
        ) : (
          <Img src={staticFile(bgSrc)} style={{ width, height, objectFit: "cover", transform: `scale(${kb})` }} />
        )
      ) : null}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(8,8,16,0.35) 0%, rgba(8,8,16,0.15) 45%, rgba(8,8,16,0.85) 100%)" }} />

      {/* ALAM MO BA? stamp */}
      <div style={{ position: "absolute", top: 120, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 66, letterSpacing: 2, color: GOLD, WebkitTextStroke: "6px #111", paintOrder: "stroke fill" }}>
        ALAM MO BA?
      </div>

      <div style={{ position: "absolute", top: 760, left: 60, width: width - 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {chunk ? (
          <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 96, lineHeight: 1.06, textAlign: "center", color: "#fff", WebkitTextStroke: "4px rgba(0,0,0,0.6)", paintOrder: "stroke fill", transform: `scale(${0.82 + 0.18 * chunkPop})` }}>
            {chunk.words.map((w) => w.w).join(" ")}
          </div>
        ) : null}
      </div>

      {poseSrc ? (
        <div style={{ position: "absolute", bottom: 0, right: 20, display: "flex", justifyContent: "flex-end" }}>
          <Img src={staticFile(poseSrc)} style={{ height: 560, transform: `scale(${0.94 + 0.06 * posePop})`, transformOrigin: "right bottom", WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 24%)", maskImage: "linear-gradient(to bottom, transparent 0%, black 24%)" }} />
        </div>
      ) : null}

      <div style={{ position: "absolute", bottom: 28, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 34, color: GOLD, opacity: 0.9 }}>
        {handle}
      </div>
    </AbsoluteFill>
  );
};
```

- [ ] **Step 3: Register both compositions in `src/Root.tsx`**

Add the import alongside the existing `DifferenceCard`/`DidYouKnowCard` imports:

```ts
import {
  TranzzieDiffCard, tranzzieDiffCardSchema, calcMetaTranzzieDiffCard,
  TranzzieDidYouKnowCard, tranzzieDidYouKnowCardSchema, calcMetaTranzzieDidYouKnowCard,
} from "./TranzzieDiffCard/TranzzieDiffCard";
```

Add two `<Composition>` entries next to the `DifferenceCard` one (copy its prop shape — `defaultProps` can be a minimal one-phase stub so the Studio preview loads). Use:

```tsx
<Composition
  id="TranzzieDiffCard"
  component={TranzzieDiffCard}
  durationInFrames={900}
  fps={30}
  width={1080}
  height={1920}
  schema={tranzzieDiffCardSchema}
  calculateMetadata={calcMetaTranzzieDiffCard}
  defaultProps={{
    segments: [{ aLabel: "Blue-light", bLabel: "Regular", aImg: "", bImg: "" }],
    phases: [{ key: "hook", seg: 0, kind: "hook", text: "Alam mo ba?", start: 0, end: 2, words: [{ w: "Alam", s: 0, e: 1 }] }],
    audioSrc: "",
    durationSec: 30,
    handle: "@tranzzie",
    accent: "#F5C13B",
    poses: {},
  }}
/>
<Composition
  id="TranzzieDidYouKnowCard"
  component={TranzzieDidYouKnowCard}
  durationInFrames={900}
  fps={30}
  width={1080}
  height={1920}
  schema={tranzzieDidYouKnowCardSchema}
  calculateMetadata={calcMetaTranzzieDidYouKnowCard}
  defaultProps={{
    segments: [{ aLabel: "Fact", bLabel: "", aImg: "", bImg: "" }],
    phases: [{ key: "hook", seg: 0, kind: "hook", text: "Alam mo ba?", start: 0, end: 2, words: [{ w: "Alam", s: 0, e: 1 }] }],
    audioSrc: "",
    durationSec: 30,
    handle: "@tranzzie",
    accent: "#F5C13B",
    poses: {},
  }}
/>
```

- [ ] **Step 4: Lint + typecheck**

Run: `npm run lint`
Expected: PASS — eslint clean, `tsc` reports no type errors. If tsc flags the unused `accent` prop in either component (it's destructured but the caption uses the fixed `GOLD_LIGHT`), prefix it with `_` in the destructure or reference it — simplest is to drop `accent` from the destructured props since the composition uses the gold constants directly. Keep `poses` and `handle`. (The `accent` field stays in the schema/inputProps for parity with `DifferenceCard`; the photo card just doesn't need it.)

- [ ] **Step 5: Render smoke test (real Remotion render, ~1–2 min)**

Create a tiny props file and render 1s to confirm the composition mounts. First write a stub props JSON:

```bash
cat > /tmp/tz-smoke.json <<'JSON'
{ "segments":[{"aLabel":"Blue-light","bLabel":"Regular","aImg":"","bImg":""}],
  "phases":[{"key":"hook","seg":0,"kind":"hook","text":"Alam mo ba","start":0,"end":2,"words":[{"w":"Alam","s":0,"e":0.5},{"w":"mo","s":0.5,"e":1}]},
            {"key":"s0-introA","seg":0,"kind":"introA","text":"Ito ay blue-light.","start":2,"end":4,"words":[{"w":"Ito","s":2,"e":3}]}],
  "audioSrc":"","durationSec":5,"handle":"@tranzzie","accent":"#F5C13B","poses":{} }
JSON
npx remotion render TranzzieDiffCard /tmp/tz-smoke.mp4 --props=/tmp/tz-smoke.json --frames=0-30
```

Expected: renders `/tmp/tz-smoke.mp4` with no crash (a dark frame with the "Alam mo ba" caption; presenter absent since `poses:{}`). If Jurie poses exist from Task 7, set `"poses":{"hook":"characters/tranzzie/jurie-point.png"}` to see her composited.

- [ ] **Step 6: Commit**

```bash
git add src/TranzzieDiffCard/TranzzieDiffCard.tsx src/DifferenceCard/DifferenceCard.tsx src/Root.tsx
git commit -m "feat(video): TranzzieDiffCard + TranzzieDidYouKnowCard (dark palette, Jurie presenter)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Per-client queue path + dashboard client switcher

**Files:**
- Modify: `scripts/lib/techsplains-queue.mjs` (accept a queue path)
- Modify: `scripts/techsplains-dashboard.mjs` (client switcher, per-client state)
- Modify: `scripts/techsplains-dashboard.html` (client `<select>`, `?client=` on calls)
- Test: `scripts/__tests__/techsplains-queue.test.mjs` (extend for path param)

**Interfaces:**
- Produces: `readQueue(queuePath?)`, `setEntry(key, patch, queuePath?)`, `getEntry(key, queuePath?)` — path defaults to the legacy env/default so existing callers/tests are unaffected.

- [ ] **Step 1: Extend the queue test for a custom path**

Append to `scripts/__tests__/techsplains-queue.test.mjs`:

```js
import os from "node:os";
test("setEntry/readQueue honor an explicit per-client queue path", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tzq-"));
  const qp = path.join(dir, "tranzzie-video-queue.json");
  await setEntry("2026-07-11T09-00/tranzzie-01.mp4", { status: "approved" }, qp);
  const q = await readQueue(qp);
  assert.equal(q["2026-07-11T09-00/tranzzie-01.mp4"].status, "approved");
});
```

(`fs`, `path` are already imported at the top of that test file.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test scripts/__tests__/techsplains-queue.test.mjs`
Expected: FAIL — the new test writes to the default path, not `qp` (the third arg is currently ignored), so `readQueue(qp)` returns `{}`.

- [ ] **Step 3: Add the optional path param in `scripts/lib/techsplains-queue.mjs`**

Change the signatures to thread an optional path (default = existing `QUEUE_PATH`), and serialize per-path so two brands don't interleave:

```js
export async function readQueue(queuePath = QUEUE_PATH) {
  try {
    return JSON.parse(await fs.readFile(queuePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeQueue(obj, queuePath) {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  const tmp = `${queuePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, queuePath);
}

const chains = new Map();
export function setEntry(key, patch, queuePath = QUEUE_PATH) {
  const run = async () => {
    const q = await readQueue(queuePath);
    q[key] = { ...(q[key] || {}), ...patch };
    await writeQueue(q, queuePath);
    return q[key];
  };
  const prev = chains.get(queuePath) || Promise.resolve();
  const result = prev.then(run, run);
  chains.set(queuePath, result.catch(() => {}));
  return result;
}

export async function getEntry(key, queuePath = QUEUE_PATH) {
  return (await readQueue(queuePath))[key] || null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test scripts/__tests__/techsplains-queue.test.mjs`
Expected: PASS — all queue tests (old + new) pass.

- [ ] **Step 5: Make the dashboard client-aware in `scripts/techsplains-dashboard.mjs`**

- Import the resolver: `import { resolveDiffClient } from "./lib/diff-config.mjs";` (keep `resolveClient` import removed if unused).
- Replace the single `const client = await resolveClient("techsplains");` + `EXPORT_DIR` with a per-request resolver and a known-client allowlist:

```js
const CLIENTS = ["techsplains", "tranzzie"];
async function clientCtx(req) {
  const id = CLIENTS.includes(req.query.client) ? req.query.client : "techsplains";
  const cfg = await resolveDiffClient(id);
  return { id, cfg, exportDir: process.env[`${id.toUpperCase()}_EXPORT_DIR`] || cfg.exportDir, queuePath: cfg.queuePath };
}
```

- Add an endpoint listing clients for the switcher:

```js
app.get("/api/clients", (_req, res) => res.json(CLIENTS.map((id) => ({ id }))));
```

- In `/api/generate`, read `req.body.client`, resolve ctx, and spawn `batch-diff.mjs --client <id>` with generic env names (keep `TECHSPLAINS_*` as fallbacks for the techsplains path):

```js
const id = CLIENTS.includes(req.body?.client) ? req.body.client : "techsplains";
const ctx = await resolveDiffClient(id);
// …
const args = [path.join(__dirname, "batch-diff.mjs"), "--client", id, String(count)];
if (topic) args.push(...topic.split(/\s+/));
const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  env: { ...process.env, DIFF_DYK: String(dyk), DIFF_GENERAL: String(general), DIFF_EXPORT_DIR: process.env[`${id.toUpperCase()}_EXPORT_DIR`] || ctx.exportDir },
});
```

- In `/api/batches`, `/api/batches/:stamp`, `/api/video/...`, `/api/approve`, `/api/queue`, `/api/queue/*`: resolve `const { exportDir, queuePath } = await clientCtx(req);` and pass `queuePath` into `readQueue(queuePath)` / `setEntry(key, patch, queuePath)`, and `exportDir` into `listStamps(exportDir)` / `loadBatch(exportDir, ...)` / `safeExportPath(exportDir, ...)`. (These lib functions already take `exportDir`; the queue funcs now take the path from Step 3.)

- [ ] **Step 6: Add the client switcher to `scripts/techsplains-dashboard.html`**

- In `<header>`, before `<nav>`, add:

```html
<select id="client" style="margin-left:8px"></select>
```

- In the `<script>`, add a `CLIENT` global and populate the switcher, and append `?client=${CLIENT}` to every GET and include `client: CLIENT` in every POST body:

```js
let CLIENT = localStorage.getItem("diffClient") || "techsplains";
const q = (p) => p + (p.includes("?") ? "&" : "?") + "client=" + encodeURIComponent(CLIENT);
async function loadClients() {
  const sel = document.getElementById("client");
  const list = await fetch("/api/clients").then((r) => r.json());
  sel.innerHTML = list.map((c) => `<option value="${c.id}">${c.id}</option>`).join("");
  sel.value = CLIENT;
  sel.onchange = () => { CLIENT = sel.value; localStorage.setItem("diffClient", CLIENT); render(); };
}
```

Then update the fetch calls: `api("/api/batches")` → `api(q("/api/batches"))`, `/api/queue` → `q("/api/queue")`, the video `src` → `` `/api/video/${stamp}/${encodeURIComponent(v.file)}?client=${CLIENT}` ``, and the `/api/generate` body + `/api/approve` body + `/api/queue/*` bodies get `client: CLIENT`. Call `loadClients()` before the first `render()` at the bottom.

- The "Non-tech fun facts" input should hide for clients where general is disabled. Simplest: fetch `/api/clients` returning `{id, allowGeneral}` (add `allowGeneral: (await resolveDiffClient(id)).contentMix.allowGeneral` in the endpoint) and toggle the `#g-general` field's parent `hidden` on client change.

- [ ] **Step 7: Manual dashboard smoke (integration)**

Run: `TECHSPLAINS_DASHBOARD_PORT=4319 node scripts/techsplains-dashboard.mjs &` then `sleep 2 && curl -s localhost:4319/api/clients && curl -s "localhost:4319/api/batches?client=tranzzie" | head -c 200; kill %1`
Expected: `/api/clients` returns `[{"id":"techsplains",…},{"id":"tranzzie",…}]`; `/api/batches?client=tranzzie` returns `[]` (no Tranzzie batches yet) or a JSON array — no 500.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib/techsplains-queue.mjs scripts/techsplains-dashboard.mjs scripts/techsplains-dashboard.html scripts/__tests__/techsplains-queue.test.mjs
git commit -m "feat(video): dashboard client switcher + per-client queue path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: package.json scripts, version bump, full regression

**Files:**
- Modify: `package.json`
- Test: full suite + Techsplains-identity regression (already covered by `diff-config.test.mjs`)

- [ ] **Step 1: Add npm scripts + bump version**

In `package.json`, add to `scripts`:

```jsonc
"tranzzie:video": "node scripts/batch-diff.mjs --client tranzzie",
"tranzzie:poses": "node scripts/generate-presenter-poses.mjs --client tranzzie",
"diff:batch": "node scripts/batch-diff.mjs",
"test": "node --test scripts/__tests__/*.test.mjs"
```

Bump `"version"` from `0.44.0` to `0.45.0`.

- [ ] **Step 2: Run the whole test suite**

Run: `npm test`
Expected: PASS — all `scripts/__tests__/*.test.mjs` pass (diff-config, diff-prompt, render-diff-helpers, batch-diff, presenter-poses, techsplains-queue, and the pre-existing techsplains-*/course/image-sourcing suites). No failures.

- [ ] **Step 3: Confirm Techsplains is byte-identical at the config boundary**

The `diff-config.test.mjs` "legacy constants" test is the guard. Re-run it explicitly:

Run: `node --test scripts/__tests__/diff-config.test.mjs`
Expected: PASS — techsplains resolves to `#FFDD00` / `@techsplains` / `Orus` / 31 / 1.28 / `en` / project `techsplains` / mascot poses, proving no drift.

- [ ] **Step 4: Lint the render layer once more**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(video): npm scripts (tranzzie:video, tranzzie:poses), v0.45.0, test script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Post-implementation manual validation (needs live GCP creds + APIs)

These are not automated (they cost API calls); run once after the tasks land:

1. `npm run tranzzie:poses` — generate the 5 Jurie poses; eyeball for face consistency.
2. `PEXELS_API_KEY=… npm run tranzzie:video -- 2 "blue-light vs regular lenses"` — full 2-video batch; watch the pipeline log (Taglish script → real eyewear photos → director QC with banned-phrase guard → Leda TTS → TranzzieDiffCard render).
3. Open the exported `gallery.html` in `…/Tranzzie/05_Exports/Difference Videos/<stamp>/` — confirm Jurie presenter appears, gold/red/white captions, Taglish narration, `@tranzzie` watermark.
4. `npm run techsplains:batch -- 1 "codec vs container"` — confirm Techsplains still renders identically (mascot, yellow captions).
5. Dashboard: switch between Techsplains/Tranzzie, generate a batch per brand, confirm state stays isolated.

## Open items for the user (non-blocking, from the spec)

- Real Tranzzie Facebook **handle** + Taglish **outro CTA** → update `config/clients.json` `tranzzie.video.handle` + `.outro`.
- Confirm the Tranzzie video **export dir** (`…/Tranzzie/05_Exports/Difference Videos`).
- Final **narrator voice** pick (`Leda` vs `Kore`) → `tranzzie.video.tts.voice`.
