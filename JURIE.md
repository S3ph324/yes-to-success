# Jurie — Quote Poster Generator

Topic → on-brand quote posters with **Jurie as the subject**, rendered to a
client export folder for **manual posting**. Runs on the same engine as the
John Calub pipeline but is a fully isolated client: its own GCP project, its
own brand preset, character, voice profile, brief, composition, and output.
**Nothing here modifies the John Calub setup.**

## What was added (Jurie-only)

| File | Purpose |
|---|---|
| `src/QuoteCard/JurieQuoteCard.tsx` | Her poster look: photo bg + HOOK→PAYOFF, white/gold/red + red-block word emphasis, `COMMENT "<KEYWORD>"` footer |
| `config/characters.json` → `char_jurie` | Jurie face refs (`public/characters/jurie/`) |
| `config/brand-presets.json` → `preset_jurie` | Her colors, no logo/url/signoff |
| `config/briefs.json` → `brief_jurie` | Topics + voice notes + banned phrases |
| `scripts/voice-profile-jurie.md` | Jurie's Taglish voice + structure rules |
| `scripts/generate-quotes-jurie.mjs` | Topic → structured quote entries (Gemini) |
| `scripts/generate-backgrounds-jurie.mjs` | Jurie scenes via her reference photos |
| `scripts/render-batch-jurie.mjs` | Render `JurieQuoteCard` → client export folder |
| `scripts/batch-jurie.mjs` | One-shot: topic → quotes → bg → posters |
| `npm run jurie:gen \| jurie:bg \| jurie:render \| jurie:batch` | the above |

Output: `/Users/macbookpro/Downloads/Work/02_Clients/Jurie/Exports/Quote Posters/<timestamp>/`
(posters + `gallery.html` + `captions.txt`). Override with `JURIE_EXPORT_DIR`.

## One-time Google Cloud setup (Jurie's own — separate from John Calub)

1. Sign in with a Google account that has **not** used the $300 trial.
2. **console.cloud.google.com** → activate the **$300 / 90-day free trial**
   (card required, not charged; use a card not used on a prior trial).
3. Create a project, e.g. `jurie-quote-posters` → note the **Project ID**.
4. Enable the **Vertex AI API** (and **Generative Language API**).
5. Credentials are **isolated from John Calub**. Jurie's credential lives at
   `~/.config/gcloud/adc-jurie.json`; the Jurie scripts auto-use it via
   `GOOGLE_APPLICATION_CREDENTIALS` and never read John Calub's machine-wide
   ADC. To refresh it later: back up `~/.config/gcloud/application_default_credentials.json`,
   run `gcloud auth application-default login` as Jurie's account, copy the
   new file to `adc-jurie.json`, then restore the backup.

No `.env` needed — `GOOGLE_CLOUD_PROJECT=jurie-quote-posters` and the
credential path are baked into the Jurie scripts as defaults (override by
exporting the env vars). Image model: `gemini-2.5-flash-image` (GA).

## Generate posters

```bash
export GOOGLE_CLOUD_PROJECT=your-jurie-project-id

# Topic → 8 posters about it (the topic feature):
npm run jurie:batch -- 8 "how AI can help business owners"

# Or rotate the brief topics instead of one topic:
npm run jurie:batch -- 8

# Step by step:
npm run jurie:gen -- 8 "how AI can help business owners"   # → out/jurie-quotes-*.json
npm run jurie:bg -- out/jurie-quotes-XXXX.json             # adds Jurie scenes
npm run jurie:render -- out/jurie-quotes-XXXX.json         # → export folder
```

When it finishes, `gallery.html` opens — review the posters and copy each
`caption` from `captions.txt` when you post to Jurie's Facebook page **by
hand**.

## Manual posting now — autoposting later (NOT wired)

Per the current scope, Jurie posts are **published manually**. Autoposting is
deliberately left **inert** (no Facebook calls, no scheduler) until the Meta
app work (handled on the John Calub project) is ready to be reused.

When you want to enable it later, the reference implementation already exists
for John Calub at `scripts/fb-poster.mjs` (Facebook Graph API). To add Jurie
autoposting at that point:

1. Create `config/posting.json` (gitignored — holds the FB token; never
   commit) with Jurie's Page ID + a long-lived Page access token.
2. Add a Jurie-scoped `scripts/fb-poster-jurie.mjs` modeled on
   `scripts/fb-poster.mjs`, pointed at the export folder + `captions.txt`.
3. Add a review/approve gate, then a scheduler (cron / Cloud Scheduler).

Until those steps are taken, **no poster is ever posted automatically.**

## Known polish item

The headline currently uses a heavy fallback font stack. To pixel-match the
sample posters' condensed grotesque, drop `Anton.woff2` (or Druk) into
`public/fonts/`, add a single `@font-face`, and pass `headlineFont:"Anton"`
(plumbed through `render-batch-jurie.mjs`). Structure/colors already match.
