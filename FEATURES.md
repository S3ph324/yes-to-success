# Quote Poster Studio — Features & System Reference

> Living documentation of what the automation / web app does.
> Reflects **v0.30.1**. Update the version line when features change.

A **multi-client content factory** for social-media brands. You give it a topic;
it writes the copy in your brand voice, generates imagery with AI, renders
finished posters/cards, and drops them into a review queue for you to approve
and post manually. It runs as a password-protected **web dashboard on Railway**,
backed by a Remotion render engine and Google Vertex (Gemini) AI.

---

## 1. Clients (fully isolated)

Each client has its own voice profile, brand preset (colors/logo), character
face reference, GCP project + credential, and export folder. **Work on one
client never touches the other.**

| Client | Label | Voice | Brand preset |
|---|---|---|---|
| `jurie` | Jurie | `voice-profile-jurie.md` (Taglish mentor) | `preset_jurie` |
| `tranzzie` | Tranzzie Eyeglasses | `voice-profile-tranzzie.md` | `preset_tranzzie` |

---

## 2. Core pipeline (every batch)

```
Topic / idea
  → ① Gemini 2.5 Flash writes the copy (client voice)
  → ② Gemini 2.5 Flash Image generates the imagery (scene / product / character)
  → ③ Remotion renders the finished poster (per-frame React)
  → ④ Lands in the Review Queue (approve / decline)
  → ⑤ You post manually (autoposting is intentionally OFF)
```

---

## 3. Dashboard tabs

| Tab | Purpose |
|---|---|
| ⚡ **Generate** | Pick client, poster type, topic, count, aspect mix → run a batch |
| 📂 **Batches** | Browse past export batches |
| ✅ **Queue** | Review each poster, approve/decline, copy captions, download |
| 🎬 **B-Roll** | Idea / script / **video** → connected cutaway storyboard + first frames |
| 🎥 **Video** | Idea / script → **full narrative** storyboard + first frames |
| 💡 **Format Hacker** | Screenshot / URL / auto-discover a viral ad → **Format Blueprint** + 2 client-voiced storyboards → send to B-Roll/Video |
| 🎨 **Brand** | Brand presets (colors, logo, established tag) |
| 📝 **Topics** | Saved topic ideas |
| 👤 **Characters** | Manage AI face references per character |

Single login (`admin1`), persistent sessions across refresh/redeploy.

---

## 4. Content types (poster types)

### Jurie
| Type (`posterType`) | Composition | Description |
|---|---|---|
| `main` | `JurieQuoteCard` | Taglish hook→payoff over an AI scene (Jurie is the subject). ~20% render as a photo-less **flat** design (dark bg + gold stripe). |
| `advice` | `AdviceCard` | "Daily builder" dark text card: hook + numbered list + gold payoff. Header = "Jurie Cata Villarde". |
| `tweet` | `TweetCard` | Clean X/Twitter-screenshot style. |
| `photo` | `PhotoTweetCard` | White tweet card floating over a full Jurie photo (Coach-Russ style). |
| `mono` | `QuotePortraitCard` | Centered serif quote over a B&W Jurie portrait, gold-underlined keyword + signature (GaryVee style). |

### Tranzzie
| Type (`posterType`) | Composition | Description |
|---|---|---|
| `eyeglasses` | `ProductShowcaseCard` | AI product/model posters of a specific frame; cinematic, on-poster type, wardrobe + photorealism guards, text bottom-anchored with a blur scrim. |
| `shop` | `ShopListingCard` | Upload a frame photo → AI generates branded product scenes (hero, front-on-white, studio, detail, specs) as 1:1 e-commerce cards. |

### Both clients
- **B-Roll sets** and **Video storyboards** (staged wizards, see §6).

---

## 5. AI generation features

- **Copy** (Gemini 2.5 Flash) — quotes / advice / tweets / scripts in each
  client's voice; Taglish; brand-safe rules (Jurie: replicate creator frameworks
  in Jurie's own voice, **never quote/name real people**).
- **Imagery** (Gemini 2.5 Flash Image / "Nano Banana") — scene backgrounds,
  product scenes, and character reference portraits.
- **Character system** — each client has reference face photos; the **selected
  character always anchors identity** (per-batch extra refs only supplement, they
  do not override it). You can upload photos, type a description, or let the AI
  **invent** a consistent character. Output is forced **photorealistic** (no
  cartoon/illustration unless explicitly asked).
- **Aspect distribution** — set a % mix of 1:1 / 4:5 / 9:16 per batch;
  deterministic split (`lib/aspect-plan.mjs`).
- **Storyboard wizards** (B-Roll + Video) — staged: analyze → review storyboard
  → add/invent character → generate first frames + a paired Veo video prompt per
  scene. **B-Roll** = disconnected cutaways (`broll-director.md`); **Video** =
  one coherent narrative with a protagonist (`story-director.md`). Veo
  auto-animation is wired but **off** (you assemble the video yourself).
