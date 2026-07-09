# Techsplains Control Dashboard — Design

**Date:** 2026-07-09
**Status:** Approved (pending spec review)
**Scope:** A single local web dashboard for the Techsplains brand: click-to-generate a
batch of videos, review + approve/reject each, and queue approved videos for automatic
posting to Facebook via Buffer.

---

## 1. Goals

- One local page where the user can, without touching the terminal:
  1. **Generate** a batch (choose count, optional topic, how many "did you know" videos), watch the pipeline run live.
  2. **Review** each rendered video inline (playable), with its caption editable.
  3. **Approve / reject** each video.
  4. Send approved videos to a **posting queue** that schedules them to Buffer automatically.
- Run entirely on the user's Mac (local GCP credentials already live here).
- Stay **fully isolated** from the other two dashboards and other clients (per the `JURIE.md`
  isolation rule): a new file, its own port, its own state file. It must not import from or
  modify `server.mjs`, `jurie-dashboard.mjs`, or any Jurie/Tranzzie/Calub config.

## 2. Non-goals

- No cloud deploy (local only for now).
- No changes to the video-generation pipeline logic (scripts/images/audio/render), beyond a
  single additive `manifest.json` emit for clean data hand-off (see §5).
- No multi-user auth (single local operator).
- Not a general multi-client tool — Techsplains only.

## 3. Architecture

A new self-contained Express server: **`scripts/techsplains-dashboard.mjs`**, served at
**`http://localhost:4318`** (env `TECHSPLAINS_DASHBOARD_PORT`, default 4318). Single file,
server-rendered HTML + inline JS (same self-contained style as `jurie-dashboard.mjs`; **no**
separate build step). Reuses `scripts/lib/techsplains.mjs` for GCP env and `scripts/lib/client.mjs`
for client resolution.

```
Browser (localhost:4318)
   │  fetch /api/*
   ▼
techsplains-dashboard.mjs  (Express)
   ├─ POST /api/generate     → spawn batch-techsplains.mjs, stream logs (chunked)
   ├─ GET  /api/batches      → list export stamps + per-video status
   ├─ GET  /api/video/:stamp/:file → stream MP4 off disk (Range-aware)
   ├─ POST /api/approve      → set video status in techsplains-queue.json
   ├─ GET  /api/queue        → approved/queued videos + schedule
   ├─ POST /api/queue/send   → upload approved videos to Buffer + schedule
   └─ static: the inline HTML app
```

Data source of truth on disk:
- **Rendered videos**: `<exportDir>/<stamp>/techsplains-NN-<slug>.mp4` (already produced today).
  `exportDir` = `~/Downloads/Work/02_Clients/Techsplains/05_Exports/Difference Videos`.
- **Per-video metadata**: `<exportDir>/<stamp>/manifest.json` (new — see §5).
- **Approval / queue state**: `config/techsplains-queue.json` (new — see §6).

## 4. Screens

### 4.1 Generate
Form: **Count** (number), **Topic** (optional text — blank = ledger-driven variety),
**# Did-you-know** (number, default = count/4). One **Generate** button.

On submit → `POST /api/generate` spawns `batch-techsplains.mjs` with env
(`TECHSPLAINS_DYK`, topic as argv) and streams stdout/stderr back over a chunked response;
the page appends lines live with the same colour cues the pipeline prints. On completion the
UI auto-navigates to Review for the new stamp.

### 4.2 Review
Grid of the newest batch's videos, each: inline `<video controls>` (9:16), title, an editable
caption `<textarea>` (prefilled from manifest), and **Approve** / **Reject** buttons. Status
badge per card (pending / approved / rejected). Editing a caption + Approve persists the edited
caption into the queue state so the posted caption reflects any tweak. A batch picker lets the
user revisit older stamps.

### 4.3 Queue
Lists all **approved** videos across batches with a proposed schedule (§7). Controls:
- **Cadence**: posts-per-day + time-of-day + start date (defaults: 1/day, 09:00, tomorrow).
- Per-row: scheduled datetime (editable), remove-from-queue.
- **Send to Buffer** button → schedules everything not yet sent. Rows flip pending→scheduled,
  store the returned Buffer post id, and show a link. If Buffer video upload is unavailable
  (§8 fallback), the button instead reveals the export folder path + copy-caption buttons and
  marks rows "ready for manual queueing."

## 5. Pipeline hand-off (`manifest.json`)

`render-diff-batch.mjs` currently writes `gallery.html` + `captions.txt` (human-readable).
Parsing captions.txt back is brittle. **Additive change**: also write
`<exportDir>/<stamp>/manifest.json`:

