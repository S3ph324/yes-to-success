# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo actually is

Remotion is only the **render layer**. Wrapped around it is a multi-tenant content factory:

1. **Gemini text** writes Tagalog/English quote posters in a client's voice
2. **Gemini Image (a.k.a. "Nano Banana")** generates a scene photo per quote (with the client's character, if any, as the subject)
3. **Remotion** composites the text + brand + photo into the final PNG
4. The batch lands in the **client's export folder** (per-machine on Mac, or `/app/exports/<client>/` on Railway) for manual posting

There is also a **B-Roll maker** that does the same trick for video editors: a script or a video file in → 25 paired Nano Banana (first frame) + Veo 3.1 (animation) prompts out, ready to drop into a timeline.

Both pipelines are driven by a self-contained Express dashboard (`scripts/jurie-dashboard.mjs`, ~1300 lines, no separate frontend build) that doubles as the Railway-hosted public service.

## Two branches, two deploys — don't cross them

| Branch | Ships | Dockerfile | Live URL(s) |
|---|---|---|---|
| `main` | `scripts/server.mjs` (John Calub) + `dashboard/` SPA | `Dockerfile` | `yes-to-success-production.up.railway.app` (Railway backend) **and** `yes-to-success.vercel.app` (Vercel-hosted SPA; `dashboard/vercel.json` rewrites `/api/*`, `/uploads/*`, `/generated-bg/*`, `/healthz` back to Railway). Push to `main` redeploys **both** services automatically. |
| `studio` | `scripts/jurie-dashboard.mjs` (inline-HTML multi-client studio) | `Dockerfile.studio` | `jurie-automation-production-5045.up.railway.app` (one Railway service, no separate frontend — the inline HTML is the whole UI) |

**Rule:** changes for the multi-client studio go on `studio`. Never merge `studio` → `main`. Never modify John Calub scripts when on `studio`. They literally have parallel filenames so you can tell them apart: `generate-quotes.mjs` (Calub) vs `generate-quotes-jurie.mjs` (multi-client), same for `generate-backgrounds*`, `render-batch*`, `batch*`.

## Production state — Meta App Review in progress (submitted 2026-05-19)

The John Calub Content Bot Meta app is currently **in App Review** (~10‑day SLA from submission; often faster). Until the decision lands, **do not break** any of these or the review auto-fails:

- `yes-to-success.vercel.app` + the Railway backend must stay reachable.
- Reviewer test login: user `admin`, pass `calub123` (set via `DASHBOARD_PASSWORD`). The reviewer follows the steps in `docs/app-review-submission.md` and the screencast at `~/Desktop/JohnCalub-AppReview-Screencast.mp4`.
- Privacy policy at <https://s3ph324.github.io/yes-to-success/privacy.html> must stay live (GitHub Pages from `docs/privacy.html` in this repo).
- App stays in **Development mode** — do NOT flip to Live until approved. While in Development, posts created via `pages_manage_posts` are only visible to people with an app role.
- Decision and any "more info" requests email `jackinternetyt324@gmail.com`.
- The submission cannot be edited or cancelled while in review.

After approval: flip the app to Live (then `pages_manage_posts` becomes Advanced Access and posts go publicly visible).

## The three client tiers

| Tier | Identified by | Gemini creds | Pipeline scripts |
|---|---|---|---|
| **John Calub** (original) | No `client` field in config | machine-wide `~/.config/gcloud/application_default_credentials.json` + `GOOGLE_API_KEY` for text | `generate-quotes.mjs`, `generate-backgrounds.mjs`, `render-batch.mjs`, `batch.mjs` |
| **Jurie / Tranzzie / future** | `client: "<id>"` field on every config entry | isolated `~/.config/gcloud/adc-jurie.json` (set via `GOOGLE_APPLICATION_CREDENTIALS`), separate GCP project | the `-jurie.mjs` suffixed scripts |
| **B-Roll** | Standalone (not client-scoped) | Same Jurie ADC | `broll-batch.mjs` → `broll-analyze.mjs` → `broll-frames.mjs` → `broll-deliverable.mjs` |

Each multi-client entry in `config/clients.json` points at its `voiceProfile`, `briefId`, `brandPresetId`, `characterId`, and `exportDir`, which are resolved against the sibling JSON files. The dashboard's CRUD endpoints edit those files in place.

## The pipeline in one diagram

```
topic → generate-quotes*.mjs  →  out/<...>-quotes-<stamp>.json
      → generate-backgrounds*.mjs  (adds bgPath per entry — skips entries with useFlatBg)
      → render-batch*.mjs  (programmatic Remotion render, NOT the CLI)
      → <client export dir>/<stamp>/  (posters + gallery.html + captions.txt)
      → manual posting
```

The `render-batch` scripts map a quote's `variant` to a Composition id:
- `classic` → `QuoteCard`
- `image` → `ImageQuoteCard`
- `bold` → `BoldQuoteCard`
- (multi-client) → `JurieQuoteCard` (always, regardless of variant)

Per-quote random flags decide variety in a batch: `useCta` (~50% drop the comment footer), `useFlatBg` (~20% skip background gen for a gradient look), `kind=hook|tip`.

## Common commands

```bash
# Render layer (Remotion preview / typecheck)
npm run dev                          # Remotion studio at :3000 — live composition preview
npm run lint                         # eslint src && tsc
npx remotion render <id> out/x.mp4 --props='{...}'

# Multi-client pipeline (Jurie / Tranzzie / …)
npm run client:batch -- --client jurie 8 "AI for solopreneurs"   # one-shot
npm run jurie:batch -- 8 "topic"        # alias
npm run tranzzie:batch -- 8 "topic"     # alias
npm run jurie:gen | jurie:bg | jurie:render   # step-by-step

# Dashboard (the actual product surface)
npm run jurie:dashboard              # :4317 — multi-client studio + B-Roll
npm run server                       # :PORT — John Calub server (main branch)

# B-Roll directly (skip the dashboard)
node scripts/broll-batch.mjs --aspect 9:16 --count 25 \
  --character char_jurie --video /path/to/clip.mp4
# (or --script /path/to/transcript.txt)

# John Calub pipeline (only when on main branch)
npm run quotes:batch -- 20 png
```

## The dashboard (`scripts/jurie-dashboard.mjs`)

Single file. Self-contained. No build step. Serves an inline HTML page + REST/SSE endpoints over the `config/` files + a child-process batch runner.

Things worth knowing before editing:
- **It returns the inline HTML from a template literal `PAGE`.** All CSS and JS lives inside that string. CSS rules cascade in order, so polish passes go at the bottom (see `/* — UI overhaul v0.16 — */` comment).
- **Batches spawn child processes** (`scripts/batch-jurie.mjs`, `scripts/broll-batch.mjs`). The HTTP endpoint returns `{ok:true}` immediately; the child streams stdout/stderr to a shared `log()` function which fans out to a single `/api/log` SSE stream the frontend subscribes to.
- **Only one batch can run at a time** — `if (job?.running) return 409`. Surfacing two batches concurrently would require splitting jobs by client.
- **Cost guardrails on every generate**: `STUDIO_DAILY_CAP` (40 batches/day, global), `STUDIO_IP_PER_HOUR` (4 batches/hr per visitor), `STUDIO_KILL=1` (returns 503 immediately). They count *batches*, not posters — a 200-poster batch is one tick.
- **`HOSTED=1` mode** flips output paths to `EXPORT_BASE` (the Railway volume at `/app/exports`). Locally, output goes to each client's `exportDir` on the Mac.
- **`req.body.useLogo === "1"` is the dashboard "Include logo" checkbox** — gets passed as `DASHBOARD_NO_LOGO=1` env to the child when *unchecked* (inverted).
- **Per-batch poster cap is 200** (server clamp + UI `max`). Don't lower it without checking — user advertises "100–200 posters per click".
- **Multer file-size cap on B-Roll video upload is 100 MB.** Railway's edge proxy reliably accepts up to ~120 MB but silently drops bigger requests — keep 100 MB conservative.

## B-Roll pipeline (`broll-*.mjs`)

`broll-batch.mjs` orchestrates four steps:

1. **Analyze** (`broll-analyze.mjs`) — Source can be a `--script` text file or a `--video` file. Video mode has **two paths**:
   - Default: **Gemini direct.** Send the video as inline base64 (≤19 MB) or via Files API (>19 MB, needs Vertex staging bucket). Gemini watches frames + hears audio in one call. No ffmpeg, no whisper.
   - Legacy: `BROLL_USE_WHISPERX=1 + WHISPERX_BIN=...` — Mac-only, runs ffmpeg + whisperx large-v3 to a transcript, then analyzes that.
2. **Render first frames** (`broll-frames.mjs`) — Sequential per shot, ~30s each via `gemini-2.5-flash-image`. Loads character refs from `config/characters.json` for shots with `usesCharacter: true`.
3. **Veo animation** (`broll-veo.mjs`) — **Gated OFF** unless `BROLL_VEO=1`. Cost protection.
4. **HTML deliverable** (`broll-deliverable.mjs`) — Gallery HTML + manifest.json copied to the delivery folder.

Output lands at `brolls/generated/<stamp>/` locally or `EXPORT_BASE/broll/<stamp>/` hosted.

**Vertex video gotcha:** the Files API on Vertex AI mode of `@google/genai` needs a Cloud Storage staging bucket. Our setup doesn't have one configured, so videos >19 MB *might* fail the Files API path. For big local videos, compress with `ffmpeg -vf scale=-2:360 -crf 36 -c:a aac -b:a 32k -ar 16000 -ac 1` to land under the inline cap (a 1.2 GB / 13-min 1080p clip → 6.3 MB without losing audio fidelity).

## Remotion composition conventions

- `src/index.ts` calls `registerRoot(RemotionRoot)`. `src/Root.tsx` declares one `<Composition>` per template with `id`, `durationInFrames`, `fps`, dimensions, Zod `schema`, and `defaultProps`. The `id` is what `npx remotion render` and the programmatic `selectComposition()` calls take.
- Most posters are 1080×1350 @ 30 fps. `calculateMetadata` reads `aspectRatio` from props and rewrites dimensions before render.
- Animation is frame-derived (`useCurrentFrame`, `interpolate`, `spring`, `<Sequence>`). No real-time clocks.
- Tailwind v4 is enabled via `remotion.config.ts` (`Config.overrideWebpackConfig(enableTailwind)`).
- New template = new `<Composition>` in `Root.tsx` + a component module under `src/` with its Zod schema co-located. Follow `QuoteCard/JurieQuoteCard.tsx`, not `HelloWorld/`.

## Deploy

- `git push origin studio` → Railway rebuilds from `Dockerfile.studio` (`jurie-dashboard.mjs`). The Dockerfile materializes `GCP_SA_KEY` (Railway secret) into `/app/gcp-sa.json` at startup and points `GOOGLE_APPLICATION_CREDENTIALS` at it.
- `git push origin main` → Railway rebuilds the John Calub backend (`server.mjs`) **and** Vercel rebuilds the dashboard SPA. On the John Calub Railway service, the same SA-JSON-as-env pattern is used but via `GOOGLE_APPLICATION_CREDENTIALS_JSON` (the shim at the top of `server.mjs` writes it to `/tmp/gcp-sa-key.json` and sets `GOOGLE_APPLICATION_CREDENTIALS` for the SDK).

**Bump `package.json` version on every deployable change — both branches.** The version chip in the dashboard sidebar (`v0.X.Y`) is the user's only signal that a deploy actually went through — they hard-refresh (Cmd+Shift+R) after a push and watch for the number to tick. Same rule on `main` (John Calub server) as on `studio` (Jurie). Semver: feature → minor, fix → patch. Tell the user the new version number after the bump so they know what to look for.

## Things to NEVER do

- **Don't autopost.** `scripts/fb-poster.mjs` exists for John Calub. Client (Jurie/Tranzzie) posters are exported for manual posting. Do not wire client autoposting without an explicit request — see `JURIE.md`.
- **Don't commit `config/posting.json`, `gcp-sa.json`, `service-account*.json`, `.gcloud/`.** Already in `.gitignore`; don't bypass.
- **Don't touch John Calub scripts on `studio`.** Their parallel `*-jurie.mjs` variants exist exactly so the original stays untouched.
- **Don't drop the per-batch poster cap below 200** without checking — the user advertises 100–200 posters per click.
- **Don't commit or push unless explicitly asked.** Standing rule.

## Where the deep docs live

- `JURIE.md` — multi-client isolation boundary, Jurie's GCP setup, the "manual posting / autoposting stays inert" rule
- `HOSTING.md` — Railway service-account key flow, env vars, volume mount, cost guardrails
- `HOW-IT-WORKS.md` — the non-technical operator walkthrough
- `dashboard/README.md` — the legacy Vite/React SPA in `dashboard/` (separate from the inline-HTML `jurie-dashboard.mjs` — don't confuse them)
- `docs/` — older design notes
