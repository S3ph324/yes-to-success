# How the Quote Poster Studio Works

A simple, detailed walkthrough of the whole thing — what it is, how it runs,
and how you use it day to day. No deep tech knowledge needed.

---

## 1. What this is (in one paragraph)

You type a **topic**. The system writes short Tagalog/English **quote
posters** about it — with a real photo of your model, bold text, your brand
colors, and a "Comment …" call to action — then drops the finished images in
that client's folder so you can **post them by hand** on Facebook. It runs
**two separate clients today: Jurie and Tranzzie Eyeglasses**, and it is
completely separate from the older John Calub setup.

---

## 2. The big picture (what happens when you hit "Generate")

```
You pick: client + topic + how many + brand kit + character
        │
        ▼
1. WRITE QUOTES   → Google Gemini writes the hooks/payoffs in the client's
                     voice (short, punchy, correct Taglish)
        │
        ▼
2. MAKE PHOTOS    → Google "Nano Banana" image model creates a scene photo
                     for each quote, with your chosen person in it
        │
        ▼
3. BUILD POSTERS  → The text, colors, red highlight, gold word, logo and
                     "Comment" footer are drawn on top of each photo
        │
        ▼
4. SAVE           → Finished PNGs + captions land in the client's export
                     folder, and show up in the dashboard "Batches" tab
        │
        ▼
You review, download, and post them manually. Nothing auto-posts.
```

Each step is a small script; the dashboard just runs them for you and shows a
**progress bar**.

---

## 3. The two clients (and how they stay separate)

| | **Jurie** | **Tranzzie Eyeglasses** |
|---|---|---|
| Topic | AI / business / money | Eyewear, eye care, **photochromic lenses** |
| Voice | Empathetic AI mentor | Warm optical clinic |
| Model (character) | Jurie | **Jurie** (you set it to the same person) |
| Brand colors | Gold + red | Amber gold + red |
| Logo on poster | none | Tranzzie eyeglasses logo |
| Footer | `COMMENT "MENTOR"` | `COMMENT "EYECARE"` |
| Posters saved to | `…/Jurie/Exports/Quote Posters/` | `…/Tranzzie/05_Exports/Quote Posters/` |

**How separation works:** every brand kit, topic preset and character is
"tagged" with a client name. The studio only ever shows and touches the
selected client's tagged items. The old **John Calub** files have no client
tag, so they never appear here and are never modified. Google Cloud is also
isolated — see section 7.

---

## 4. The dashboard (your control panel)

Start it:

```
cd research/content-studio
npm run jurie:dashboard
```

Open **http://localhost:4317**. Keep that terminal window open while you use
it. (If the page says "can't be reached", just run the command again.)

At the top: a **Client** dropdown (Jurie / Tranzzie). Everything below
follows the client you pick. The tabs:

- **Generate** — the main tab. Pick a topic (or a topic preset), how many
  posters, a brand kit, and a character (with a live photo **preview**), then
  click **Generate posters**. A **progress bar** shows quotes → photos →
  posters → done.
- **Brand Kits** — see each kit with its **logo preview** and colors;
  create or update a kit (name, gold/red colors, CTA words, upload a logo).
- **Topics** — see and create "topic presets" (a saved set of topics +
  voice notes), e.g. the **photochromic lenses** preset for Tranzzie.
