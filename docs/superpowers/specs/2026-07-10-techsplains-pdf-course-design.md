# Techsplains PDF Course — Design

**Date:** 2026-07-10
**Status:** Approved, ready for implementation planning

## Purpose

Produce a sellable PDF course — "Editing Explained: The Techsplains Beginner-to-Creator Course" — packaged as a folder of files (main course + bonus PDFs), in two visual versions:

1. **Branded** — Techsplains logo, mascot doodle, brand colors, follow/CTA footers. Sold on the Techsplains Facebook page.
2. **Blank** — same content, neutral cover and color theme, no logo/mascot/CTAs. Sold on a second, unrelated Facebook page that the user runs as a backup personal sales channel (not a different audience or niche — purely so the same product doesn't look duplicated across the user's own pages).

Plus a single free lead-magnet PDF (Techsplains-branded only) used to warm up the Techsplains audience ahead of the paid offer.

This extends a promise already live on the Techsplains Facebook page bio: *"a full course is coming for anyone who wants to go deeper."*

## Audience & Scope

Two tiers within one course, back to back:

- **Tier 1 — Fundamentals**: total beginners who have never opened an editing app. Zero prior knowledge assumed, consistent with the existing Techsplains video voice ("a 12-year-old should get it on first listen").
- **Tier 2 — Creator Workflow**: people already making short-form content (Reels/TikTok/Shorts) who want to edit faster and look more professional.

Target size: **~35-40 pages, 8 modules** — enough to serve both tiers without feeling thin, finishable in one sitting, appropriate for a first course being market-tested.

## Content Architecture

Content is **hybrid**: a fresh skill-progression backbone, with existing Techsplains "what's the difference" video content folded in as sidebar content within relevant modules. This reuses a real content library (accuracy already vetted, voice already established) rather than starting from zero, while still reading as a coherent course rather than a compilation of trivia.

### Module outline

**Tier 1 — Fundamentals**
1. Welcome & How Editing Software Thinks — timelines, tracks, clips, the mental model before touching any tool (fresh)
2. The Cut — basic cuts, transitions, J-cuts/L-cuts (reuses "Cut vs Transition" / "J-cut vs L-cut" difference pairs)
3. Picture & File Basics — codec vs container, render vs export, bitrate vs resolution (reuses existing pairs)
4. Your Gear, Explained — mic types (dynamic vs condenser), storage (HDD vs SSD, cloud vs local), camera basics (crop sensor/focal length) (reuses existing pairs)

**Tier 2 — Creator Workflow**
5. Editing for Short-Form — pacing, jump cuts, hook-first structure for Reels/TikTok/Shorts (fresh)
6. Audio That Doesn't Suck — leveling, mic selection in practice, captions (fresh)
7. Speed & Efficiency — proxy vs original workflow, refresh rate/monitor setup (reuses existing pairs)
8. Publishing & Growth Basics — export settings per platform, file transfer (WiFi vs Bluetooth), next steps (fresh + reused pair)

Every module includes a **"Did You Know?" sidebar box**: a repackaged Techsplains difference-pair (hook + two definitions) relevant to that module's topic, sourced from the existing video manifest data rather than retyped from scratch.

## Freebies

**Free lead magnet** (Techsplains-branded only, given away pre-purchase to build interest):
- *"12 Editing Terms You're Probably Getting Wrong"* — a condensed cheat sheet pulled from the difference-pair catalog.

**Bonus PDFs bundled inside the paid purchase** (both Branded and Blank versions, same content):
- Quick-Reference Glossary — one-page printable index of every difference-pair term used across the 8 modules
- Pre-Export Checklist — one-page "check this before you hit export" list tying together Module 3/7 concepts
- Scroll-Stopping Hooks List — hook lines for short-form video
- Creator Tips — general tips PDF
- Finding Your Niche — guide PDF

The free lead magnet is Techsplains-only and is not duplicated for the second page, since that page is a backup sales channel for the same paid product, not a separate funnel.

## Folder & File Structure

```
Techsplains-Editing-Course/
├── Branded/                          (sold on the Techsplains page)
│   ├── 01-Main-Course.pdf            (logo, mascot doodle, brand colors, "Follow Techsplains" CTAs)
│   ├── 02-Glossary.pdf
│   ├── 03-Pre-Export-Checklist.pdf
│   ├── 04-Hooks-List.pdf
│   ├── 05-Creator-Tips.pdf
│   └── 06-Finding-Your-Niche.pdf
└── Blank/                            (sold on the second page)
    ├── 01-Main-Course.pdf            (neutral cover, no logo/mascot/CTAs, generic color theme)
    ├── 02-Glossary.pdf
    ├── 03-Pre-Export-Checklist.pdf
    ├── 04-Hooks-List.pdf
    ├── 05-Creator-Tips.pdf
    └── 06-Finding-Your-Niche.pdf

Free-Lead-Magnet/
└── 12-Editing-Terms-Cheat-Sheet.pdf  (Techsplains-branded only)
```

Content is identical word-for-word between Branded and Blank versions of every file — only the visual theme (logo, color palette, mascot doodle, CTA footers) toggles off for Blank.

## Production Pipeline

Follows the config-driven, one-source-many-outputs pattern already used by the content-studio `client:batch` pipeline.

- **Location:** `research/content-studio/course/` — new subdirectory alongside the existing Techsplains pipeline (`scripts/lib/techsplains*.mjs`), reusing `scripts/voice-profile-techsplains.md` for tone and the brand assets in `~/Downloads/Work/02_Clients/Techsplains/06_Branding/` (logo, cover art, colors).
- **Content source:** each module and bonus PDF is authored as a Markdown file with frontmatter (title, and sidebar difference-pairs referenced by topic ID). One set of Markdown files feeds both Branded and Blank outputs — content is never duplicated.
- **Difference-pair sidebars:** pulled programmatically from the existing `techsplains-manifest`/batch JSON files (under `~/Downloads/Work/02_Clients/Techsplains/05_Exports/Difference Videos/*/manifest.json`) by topic ID, so "Did You Know?" boxes are sourced from already-produced content, not retyped.
- **Rendering:** an HTML/CSS template with two stylesheet themes (`branded.css` / `blank.css`) renders each Markdown file to styled HTML; a headless print-to-PDF step produces the final PDF. One render script, run with a `--theme=branded|blank` flag, produces the full Branded/ and Blank/ folder sets from the same Markdown source.
- Exact PDF-rendering tool (e.g. Puppeteer/Playwright print-to-PDF vs. the PDF-authoring skill) is an implementation-time decision, not fixed here.

## Out of Scope

- Payment processing / checkout flow (Stan Store, Gumroad, manual DM delivery, etc.) — not addressed by this design; a business-operations decision separate from file production.
- Autoposting or scheduling the sales posts themselves — per existing project rules, any posting to a social platform requires explicit per-post user confirmation and is not automated by this pipeline.
- A second/future course — this design covers only the one course described above; multi-course tooling is not built preemptively.
