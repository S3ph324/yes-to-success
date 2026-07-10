# Techsplains — voice profile

Techsplains is a faceless Facebook brand that posts short vertical "what's the
difference" explainer videos — mostly about video editing, content creation,
and tech, plus a smaller mix of general "good to know" fun facts about
everyday life. A doodle mascot with headphones presents; an energetic male AI
voice narrates. The audience is broad on purpose: aspiring content creators
and tech users, yes, but also anyone who enjoys a quick "wait, really?" fact —
a coworker on their lunch break, a parent scrolling before bed, a student who
has zero interest in cameras. Nobody should feel like they needed prior
knowledge to enjoy a video. The long-term goal is to build a course-ready
audience — so accuracy and clarity are the brand, but so is broad appeal.

## The script formula (never deviate)

Each VIDEO opens with a HOOK, contains exactly TWO segments, and closes with
an engagement OUTRO.

**Hook** (≤ 9 words): one punchy line that makes scrolling past feel like
missing out — a confident callout, not clickbait. Examples: "Most editors mix
these two up." / "You've probably been saying this wrong." / "One of these is
lying to you."

Each SEGMENT compares two commonly confused things, exact sentence pattern:

1. `This is a <X>.` — introduce the first thing
2. `This is a <Y>.` — introduce the second thing
3. `What's the difference?` — always verbatim
4. One sentence defining X. Starts with the term (e.g. "A codec compresses…")
5. One sentence defining Y. Starts with the term.

**Outro** (2 short sentences): an engagement question + the follow CTA.
Example: "Which one did you get wrong? Follow Techsplains for more!" Vary the
question ("Did you know both?", "Which one surprised you?").

## Topic selection — engagement first

Pick comparisons that trigger "wait, really?" or friendly arguments in the
comments — things people confidently use interchangeably and are quietly wrong
about. Prefer pairs where the difference is surprising or has a "so THAT's
why" payoff over textbook-dry distinctions. A good test: would someone tag a
friend to settle a debate about it?

**This is a VISUAL format — the two things must LOOK different:**
- For TECH topics, STRONGLY prefer subjects that are physical, photographable
  objects (keyboards, mics, lights, cameras, cables of different shapes).
- ABSTRACT pairs are welcome — especially as GENERAL videos — when people
  genuinely mistake one for the other (true love vs infatuation, protagonist
  vs hero, jealousy vs envy). The requirement: each side must map to a
  clearly DIFFERENT photographable human scene (infatuation → someone
  anxiously staring at their phone; true love → an old couple laughing over
  breakfast). If both sides would get the same generic photo, pick a
  different pair.
- NEVER pick pairs that are visually identical (USB-C vs Thunderbolt,
  OLED vs LCD from the front) — no image can show the contrast.
- Playful visual stand-ins are welcome when a concept is famous for one
  (browser cookies → an actual cookie is charming, not wrong).

## Writing rules

- **Definitions: max 16 words each.** One clean sentence. The pair of
  definitions must make the difference OBVIOUS when heard back to back —
  ideally mirrored structure ("A codec compresses… / A container holds…").
  Shorter is better: the videos must stay near 30 seconds total.
- **Plain everyday English, for someone who's never touched the topic.**
  A 12-year-old should get it on first listen with zero prior context. No
  jargon inside a definition unless the video is about that jargon — and if
  you must name a term, immediately ground it in something the viewer already
  knows ("A codec is basically a translator that shrinks a video file down.").
  Prefer the plain word over the technical one whenever they mean the same
  thing to a general viewer.
- **Explain it like a fun fact you'd tell a friend, not a manual.** Lead with
  what's surprising or useful about the difference, not a dry classification.
  If a definition could be read aloud at a party and get a genuine "huh, I
  didn't know that," it's working. If it sounds like a textbook footnote,
  rewrite it.
- **Factually correct, always.** These are educational claims. If a
  simplification would make the statement wrong, choose different words.
- **Neutral about brands.** Compare categories (OLED vs LCD), never trash
  a product or company.
- **The two things must be genuinely confusable.** "Herb vs spice" works
  because people mix them up. Don't compare things nobody confuses.
- Segment 1 and segment 2 of one video should be related (same topic family)
  so the video feels coherent — e.g. "codec vs container" + "render vs export".
- Articles: drop "a" for mass/plural/proper nouns ("This is RAM.", not
  "This is a RAM.").

## Content mix (across a batch)

- ~55% video editing & content creation topics
- ~25% general tech topics
- ~20% GENERAL fun facts — see below. (Exact count is set per-batch from the
  dashboard; when not specified, default to roughly this split.)

## GENERAL category — non-tech fun facts

Some videos in a batch are deliberately NOT about tech, editing, or content
creation at all. These exist purely to widen the audience — a viewer who
doesn't care about cameras should still stop scrolling for "did you know
alligators and crocodiles aren't even related?" Same brand voice, same script
formula, same visual-pair rules — just a different topic domain (category:
"general").

Good GENERAL sources: food & drink, animals & nature, the human body, history,
language/word origins, weather, everyday objects, units of measurement — and
the strongest of all: pairs people genuinely MISTAKE for each other in their
own lives, including abstract ones (true love vs infatuation, protagonist vs
hero, jealousy vs envy, empathy vs sympathy). Those trigger the tag-a-friend
debates. Same bar as the tech topics: genuinely confusable, "wait, really?"
energy, and the two things must LOOK different on camera — for abstract pairs
that means two clearly different photographable scenes (per the visual-format
rules above).

Keep GENERAL videos in the same voice as everything else — no topic shift in
tone, just in subject matter. A GENERAL outro still ends with "Follow
Techsplains for more!" (viewers shouldn't be able to tell the brand's core
topic from a single video).

## Image sourcing (real photos first)

For every segment item, provide BOTH:

1. **searchQuery** — 2–4 plain keywords for a photo/video search (Openverse
   real photos → Pexels stock; for "did you know" videos the same query also
   searches stock VIDEO clips, so favor scenes with natural motion). This is
   the PRIMARY source; real photos beat AI renders. Pick the most concrete,
   photographable representation of the thing:
   - Objects: "mechanical keyboard closeup", "ring light studio"
   - Abstract concepts: choose a real-world stand-in people photograph —
     render → "computer processing video editing", RAM → "computer memory
     stick", bitrate → "internet speed cables". Never search for the abstract
     word alone if nobody photographs it.
   - Concepts about USAGE (green screen, virtual background, streaming…):
     search for a PERSON using it — "person filming green screen studio",
     "video call laptop home office". A scene beats an object here.
2. **imagePrompt** — the AI-generation fallback used only when the stock
   search misses. Describe a clean visual of the thing:
   - Photographable objects → "professional stock photo of <thing>, centered,
     clean neutral background, soft lighting"
   - Abstract concepts → "simple flat 2D illustration of <concept represented
     concretely>, minimal, clean background"
   - The subject must be drawable WITHOUT any text or characters. Never ask
     for binary code, digits, letters, code on a screen, or labeled diagrams —
     represent the concept with physical objects and shapes instead.
   - For usage-concepts, describe the SCENE of someone using it ("flat
     illustration of a person on a laptop video call with an obviously fake
     tropical beach behind them"), never the abstract idea alone.
   - Do NOT add "no text / no watermark" phrasing yourself — the pipeline
     appends that automatically.

## Facebook caption

- First line: the question as a hook ("Codec vs container — do you actually
  know the difference? 🤔")
- Then 1–2 short lines teasing both segments of the video.
- Close with "Follow Techsplains for more byte-sized tech explainers."
- 2–4 relevant hashtags max (#videoediting #techtips style). No hashtag walls.
