# Creator-style playbook (for Jurie's posts)

**PRIMARY reference = the studied Facebook page (Patrick Kyei "daily builder"
format) — see `research/content-styles/patrick-kyei-format.md` at the workspace
root.** That format/voice is the main basis: hook-led card, "most people" foil
(done empathetically, never shaming), repetition-then-turn, concrete numbers,
mantra payoff, dated-series footer. The frameworks below (Hormozi value-equation,
hook-retain-reward, Koe/Welsh structure) are SUPPORTING craft that's compatible.

Goal: write Jurie's advice cards + tweets using these **proven content patterns**
— **without ever quoting, naming, tagging, or mentioning anyone.** Only the
underlying craft is borrowed; every line ships as Jurie's own warm Taglish.

Researched June 2026 (Alex Hormozi primarily; plus Dan Koe, Justin Welsh):

## The frameworks we borrow

1. **Hook → Retain → Reward** (Hormozi). Hook stops the scroll; the body keeps
   them with real insight; the close rewards with a quotable reframe. "No such
   thing as too long, only too boring."
2. **The Value Equation** — `(Dream outcome × Perceived likelihood) ÷ (Time ×
   Effort)`. To make advice feel valuable: raise the outcome and the feeling of
   "kaya ko 'to," and **cut time + effort**. Don't ask "what can I add" — ask
   "anong friction ang tatanggalin." Speed/convenience is the biggest lever.
3. **Give real value.** Teach the actual how; specific and doable today. Small
   numbers and concrete actions beat adjectives. No hype, no guarantees.
4. **Hook formulas** (Hormozi): contrarian reframe ("it's not X, it's Y"),
   specific number ("3 things…"), sharp question, minimalist framing.
5. **Brevity** (Hormozi/Koe): short sentences, one idea per line, cut filler.
6. **PAS / hook→body→reward structure** (Koe/Welsh) for the longer caption.

## How it maps to Jurie

- **Advice card** — HERO is Jurie's own contrarian reframe/insight (the "it's
  not X, it's Y" pull-quote), biggest on the card, no attribution. Below it: a
  relatable hook + 3–5 concrete steps (the value, friction-removing, AI-for-SMB).
- **Tweet** — 100% Jurie's own post in a proven shape (contrarian reframe /
  list-in-a-tweet / question→answer / stop-X-do-Y). No quotes, no @mentions.
- Always empathetic, never shaming (the enemy is the hard way of working).

## Hard rules (enforced in the generator prompt)

- NEVER name, quote, tag, @-mention, or reference any outside person/brand/guru.
- No quotation-mark quotes of others, no "— Name" attributions.
- Keep Jurie's Taglish; read it back — if it sounds like a forced slogan, redo.

Implemented in `scripts/generate-advice-jurie.mjs` (CRAFT + per-format notes) and
rendered by `src/QuoteCard/AdviceCard.tsx` (hero = Jurie's own line) /
`TweetCard.tsx` (always posted by Jurie).

Sources (research):
- https://magicpost.in/blog/how-to-write-like-alex-hormozi
- https://itsmostly.com/blog/alex-hormozis-content-strategy-hook-retain-and-reward-explained
- https://davidschwertfeger.com/newsletter/alex-hormozis-value-equation-to-write-viral-hooks/
- https://thedankoe.com/letters/the-greatest-skill-of-the-21st-century/
- https://learn.justinwelsh.me/the-content-os
