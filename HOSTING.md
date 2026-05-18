# Hosting the Quote Poster Studio (public, Railway)

This hosts `scripts/jurie-dashboard.mjs` (multi-client studio + script-based
B-Roll) as a public website. It is **separate** from the John Calub
`server.mjs` deploy — different Dockerfile, different Railway service.

> ⚠️ **Public + no login.** Every "Generate" spends *your* Google Cloud.
> Built-in caps protect you: `STUDIO_DAILY_CAP` (default 40 runs/day),
> `STUDIO_IP_PER_HOUR` (default 4), and a kill switch `STUDIO_KILL=1` that
> instantly disables all generation (UI still loads). Also set a GCP budget
> alert. Video B-roll is disabled in the hosted build (script only).

## 1. Service account key (one time)

The hosted box can't use your personal `adc-jurie.json` — it needs a
service-account key.

1. Console → **IAM & Admin → Service Accounts** (project `jurie-quote-posters`)
   → **Create service account** → name `studio-host` → role **Vertex AI User**
   (a.k.a. "Agent Platform User") → **Done**.
2. That project's org policy blocks key creation (we hit this before). Flip it:
   **IAM & Admin → Organization Policies** → search **Service Account Key
   Creation** (`iam.disableServiceAccountKeyCreation`) → **Manage policy** →
   set **Not enforced** at the project → **Save**.
3. Back to the `studio-host` account → **Keys → Add key → Create new key →
   JSON** → download. This file = billed Vertex access; it only ever lives as
   a Railway secret. Never commit it.

## 2. Push the repo to GitHub

Railway deploys from a Git repo. From `research/remotion-app`:
```
git add -A && git commit -m "studio hosting" && git push
```
(If it isn't a GitHub repo yet: create one, add it as `origin`, push.)

## 3. Railway service

1. **railway.app → New Project → Deploy from GitHub repo** → pick this repo.
2. Service **Settings → Build**: Builder = **Dockerfile**, **Dockerfile Path =
   `Dockerfile.studio`**. Healthcheck Path = `/healthz`.
3. Service **Variables**:
   | Key | Value |
   |---|---|
   | `GCP_SA_KEY` | *(paste the full JSON contents of the key file)* |
   | `GOOGLE_CLOUD_PROJECT` | `jurie-quote-posters` |
   | `GOOGLE_CLOUD_LOCATION` | `us-central1` |
   | `HOSTED` | `1` |
   | `EXPORT_BASE` | `/app/exports` |
   | `STUDIO_DAILY_CAP` | `40` *(tune)* |
   | `STUDIO_IP_PER_HOUR` | `4` *(tune)* |
   *(Optional later: `STUDIO_KILL=1` to freeze generation instantly.)*
4. **Volume**: add a volume mounted at **`/app/exports`** (1–5 GB) so batches
   survive restarts/redeploys.
5. **Deploy.** First build installs Chromium + downloads Remotion's browser
   (slow once). Watch logs until `/healthz` is green.
6. **Settings → Networking → Generate Domain** (or add a custom domain via
   CNAME). That URL is your public studio.

## 4. Day-to-day

- Anyone with the URL can generate (within the caps). Share it accordingly.
- Outputs live in the app — review/download from **Batches** / **B-Roll**
  (no auto-write to your Mac; hosted box has no access to it).
- Push to GitHub → Railway auto-redeploys.
- Abuse / runaway spend → set `STUDIO_KILL=1` and redeploy (instant stop),
  then lower the caps.
- Watch **GCP → Billing → Budgets & alerts** — set an alert.

## Local is unchanged

`npm run jurie:dashboard` with no env still runs locally on :4317, writes to
your Mac client folders, and keeps video B-roll enabled. Hosting only changes
behavior when `HOSTED=1` / `EXPORT_BASE` are set (they are, in the container).
