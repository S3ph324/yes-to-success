# Tranzzie Video Studio — Design

**Date:** 2026-07-10
**Status:** Approved, ready for implementation planning

## Purpose

Give **Tranzzie Eyeglasses** its own short-form "explainer video" factory, reusing
the Techsplains difference-video pipeline that already exists in this repo
(`generate-diff-*` → `render-diff-batch` → dashboard). Tranzzie posts vertical
9:16 Facebook videos about eyewear and eye care: what's the difference between
lens/frame types, how to pick frames for your face shape, and why it's worth
investing in your eyecare.

The generalization is **config-driven**: one shared set of pipeline scripts and
one dashboard drive either brand, with all brand-specific behavior resolved from
`config/clients.json`. **Techsplains behavior must stay byte-identical** — its
current hardcoded constants simply move into its own config block.

This is the natural next step of a multi-client shape the codebase already
started: `clients.json`'s `techsplains` entry already carries
`gcpProject`/`gcpAdc`/`ttsVoice`/`handle` fields that the `tranzzie` entry lacks,
and `lib/client.mjs` already exports an unused `takeClientArg()` (`--client`/`-c`
parser).

## Scope

**In scope**

- A `video` config block per client in `clients.json`.
- Generalizing `lib/techsplains.mjs` into a client-resolving config module.
- Threading `--client` through the six pipeline scripts + orchestrator.
- A new real-photo Remotion composition for Tranzzie, with a photoreal Jurie
  presenter (reusable pose set) in place of the doodle mascot.
- A new video-specific voice profile for Tranzzie (Taglish, narrated).
- A client switcher in the dashboard; per-client queue/ledger/export dirs.

**Out of scope (this build)**

- **Buffer autoposting for Tranzzie.** The plumbing is stubbed/parametrized but
  intentionally left inert — Tranzzie videos export to a folder for manual
  posting, consistent with `JURIE.md`'s "autoposting stays inert" rule. Wiring
  a Tranzzie Buffer channel is a later, explicit request.
- A brand-new "guide/tutorial" render format. Tranzzie's whole topic list is
  captured by the two existing variants (see §5), so no new phase plumbing.
- Any change to John Calub or Jurie poster pipelines.

## Decisions locked in

1. **Architecture:** new tab/mode in the existing Techsplains dashboard, not a
   standalone app. One `techsplains-dashboard.mjs` (renamed conceptually to the
   "video studio") serves both brands via a client switcher.
2. **Content:** eyewear/eye-care topics, reusing `brief_tranzzie`'s topic pool
   plus the face-shape / why-invest angles.
3. **Posting:** Buffer autoposting is the eventual target but **not wired now** —
   focus is the video-generation automation. Manual export handoff for now.
4. **Pipeline generalization:** config-driven shared pipeline (not per-client
   script forks).
5. **Language:** Taglish narration (matches Tranzzie's established poster voice).
   On-screen captions may stay mostly readable Taglish/English.
6. **Narrator:** warm female "ate optometrist" voice — Gemini-TTS female voice,
   distinct from Techsplains' brisk male `Orus`.
7. **Visual identity:** real-photo look reusing Tranzzie's poster palette
   (gold/red/white text over cinematic photo backgrounds), with a **photoreal
   Jurie presenter** in place of Techsplains' doodle mascot. Jurie is already
   Tranzzie's model (`char_tranzzie_enhanced` → Jurie's reference sheet), so the
   presenter is the same face as every Tranzzie poster.
7b. **Presenter production:** a **reusable pose set** — generate a small fixed
    set of photoreal Jurie poses ONCE from her reference sheet, save as static
    assets, and swap them per phase exactly like the Techsplains mascot (not
    regenerated per video). Jurie plays a **presenter figure** occupying a
    consistent zone, gesturing toward the comparison photos — the same role the
    doodle plays today, keeping the two-photo comparison layout intact.
8. **GCP credentials:** Tranzzie videos run on the **shared Jurie GCP project**
   (`adc-jurie.json`), the same credential Tranzzie posters already bill to —
   NOT a new isolated project like Techsplains has.
9. **Content variants:** reuse the existing `difference` + `didyouknow` variants
   rather than inventing a new "guide" format.