- **Characters** — see the people available; create a character and upload
  reference photos. (Tranzzie's preset character is Jurie.)
- **Batches** — every past run, with thumbnails, the caption under each
  poster, a **↓ PNG download** button per poster, and "Open export folder".

---

## 5. How a poster is built (the look)

Every poster has the same structure, matching your reference designs:

- **HOOK** (top): a relatable problem, ends with "…"
- **PAYOFF** (bottom): the answer/benefit
- **Footer**: `COMMENT "WORD" / TO / LEARN MORE`
- Optional **logo** at the top (Tranzzie has one; Jurie doesn't)
- Background: the AI scene photo, darkened top and bottom so text is readable

**Color & size hierarchy (deliberate, not random):**

- **Gold word = the hero** — the single benefit/solution word in the payoff.
  It is the **biggest** text.
- **White = the body** — the normal words. Medium size.
- **Red bar = the hook's punch** — exactly **one** highlighted problem word,
  always in the hook. The red box is the **same size as the line's text** (a
  highlight, not a giant box).
- Small connector words (sa, ng, ang, na…) are never colored.
- Text auto-shrinks so long words like "PHOTOCHROMIC" never get cut off.

The font is **Montserrat** (heavy), bundled in `public/fonts/`.

---

## 6. The settings files (what holds what)

All in `research/content-studio/config/`. Plain JSON you can also edit by hand,
but the dashboard does it for you.

- **clients.json** — the master list: each client's voice profile, default
  topic preset, default brand kit, default character, and export folder.
- **brand-presets.json** — brand kits (colors, logo, CTA words).
- **briefs.json** — topic presets (lists of topics + voice notes + banned
  phrases).
- **characters.json** — people and their reference photo paths.
- **scripts/voice-profile-jurie.md** / **voice-profile-tranzzie.md** — the
  "personality and rules" the AI follows when writing (tone, grammar rules,
  the one-red-bar / one-gold rule, etc.).

---

## 7. The Google Cloud part (and why John Calub is safe)

The AI that writes the quotes and makes the photos is **Google Gemini /
"Nano Banana"**, billed to a Google Cloud project on the **$300 free trial**.

- It uses **its own isolated credential** at
  `~/.config/gcloud/adc-jurie.json` (account: villardejurie, project:
  `jurie-quote-posters`). The scripts pick this up automatically — you don't
  set anything.
- John Calub's machine-wide Google login was **backed up and restored
  byte-for-byte**, so his pipeline still works exactly as before. The two
  never touch each other.
- Models used: `gemini-2.5-flash` (writing) and `gemini-2.5-flash-image`
  (photos). Cost is small and well within the trial.

---

## 8. Day-to-day: making a batch

1. Start the dashboard (`npm run jurie:dashboard`) and open it.
2. Pick the **Client** (Jurie or Tranzzie).
3. On **Generate**: type a topic — or choose a **Topic preset** (e.g.
   "Tranzzie — Photochromic Lenses") which fills the topic for you.
4. Set the **count** (e.g. 8), confirm the **Brand kit** and **Character**
   (preview shows who'll be in the posters).
5. Click **Generate posters**. Watch the progress bar (≈ a minute or two for
   ~8: writing, then one photo each, then rendering).
6. Go to **Batches** → newest at the top. Review the images and captions.
7. **↓ PNG** to download a poster, or "Open export folder" to get them all.
8. Post them on the client's Facebook page **yourself**, using the caption
   from under each poster (or `captions.txt` in the folder).

Command-line equivalent (optional):

```
npm run jurie:batch -- 8 "how AI can help business owners"
npm run tranzzie:batch -- 8 "photochromic lenses for drivers"
```

---

## 9. Where the finished files go

```
Jurie    → /Users/macbookpro/Downloads/Work/02_Clients/Jurie/Exports/Quote Posters/<timestamp>/
Tranzzie → /Users/macbookpro/Downloads/Work/02_Clients/Tranzzie/05_Exports/Quote Posters/<timestamp>/
```

Each timestamp folder has: the poster PNGs, `captions.txt`, and a
`gallery.html` you can open to eyeball the whole set.

---

## 10. Posting status

**Manual only, on purpose.** Nothing is ever posted automatically. The
dashboard shows an "Auto-post to Facebook — coming soon" box that is
intentionally disabled. The working auto-post code exists only for John
Calub (`scripts/fb-poster.mjs`) and is not wired to Jurie or Tranzzie until
you ask for it.

---

## 11. Quick fixes

- **Dashboard won't load** → terminal closed. Re-run
  `cd research/content-studio && npm run jurie:dashboard`.
- **A poster came out with no photo** → the image model hiccuped; it
  auto-retries 3×. Just regenerate that batch if one slips through.
- **Wrong person / want a different model** → Characters tab: upload new
  reference photos or point the client to another character.
- **Change wording style** → edit the client's `voice-profile-*.md`.
- **Is John Calub affected?** No — different files, different Google
  credential, verified untouched.

---

## 12. Command cheat sheet

| Command | What it does |
|---|---|
| `npm run jurie:dashboard` | Start the studio at :4317 |
| `npm run jurie:batch -- 8 "topic"` | Make 8 Jurie posters about a topic |
| `npm run tranzzie:batch -- 8 "topic"` | Make 8 Tranzzie posters |
| `npm run client:batch -- --client jurie 8 "topic"` | Generic form |

That's the whole system. Pick a client, type a topic, generate, review,
download, post.
