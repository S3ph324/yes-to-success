# TikTok Shop Cards — Virtual Photography Studio (Tranzzie)

> Deep-dive companion to `FEATURES.md` §4. Reflects **v0.33.0**.
> Code: `scripts/render-shop-tranzzie.mjs` · `scripts/lib/shop-scenes.mjs` ·
> `src/QuoteCard/ShopListingCard.tsx` · `src/QuoteCard/FeatureInfographicCard.tsx`

Turns casual phone photos of eyeglasses frames into a **professionally-shot
product listing** — you pick the shot types and quantities, manage multiple
colorways, and never show your raw photos.

## The big idea

Casual snapshots can't be a listing, but AI also must not *invent* a product —
the frame in the listing must be the exact frame being sold. So:

- Uploaded photos are a **reference only**. Gemini "re-shoots" the *same exact
  frame* in commercial scenes, carrying a **professional eyewear photographer
  persona** (camera bodies, macro lenses, lighting modifiers) on every prompt.
- Remotion **deterministically composites** the Tranzzie branding on top.
  Technical graphics (grids, rings, leader lines) are drawn in React/SVG —
  never by the AI.

## The Studio Builder (dashboard → Tranzzie → "TikTok Shop")

**Frame varieties (colorways).** A dynamic list — each variety has a tag/name
("Champagne", "Matte Black") and its own photo dropzone (1–6 photos; HEIC
auto-converted). Max 8 varieties. Photos are reference-only, never posted.

**Shot menu (quantity per type, 0–6 each):**

| Shot | What the AI produces | Card |
|---|---|---|
| **Hero Product** | Dramatic dark lighting — variations cycle: charcoal three-quarter, floating levitation, warm marble pedestal, spotlight-on-acrylic | `hero` |
| **Simple Product** | Front-on, pure-white catalog main image (background force-replaced) | `front` |
| **Model Shoot** | Photorealistic model wearing the exact frame (85mm portrait; default rotates stylish Filipino/Filipina looks; optional "model look" text override) | `model` |
| **Extreme Close-up** | Macro variations: hinge, nose pads, temple arm, lens edge | `detail` |
| **Feature / Infographic** | Clean angled lens shot with negative space → programmatic overlays | `FeatureInfographicCard` |
| **Group Shot** | ≥2 varieties composed together, each colorway matching its labelled references; identical frame shape, only colour differs | `group` |
| **Specs Card** | No AI — the dark gold "Lens Features" text card | `specs` |

**Render identical sets** toggle: ON = every variety gets the full shot menu
(quantities × varieties); OFF = quantities are batch totals with varieties
assigned **round-robin** (mixed colorways in one set). Group shots are always
global. A live counter shows the math; **max 12 AI shots per batch** (enforced
in the UI and the route — keeps worst case inside the 12-minute job window).

## The POST payload

Multipart to `/api/generate` (`posterType:"shop"`): each variety row's files
under `variantPhotos_0…7`, plus a `shopPlan` JSON field
(`{varieties:[{name,field}], shots:{…}, identicalSets, modelNote}`). The route
validates (before the cost guard), HEIC-converts, and passes the resolved plan
via `DASHBOARD_SHOP_PLAN`. **No `shopPlan` → the legacy fixed 5-card path runs
unchanged.**

## Prompt safety stack (`lib/shop-scenes.mjs`)

- `PHOTOGRAPHER_PERSONA` — prepended to every scene.
- `PRODUCT_LOCK` — reproduce the EXACT pair (shape/colour/material/hinges);
  strip display stickers/labels (temporary packaging); no text/watermarks.
- `NO_PEOPLE` — on every type EXCEPT model shoots.
- Model shoots carry `WARDROBE_RULE` (fully clothed, modest neckline,
  family-friendly — mandatory) + `FINISHED_LOOK_RULE` (published campaign
  image, never a mid-shoot candid).
- **Group shots** send interleaved labelled parts —
  `VARIETY 1 — "Champagne": [imgs] VARIETY 2 — …` — so the model binds each
  colorway to its photos (2 photos/variety, ≤4 varieties per call).

## Rate-limit resilience (unchanged philosophy, dynamic arrays)

1. Per-shot **3 attempts with exponential backoff** (4s, 8s) + 2.5s spacing.
2. A **second pass** retries only the failed shots after a 6s cool-down.
3. **Salvage borrowing** for shots that still failed: same type + same variety
   → same type → same variety → anything (feature cards borrow only from
   feature/closeup — they need clean negative space). Raw uploads are NEVER
   used; zero-generated → loud abort.

## FeatureInfographicCard (programmatic, Essilor-style)

Takes the clean AI lens shot and draws in SVG/React: glowing concentric dotted
rings + a tech-grid patch at a configurable focus point, **leader lines** to
spec callouts (driven by the spec checkboxes), a brand-safe claim line, logo.
No AI text, ever.

## Output

`<export dir>/<timestamp>/` — cards named
`tranzzie-NN-<product>_<variety>_<type>.png` (group/specs cards drop the
variety), `captions.txt` (brand-safe; lists colorways when >1), `gallery.html`.
Review Queue → manual posting, as everywhere. Generated scenes are deleted
after render (baked into the cards).

## Ops notes

- Each AI shot = 1 image-model call on the shared Tranzzie Vertex quota; the
  12-shot cap + spacing keep 429s manageable, and salvage recovers stragglers.
- Cards land on the Railway export volume; batches are never auto-deleted —
  grow the volume or delete old batches via the Batches tab.