```json
[
  { "file": "techsplains-01-codec-vs-container.mp4",
    "title": "Codec vs Container",
    "caption": "Codec vs container — ...",
    "variant": "difference",
    "durationSec": 40.2 }
]
```

This is backward-compatible (nothing else reads it) and is the dashboard's clean data source.
For batches rendered before this change, the dashboard falls back to parsing `captions.txt`
(the `#N — Title` + caption + `----` delimiter format) so old stamps still show.

## 6. State file — `config/techsplains-queue.json`

Single JSON object keyed by `"<stamp>/<file>"`:

```json
{
  "2026-07-09T10-00/techsplains-01-codec-vs-container.mp4": {
    "status": "approved",           // pending | approved | rejected | ready | scheduled | posted
    "caption": "edited caption...",  // overrides manifest caption if present
    "scheduledAt": "2026-07-10T09:00:00Z",
    "bufferPostId": "…",
    "bufferUrl": "…"
  }
}
```

Absent key = pending. Writes are whole-file rewrites guarded by a simple in-process mutex
(single local operator — no concurrency to speak of). This file is local-only state (it holds
scheduling/Buffer ids, not shareable config), so the build **adds `config/techsplains-queue.json`
to `.gitignore`** — unlike `clients.json`/`briefs.json`, it must never be committed.

## 7. Scheduling model

Client-side compute, server-side persist. Given cadence (N/day, time-of-day, start date), the
queue assigns each approved-but-unscheduled video the next open slot: fill `start@time`, then
`start+1day@time`, …, N per day. The user can hand-edit any row's datetime before sending.
`Send to Buffer` passes the per-row `scheduledAt` as Buffer's `dueAt`.

## 8. Buffer integration (approach A, with fallback)

**First implementation task — verify the API shape**, because the existing `buffer-poster.mjs`
only ever posts *image URLs* and there is no video path anywhere yet.

Plan A (target): upload the MP4 directly to Buffer, get a media handle, create a scheduled post
with it. Concretely, probe Buffer's current GraphQL/REST for a video-upload path (media upload
mutation / signed-upload URL / multipart), mirroring the June-2026 schema `buffer-poster.mjs`
already uses. Add `BUFFER_TECHSPLAINS_CHANNEL` (env) alongside the existing `BUFFER_API_KEY`.

Fallback C (if Buffer has no usable local video-upload path): the **same UI** degrades to a
semi-auto handoff — the queue exposes the export folder + copy-caption buttons and marks rows
"ready for manual queueing" in Buffer's composer. No UI rebuild either way; only the `send`
handler's behaviour differs. The `status` model already covers both (`scheduled` vs a new
`ready` display state).

**Verification gate:** a throwaway probe script (`scripts/_buffer-video-probe.mjs`, not shipped)
that attempts a single upload of one existing rendered MP4 to a Buffer draft, run once, decides
A vs C before the queue `send` handler is finalized.

## 9. Isolation & safety

- New file only; **zero edits** to `server.mjs` / `jurie-dashboard.mjs` / other clients' config.
- Only reads/writes: `config/techsplains-queue.json`, the Techsplains export dir, and (one
  additive line) `render-diff-batch.mjs`'s manifest emit.
- Buffer channel id is Techsplains-specific (`BUFFER_TECHSPLAINS_CHANNEL`); never reuse the
  Jurie/Tranzzie channel constants.
- Autoposting only fires on explicit **Send to Buffer** click — never on generate or approve.
- Video serving endpoint validates the requested path stays inside the export dir (no `..`
  traversal), matching the `validateFilePath` discipline used elsewhere.

## 10. Testing / verification

- `preview_*` against `localhost:4318`: generate a tiny batch (count 1), confirm the log
  streams, the video plays inline, approve flips status in the state file.
- Manifest emit: run one real render, assert `manifest.json` exists and parses.
- Buffer probe: run `_buffer-video-probe.mjs` once; record A-or-C outcome in the plan.
- Path-traversal: `GET /api/video/2026.../..%2f..%2fetc%2fpasswd` returns 400.

## 11. Version bump

Per the standing rule, bump `content-studio/package.json` version on every change and surface a
`v{version}` tag in the dashboard header so the user can confirm which build is loaded.

## 12. Open risks

1. **Buffer video upload may not exist** in a local-friendly form → mitigated by the A/C fallback;
   probe resolves it before build completes.
2. **Buffer fetching a public URL** is impossible locally — that's *why* A targets direct upload,
   not the URL path Jurie uses.
3. Long generation runs hold the streamed HTTP response open; the page must tolerate a dropped
   connection (resume by polling `/api/batches` for the new stamp).