10. **Handle/CTA:** placeholders for now (`@tranzzie`, "Follow Tranzzie for
    more!") — the user fills in the real Facebook handle + Taglish CTA later.

## Current pipeline (what we're generalizing)

```
batch-techsplains.mjs  (orchestrator, spawns each step)
  1. generate-diff-scripts.mjs   → out/techsplains-scripts-<stamp>.json
                                    (Gemini scripts; reads voice profile + brief;
                                     appends to config/techsplains-topic-ledger.json)
  2. generate-diff-images.mjs    → public/generated-diff/<stamp>/  (stock video →
                                    Openverse → Pexels → AI; adds aImg/bImg/aVideo)
  3. generate-diff-director.mjs  → QC pass (fact-check + visual review + 1 re-source)
  4. generate-diff-audio.mjs     → Gemini-TTS single read + mlx_whisper timing;
                                    adds audio/durationSec/phases to the JSON
  5. render-diff-batch.mjs       → Remotion render (DifferenceCard / DidYouKnowCard)
                                    → <client exportDir>/<stamp>/ + gallery.html
                                      + captions.txt + manifest.json

techsplains-dashboard.mjs (:4318)  Generate / Review / Queue; spawns the batch;
                                   reads batches via lib/techsplains-batches.mjs;
                                   approval state in config/techsplains-queue.json
```

**Coupling points that are genuinely Techsplains-specific today:**

| Location | Coupling | Fix |
|---|---|---|
| `lib/techsplains.mjs` | `TS_GCP`/`TS_TTS`/`TS_HANDLE`/`TS_OUTRO`; `applyTechsplainsGcpEnv()` (isolated ADC) | Resolve from client config; pick GCP applier per client |
| all 5 scripts | scripts JSON name `techsplains-scripts-<stamp>.json`; regex `techsplains-scripts-(.+)\.json` in steps 2-5 | `<client>-scripts-<stamp>.json`; pass `--client` explicitly so no step guesses |
| step 1 prompt | hardcoded "Techsplains" brand, "Did you know", "Follow Techsplains for more!", 55/25/20 tech split, `general` category | Build prompt from config (brandName, outro, DYK phrasing, content mix, topic pools) |
| step 4 | `--language en` whisper; `Orus` male voice + brisk style | `whisperLang` + `tts` from config |
| step 5 | `id: DidYouKnowCard : DifferenceCard`; `accent: "#FFDD00"` | Select composition + accent by `template` |
| `lib/techsplains-queue.mjs` | `config/techsplains-queue.json` (hardcoded) | Per-client queue path from config |
| step 1 | `config/techsplains-topic-ledger.json` (hardcoded) | Per-client ledger path from config |
| dashboard | `resolveClient("techsplains")`, single export dir/queue | Client switcher; per-client dirs |
| render | `DifferenceCard`/`DidYouKnowCard` mascot + `TechsplainsWordmark` | New `TranzzieDiffCard` photo template |

**Already client-agnostic (no work needed):**

- `lib/techsplains-batches.mjs` — `listStamps`/`loadBatch`/`safeExportPath` already
  take `exportDir` as a parameter.
- `lib/image-sourcing.mjs` — brand-neutral (shared with the PDF course pipeline).
- `lib/client.mjs` — `resolveClient(id)` + `takeClientArg(argv)` already exist.

---

## Section 1 — Config model

Add a `video` block to **every** client entry in `config/clients.json`. Techsplains'
block is populated from its current constants so its behavior is unchanged;
Tranzzie's is new.

```jsonc
// techsplains (behavior-preserving — mirrors today's hardcoded values)
{
  "id": "techsplains",
  /* ...existing fields... */,
  "video": {
    "brandName": "Techsplains",
    "handle": "@techsplains",
    "template": "mascot",                     // DifferenceCard / DidYouKnowCard
    "presenter": {                            // the doodle mascot, as config
      "characterId": null,                    // no identity source — static doodle
      "poseDir": "characters/techsplains",
      "poses": {                              // phase kind → PNG (today's hardcoded map)
        "hook": "pose-point.png", "introA": "pose-point.png",
        "introB": "pose-point.png", "question": "pose-confused.png",
        "defA": "pose-think.png", "defB": "pose-point.png",
        "outro": "pose-base.png"
      }
    },
    "accent": "#FFDD00",
    "outro": "Follow Techsplains for more!",
    "dykOpener": "Did you know",
    "language": "en",
    "whisperLang": "en",
    "gcp": "techsplains",                     // isolated adc-techsplains.json
    "tts": {
      "model": "gemini-2.5-flash-tts",
      "voice": "Orus",
      "stylePrompt": "Read this narration in a natural, friendly, QUICK voice …",
      "targetSec": 31,
      "maxTempo": 1.28
    },
    "voiceProfile": "voice-profile-techsplains.md",
    "briefId": "brief_techsplains",
    "contentMix": { "dykDefault": 0.25, "generalDefault": 0.20, "allowGeneral": true },
    "ledger": "config/techsplains-topic-ledger.json",
    "queue": "config/techsplains-queue.json",
    "exportDir": "…/Techsplains/05_Exports/Difference Videos"
  }
}

// tranzzie (new)
{
  "id": "tranzzie",
  /* ...existing poster fields (voiceProfile, briefId, brandPresetId, characterId, exportDir)… */,
  "video": {
    "brandName": "Tranzzie",
    "handle": "@tranzzie",                    // PLACEHOLDER — user fills real handle
    "template": "photo",                      // new TranzzieDiffCard
    "presenter": {                            // photoreal Jurie, generated once
      "characterId": "char_tranzzie_enhanced", // identity source = Jurie's sheet
      "poseDir": "characters/tranzzie",       // generated Jurie pose PNGs land here
      "poses": {
        "hook": "jurie-point.png", "introA": "jurie-point.png",
        "introB": "jurie-present.png", "question": "jurie-think.png",
        "defA": "jurie-explain.png", "defB": "jurie-point.png",
        "outro": "jurie-base.png"
      }
    },
    "accent": "#F5C13B",                      // Tranzzie gold (from preset_tranzzie)
    "outro": "Follow Tranzzie for more!",     // PLACEHOLDER — Taglish CTA later
    "dykOpener": "Alam mo ba",                // Taglish "did you know"
    "language": "taglish",
    "whisperLang": "auto",                    // Taglish; captions use script text
    "gcp": "shared",                          // Jurie adc-jurie.json (same as Tranzzie posters)
    "tts": {
      "model": "gemini-2.5-flash-tts",
      "voice": "Leda",                        // warm female; final pick validated in build
      "stylePrompt": "Basahin ito na parang isang mabait, maalalahanin na ate optometrist … warm, caring, clear, unhurried, natural Taglish.",
      "targetSec": 34,                        // slightly slower than Techsplains
      "maxTempo": 1.22
    },
    "voiceProfile": "voice-profile-tranzzie-video.md",   // NEW file (see §3)
    "briefId": "brief_tranzzie",
    "contentMix": { "dykDefault": 0.34, "generalDefault": 0, "allowGeneral": false },
    "ledger": "config/tranzzie-video-ledger.json",
    "queue": "config/tranzzie-video-queue.json",
    "exportDir": "…/Tranzzie/05_Exports/Difference Videos"   // sibling of the poster export dir
  }
}
```

Notes:

- `gcp` is a keyword (`"techsplains"` | `"shared"`), not a path — the resolver
  (§2) maps it to the right ADC + env applier. `"shared"` → `lib/client.mjs`'s
  `applyGcpEnv()` (Jurie project). This keeps Tranzzie video billing on the same
  credential as Tranzzie posters, and keeps Techsplains fully isolated.
- `contentMix.allowGeneral: false` disables the non-tech "fun facts" category for
  Tranzzie — every video is on-brief (eyewear/eye care).
- Existing top-level `exportDir` on the client stays for posters; the video block
  gets its **own** `exportDir` so poster and video exports don't intermix.
- The Tranzzie `tts.voice` (`Leda` vs `Kore`) and exact style prompt are finalized
  during the build by generating one test read and listening; the config field is
  the single place to change it.

## Section 2 — `lib/diff-config.mjs` (generalize `lib/techsplains.mjs`)

New module `scripts/lib/diff-config.mjs` exporting:

```js
resolveDiffClient(id) → {
  id, brandName, handle, template, accent, outro, dykOpener,
  language, whisperLang,
  tts: { model, voice, stylePrompt, targetSec, maxTempo },
  presenter: { characterId, poseDir, poses },   // phase-kind → PNG map (mascot or Jurie)
  voiceProfilePath, brief, briefId,
  contentMix,
  ledgerPath, queuePath, exportDir,
  applyGcpEnv(),        // picks isolated vs shared based on `gcp`
  gcp: { project, location, imageLocation, adc },
  makeStamp, slugify,   // moved here (currently in techsplains.mjs)
}
```

- Reads `clients.json` via the same `PERSIST_BASE`-aware path logic as
  `resolveClient` (so Railway runtime edits are honored).
- `applyGcpEnv()`:
  - `gcp: "techsplains"` → sets `GOOGLE_APPLICATION_CREDENTIALS` to
    `adc-techsplains.json` + project `techsplains` (today's `applyTechsplainsGcpEnv`).
  - `gcp: "shared"` → delegates to `lib/client.mjs`'s `applyGcpEnv()` (Jurie
    project, `adc-jurie.json`), matching the Tranzzie poster pipeline.
- **`lib/techsplains.mjs` stays as a thin shim** re-exporting the techsplains-resolved
  values (`TS_GCP`, `TS_TTS`, `TS_HANDLE`, `TS_OUTRO`, `applyTechsplainsGcpEnv`,
  `makeStamp`, `slugify`) so any code not yet migrated keeps working. Delete it
  only once all five scripts import `diff-config` directly.

## Section 3 — Thread `--client` through the pipeline

**Filename contract.** Scripts JSON becomes `out/<client>-scripts-<stamp>.json`.
The stamp-parse regex in steps 2–5 generalizes to `(?:[a-z0-9]+)-scripts-(.+)\.json`,
BUT to avoid any ambiguity the orchestrator passes `--client <id>` to every step,
and each step resolves its config from the flag (falling back to parsing the
prefix only if the flag is absent, for backward-compat with a bare rerun).

**Per-script changes:**

- `generate-diff-scripts.mjs`
  - `const { client: id, rest } = takeClientArg(process.argv.slice(2))`; count/topic
    parsed from `rest`.
  - `resolveDiffClient(id)`; `applyGcpEnv()`.
  - Prompt built from config: `brandName`, `outro`, `dykOpener`, topic pools from
    `brief`, and `contentMix` (skip the GENERAL category entirely when
    `allowGeneral` is false). All literal "Techsplains" / "Did you know" /
    "Follow Techsplains" strings become interpolated config values.
  - Tranzzie voice profile drives tone (Taglish, warm, no medical claims — the
    profile itself carries the banned-phrase list).
  - Output → `out/<id>-scripts-<stamp>.json`; ledger → `config[video.ledger]`.
- `generate-diff-images.mjs` — mostly unchanged (image sourcing is brand-neutral).
  Only the stamp/dir derivation and the `--client` passthrough change. The
  category-context nuance (tech vs literal subject) keys off `category`, which for
  Tranzzie is always an eyewear category — treat non-"general" like today.
- `generate-diff-director.mjs` — `--client`; QC prompt's brand references
  parametrized (the "Follow <brand> for more" and outro checks). Fact-checking and
  visual review logic unchanged. **Add a Tranzzie guardrail:** the review must also
  reject/repair any medical-cure claim (reuse `brief_tranzzie.bannedPhrases`).
- `generate-diff-audio.mjs` — `--client`; TTS `model`/`voice`/`stylePrompt`/
  `targetSec`/`maxTempo` and whisper `--language` from config. Phase list logic
  unchanged (same phase kinds).
- `render-diff-batch.mjs` — `--client`; `resolveDiffClient(id)`; select composition
  by `template` (`mascot` → `DifferenceCard`/`DidYouKnowCard`; `photo` →
  `TranzzieDiffCard`/`TranzzieDidYouKnowCard`); `accent`/`handle` from config;
  export to the video block's `exportDir`. **Pass `presenter.poses` into
  `inputProps`** (resolved to `staticFile` paths under `presenter.poseDir`) so the
  composition swaps presenter frames per phase kind from config rather than a
  hardcoded map. Techsplains passes its doodle poses (byte-identical to today);
  Tranzzie passes the generated Jurie poses.
- `batch-techsplains.mjs` → rename to `batch-diff.mjs` (keep a
  `batch-techsplains.mjs` shim). Parse `--client`, forward it to every step, and
  find the newest `<id>-scripts-*.json`.

**New file `scripts/voice-profile-tranzzie-video.md`.** The existing
`voice-profile-tranzzie.md` is the **poster** HOOK→PAYOFF format — wrong shape for
narrated video scripts. The new profile mirrors the *structure* of
`voice-profile-techsplains.md` (hook, two-segment difference formula, DYK single-fact
formula, image sourcing rules) but in Tranzzie's voice:

- Warm Taglish "ate/tito optometrist," educational, never fear-mongering, **no
  medical cure claims** (carry the banned-phrase list).
- `difference` formula: "Ito ay <X>. / Ito ay <Y>. / Ano ang pagkakaiba?" then one
  mirrored Taglish sentence each. Keep intro sentence patterns fixed (renderer
  depends on them).
- `didyouknow` formula: hook literally opens with the configured `dykOpener`
  ("Alam mo ba…").
- Outro: engagement question + the configured CTA; invite an `EYECARE`-style
  one-word comment.
- Image sourcing: real eyewear/scene photos first (glasses types, someone trying
  frames, sun glare while driving, tired eyes at a laptop) — same searchQuery /
  imagePrompt contract as Techsplains.

**`npm` scripts** (package.json): add
`tranzzie:video` → `node scripts/batch-diff.mjs --client tranzzie`,
`tranzzie:poses` → `node scripts/generate-presenter-poses.mjs --client tranzzie`
(§3b), and keep `techsplains:batch` working (→ `batch-diff.mjs --client techsplains`).

## Section 3b — One-time Jurie pose-set generation

The Jurie presenter is **pre-generated once**, not per batch — the same
economics as the Techsplains doodle mascot (a handful of static PNGs reused
across every video). New standalone script
`scripts/generate-presenter-poses.mjs`:

- `--client tranzzie`; `resolveDiffClient` → `presenter.characterId`
  (`char_tranzzie_enhanced`) and `presenter.poses` (the set to produce).
- Loads Jurie's reference photos from `characters.json` and feeds them to Gemini
  2.5 Flash Image ("Nano Banana") as `inlineData` to **lock her identity** —
  exactly the mechanism `generate-backgrounds-jurie.mjs` already uses for posters
  (reuse that helper). Runs on the **shared Jurie GCP** creds.
- Generates each pose with a prompt describing the SAME Jurie (outfit, glasses,
  crop) in a distinct presenter attitude, on a **transparent / removable
  background** so she composites onto the dark card:
  - `jurie-point` — pointing/gesturing toward one side (intro/hook)
  - `jurie-present` — open-hand presenting gesture (introB)
  - `jurie-think` — hand-to-chin, curious (question)
  - `jurie-explain` — mid-explanation, calm (defA/defB)
  - `jurie-base` — friendly neutral (outro)
- **Consistency guardrail:** generate a candidate sheet, run the same Nano-Banana
  identity source across all poses in one call where possible (multi-pose sheet →
  slice), and **background-remove** (reuse the existing bg-removal path) so all
  five read as one person in one outfit. A quick visual QC (Gemini vision, like
  the director's visual pass) flags any pose whose face drifts; regenerate just
  that pose. Output → `public/characters/tranzzie/jurie-*.png`.
- Idempotent/seed-once: skip poses whose PNG already exists (like the character
  photo seeding), so it's cheap to re-run for a single missing pose.

This is a **setup step**, run once (and again only if Jurie's look changes),
producing the assets the render step references via `presenter.poses`.

## Section 4 — Render: `TranzzieDiffCard` (real-photo + Jurie presenter)

New composition(s) under `src/TranzzieDiffCard/`, registered in `src/Root.tsx`.
**Same props/schema contract as `DifferenceCard`** plus a `poses` prop
(phase-kind → `staticFile` path, from `presenter.poses`) so steps 1–4 are
untouched — only the visual layer differs.

- **Jurie presenter (photoreal), not a doodle.** The presenter figure occupies a
  consistent zone (bottom / lower-side of the frame, mirroring the Techsplains
  mascot slot), swapping pose per phase kind from the `poses` prop with the same
  pose-pop spring + idle bob the mascot uses. The two comparison photos stay the
  hero up top; Jurie gestures toward them.
- **Palette** (from `preset_tranzzie` + the Jurie/Tranzzie shared card):
  gold gradient hero words `#FFE27A → #F5C13B → #C7902A`, red jab `#E11522`,
  white body `#FFFFFF`, dark cinematic base `#0A0A0A` / `#080810`. Font: Montserrat
  (already bundled), matching the poster cards.
- **Layout:** dark full-bleed background; the two comparison photos framed
  large (rounded, subtle shadow) as in `DifferenceCard`, but on Tranzzie's dark
  canvas with a soft gold vignette rather than the bright Techsplains gradient.
  Word-pop captions in the gold/red/white treatment, driven by the same
  `chunkPhase`/word-timing helpers (import and reuse them from `DifferenceCard`).
  Jurie sits below the captions so text stays legible over the dark base.
- **`TranzzieDidYouKnowCard`:** the photo analog of `DidYouKnowCard` — full-bleed
  photo/clip under a dark overlay, a Taglish "ALAM MO BA?" stamp instead of "DID
  YOU KNOW?", big word-pop captions, Jurie presenter in the corner. Reuses the
  same schema + `poses` prop.
- **Watermark:** the configured `handle`, bottom-anchored, in Tranzzie styling
  (no Techsplains wordmark). A small Tranzzie logo (`brand/tranzzie-logo.png`)
  optionally top-center.
- `render-diff-batch` picks the composition from `template`; `accent` + `poses`
  come from config, so caption color and presenter frames are data, not code.

**Caption-case nuance:** Techsplains lowercases everything except acronyms
(`displayWord`). Taglish reads better in its authored case — `TranzzieDiffCard`
should render caption words as authored (skip the forced-lowercase), so the voice
profile controls emphasis/caps.

**Reusing the presenter concept for Techsplains:** `DifferenceCard`'s hardcoded
`POSE` map can optionally be swapped for the same `poses` prop (Techsplains passes
its doodle poses), unifying the two templates. To keep Techsplains byte-identical,
this is optional — `DifferenceCard` may keep its constant and only `TranzzieDiffCard`
reads `poses`. Either way the config carries both brands' pose maps.

## Section 5 — Content mapping (two existing variants, eyewear-fied)

All of Tranzzie's requested topics map onto the two variants with **zero new
render plumbing** beyond the photo template:

- **`difference`** — "X vs Y" eyewear comparisons:
  - single-vision vs progressive lenses
  - blue-light / anti-radiation vs regular lenses
  - photochromic vs separate sunglasses
  - acetate/plastic vs metal frames
  - full-rim vs rimless
- **`didyouknow`** — single-subject educational, framed as hook + fact + why
  (the DYK phase shape already supports this):
  - **how to pick frames for your face shape** ("Alam mo ba na ang hugis ng mukha
    mo ang pumipili ng tamang frame?")
  - **why invest in your eyecare / good eyeglasses** (value/longevity angle)
  - UV protection facts, screen-time / eye-strain facts, kids' eyewear facts

`brief_tranzzie`'s topic pool seeds the difference pairs; the face-shape and
why-invest angles are added to the brief (or the video voice profile) as
DYK-friendly prompts. `brief_tranzzie_photochromic` remains available as a
campaign-focused pool.

## Section 6 — Dashboard: client switcher

Generalize `techsplains-dashboard.mjs` / `.html` into a two-brand "video studio."

- **Header switcher:** a `<select>` (Techsplains / Tranzzie) beside the title.
  The chosen client id rides on every API call (`?client=<id>` or a header) and is
  persisted in `localStorage`.
- **Server:** `resolveDiffClient(client)` per request; `EXPORT_DIR`, queue path,
  and ledger come from that client's `video` block. `/api/generate` spawns
  `batch-diff.mjs --client <id>` with the right env (`<CLIENT>_DYK`, `_GENERAL`
  become generic env or CLI flags; Tranzzie hides the "Non-tech fun facts" input
  since `allowGeneral` is false).
- **State isolation:** each client has its own queue file (`video.queue`) and
  export dir, so approvals and batches never cross brands. `lib/techsplains-queue.mjs`
  takes the queue path as a parameter (or a small `queueFor(client)` wrapper).
- **Generate tab:** count / DYK count / topic. The "Non-tech fun facts" field is
  shown only when `contentMix.allowGeneral`. A Taglish/English note appears for
  Tranzzie.
- **Review / Queue tabs:** unchanged behavior, but scoped to the selected client.
- **Buffer:** `bufferConfigured()` stays false for Tranzzie (no
  `BUFFER_TRANZZIE_*` env set), so "Add to posting queue" degrades to the existing
  **manual "ready" handoff** — exactly the current unconfigured path. No new
  autoposting code runs. Wiring a Tranzzie Buffer channel later is a config +
  env-var change, not new logic.
- **Port:** keep `:4318` (single studio, brand chosen in-app).

## Credential & isolation safety

- Tranzzie video steps call the **shared** `applyGcpEnv()` (Jurie project) — the
  same credential the Tranzzie poster pipeline already uses. No new
  `adc-tranzzie.json`; no change to Techsplains' isolated project.
- Per-client GCP is selected by the `video.gcp` keyword, resolved in one place
  (`diff-config.applyGcpEnv`), so a shell with the wrong env vars can't silently
  bill the wrong project — the same guarantee `applyTechsplainsGcpEnv` gives today.
- Queue/ledger/export paths are per-client, so Tranzzie and Techsplains state
  never mix.
- Autoposting stays inert for Tranzzie (per `JURIE.md`).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Refactor regresses Techsplains | Techsplains config block reproduces today's exact constants; add a smoke test that generates + renders one Techsplains video and diffs the composition id/accent/handle. Keep `lib/techsplains.mjs` + `batch-techsplains.mjs` shims. |
| Taglish TTS voice reads wrong | `tts.voice`/`stylePrompt` are single-source config; validate with one test read before the first full batch. Whisper only supplies timing, so a mistimed word never shows the wrong caption. |
| Medical-cure claim slips into a script | Director QC gets a Tranzzie banned-phrase guardrail (reject/repair), on top of the voice profile's hard rule. |
| Filename/stamp regex ambiguity between clients | Orchestrator passes `--client` explicitly to every step; prefix-parse is only a fallback. |
| Real-photo template drifts from poster brand | Pull palette/font from `preset_tranzzie` + the shared Jurie card; review one render against a Tranzzie poster before batch. |
| Jurie face drifts between poses | Generate the pose set from the SAME reference sheet in one identity-locked pass, background-remove for one consistent outfit, Gemini-vision QC per pose, regenerate only drifters. Poses are seeded once and reused, so the check happens a single time, not per batch. |
| Presenter overlaps captions / photos | Jurie is pinned to a fixed lower zone below the caption band (same slotting discipline as the mascot); review one render before batch. |

## Deliverables

1. `config/clients.json` — `video` block (incl. `presenter.poses`) on `techsplains`
   + `tranzzie`.
2. `scripts/lib/diff-config.mjs` — new; `lib/techsplains.mjs` becomes a shim.
3. `scripts/generate-diff-scripts.mjs`, `-images.mjs`, `-director.mjs`,
   `-audio.mjs`, `render-diff-batch.mjs`, `batch-diff.mjs` — `--client` threaded,
   brand strings parametrized; render passes `presenter.poses`.
4. `scripts/generate-presenter-poses.mjs` — new one-time Jurie pose-set generator
   (Nano-Banana identity lock + bg-remove + vision QC), reusing the poster
   pipeline's character-ref helper.
5. `public/characters/tranzzie/jurie-*.png` — the generated Jurie presenter poses.
6. `scripts/voice-profile-tranzzie-video.md` — new narrated-video voice profile.
7. `src/TranzzieDiffCard/` (+ DYK photo variant) — new compositions in `Root.tsx`,
   reading a `poses` prop.
8. `scripts/lib/techsplains-queue.mjs` — accept per-client queue path.
9. `scripts/techsplains-dashboard.mjs` / `.html` — client switcher, per-client state.
10. `package.json` — `tranzzie:video` + `tranzzie:poses` scripts; keep
    `techsplains:*` working. Version bump.
11. Config: `config/tranzzie-video-ledger.json` + `config/tranzzie-video-queue.json`
    (created on first run; gitignore the queue like the Techsplains one).

## Open items for the user (non-blocking)

- Real Tranzzie Facebook **handle** + Taglish **outro CTA** (placeholders until then).
- Confirm the Tranzzie video **export dir** path (proposed sibling of the poster
  export dir under `…/Tranzzie/05_Exports/`).
- Final **narrator voice** pick (`Leda` vs `Kore`) — decided by ear during build.