- **Format Hacker** (Gemini 2.5 Flash multimodal) — deconstructs a trending ad
  from a **screenshot** (inline vision — bypasses anti-bot walls), a **pasted
  URL** (Jina reader proxy, no headless browser), or an **auto-discovered**
  breakdown video (`yt-search` + `youtube-transcript`, with a Gemini-knowledge
  fallback when the scrape is blocked — e.g. on Railway's IP). Outputs a
  niche-agnostic **Format Blueprint** (visual strategy + copywriting formula +
  why it worked) and **2 storyboards** adapted to the selected client's voice
  (Jurie brand-safety: never names/quotes real people). The results show **what
  it analyzed** (uploaded screenshot / found-video thumbnail + YouTube link /
  pasted link) and **persist across tab switches** until you Clear or refresh.
  Each concept hands off into the existing B-Roll/Video storyboard flow
  (`hack-director.md`).

---

## 6. File map

### Pipeline scripts (`scripts/`)
| Script | Role |
|---|---|
| `batch-jurie.mjs` | Orchestrates a full client batch (`client:batch`) |
| `generate-quotes-jurie.mjs` | Copy gen (quote / advice / tweet) in client voice |
| `generate-backgrounds-jurie.mjs` | Scene / character background gen (Gemini image) |
| `render-batch-jurie.mjs` | Remotion render → export folder → queue |
| `generate-eyeglasses-tranzzie.mjs`, `batch-eyeglasses-tranzzie.mjs` | Eyeglasses showcase copy + orchestration |
| `render-shop-tranzzie.mjs`, `lib/shop-scenes.mjs` | TikTok Shop scene gen + card render |
| `broll-analyze.mjs` | Idea/script/video → storyboard JSON (`--mode broll\|story`) |
| `broll-character.mjs` | Generate ONE consistent character (upload/describe/invent) |
| `broll-frames.mjs` | First-frame image per scene (applies the character) |
| `broll-deliverable.mjs` | Build the review HTML + manifest |
| `lib/format-hacker.mjs` | Format Hacker: multimodal ad deconstruction → blueprint + 2 storyboards |
| `jurie-dashboard.mjs` | The web app (Express, ~5k lines, single inline SPA) |
| `lib/client.mjs` | GCP env + client resolution | 
| `lib/aspect-plan.mjs` | Deterministic aspect-ratio distribution |

### Director prompts (`scripts/`)
- `broll-director.md` — cutaway b-roll director.
- `story-director.md` — narrative-scene (full video) director.
- `hack-director.md` — Format Hacker Master Creative Director.

### Compositions (`src/QuoteCard/`)
`JurieQuoteCard`, `ProductShowcaseCard`, `ShopListingCard`, `AdviceCard`,
`TweetCard`, `PhotoTweetCard`, `QuotePortraitCard`.
(Legacy John Calub: `QuoteCard`, `ImageQuoteCard`, `BoldQuoteCard`. Scaffold:
`AppIcon`, `HelloWorld`, `OnlyLogo`.)

### Config data (`config/`)
| File | Holds |
|---|---|
| `clients.json` | Client definitions (voice/brand/character/export) |
| `brand-presets.json` | Colors, logo, established tag per brand |
| `briefs.json` | Content briefs |
| `characters.json` | AI character face references (photo paths) |
| `eyeglasses.json` | Tranzzie frames + reference photos |
| `posting.json` | FB Page id + token — **gitignored, never commit** |
| `batches/` | Saved batch configs |

---

## 7. Infrastructure & operations

- **Hosting:** Railway, `studio` branch auto-deploys. Live version shows as
  `v0.29.x` in the dashboard header.
- **Deploy:** bump `package.json` version + touch the `Dockerfile.studio`
  redeploy-trigger comment + commit + push `origin HEAD` (studio branch).
- **Auth:** single login (`admin1`); stateless signed-cookie sessions that
  survive refresh/redeploy.
- **GCP isolation:** Jurie and Tranzzie use separate Google Cloud projects /
  credentials (`lib/client.mjs` → `applyGcpEnv`).
- **Persistence:** config + character photos + analyzed storyboards live on the
  Railway volume; generation resolves character photos from the volume **and**
  falls back to the committed repo image, so committed photos work without a
  volume upload.

---

## 8. Reliability & safety guards

- **Never ships blank posters** — a photo poster with a failed background is
  skipped (text-only `advice`/`tweet` and intentional `useFlatBg` flat posters
  are exempt and render normally).
- **429 rate-limit resilience** — the TikTok Shop pipeline salvages a partial
  run (reuses a generated scene for a card that hit the limit) instead of
  failing the whole batch; exponential backoff + scene spacing reduce 429s.
- **Stale-lock self-heal** — a job lock whose process already exited is reaped
  automatically (`jobActuallyRunning`), so "a job is already running" never
  sticks; manual **Unlock** + a 12-min auto-kill remain for hung jobs.
- **Restart-safe staged flow** — analyzed B-Roll/Video sets are restored from
  the volume if a redeploy wiped the ephemeral working copy.
- **Brand-safety in image gen** — eyeglasses model shots force fully-clothed,
  finished-campaign looks; product scenes strip competitor lens stickers/logos.

---

## 9. Known limitations

- **Shared image quota per client** — heavy back-to-back batches hit Vertex
  **429** rate-limits; the pipeline salvages/retries rather than hard-failing.
- **One character reference at a time** — a two-person dialogue keeps the *lead*
  consistent; a second person renders generic.
- **Jobs run one-at-a-time** (shared quota, single log channel); the lock
  self-heals so it won't get stuck.
- **Autoposting is inert** — everything is exported for **manual** posting.
