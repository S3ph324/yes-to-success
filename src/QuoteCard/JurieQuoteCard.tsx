import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  Img,
  staticFile,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import {
  AspectRatio,
  aspectRatioSchema,
  aspectToDimensions,
} from "./aspect";

// ─────────────────────────────────────────────────────────────────────────
// Jurie quote poster — bold photo + Taglish hook→payoff, white/gold/red word
// emphasis with red highlight blocks, and a COMMENT "<KEYWORD>" CTA footer.
// Matches the client's existing Photoshop poster style. Background image is a
// cinematic scene featuring Jurie (generated separately via the character
// reference). John Calub compositions are NOT touched by this file.
//
// Headline font: Anton is the closest free match for the sample posters.
// Drop `Anton.woff2` into public/fonts/ and add an @font-face, OR pass a
// `headlineFont` prop. Falls back to a heavy condensed system stack.
// ─────────────────────────────────────────────────────────────────────────

const tokenSchema = z.object({
  t: z.string(),
  s: z.enum(["w", "g", "r", "rb"]).default("w"),
});
const linesSchema = z.array(z.array(tokenSchema)).default([]);

export const jurieQuoteCardSchema = z.object({
  // Preferred: structured, per-word styled lines.
  topLines: linesSchema, // the HOOK
  bottomLines: linesSchema, // the PAYOFF
  // Fallback when structured lines are absent.
  quote: z.string().default(""),
  keyword: z.string().default(""),
  // Footer call-to-action. useCta=false hides the lockup (quote-only).
  ctaComment: z.string().default("MENTOR"),
  ctaTail: z.string().default("LEARN HOW"),
  useCta: z.boolean().default(true),
  // Visuals.
  bgSrc: z.string().default(""),
  aspectRatio: aspectRatioSchema,
  brandGold: z.string().default("#F5C13B"),
  brandGoldLight: z.string().default("#FFE27A"),
  brandGoldDeep: z.string().default("#C7902A"),
  brandRed: z.string().default("#E11522"),
  logoSrc: z.string().default(""),
  headlineFont: z.string().default(""),
});

export type JurieQuoteCardProps = z.infer<typeof jurieQuoteCardSchema>;

export const calcMetaJurieQuoteCard = ({
  props,
}: {
  props: JurieQuoteCardProps;
}) => {
  const { width, height } = aspectToDimensions(
    props.aspectRatio as AspectRatio,
  );
  return { width, height, fps: 30, durationInFrames: 90 };
};

const resolveSrc = (src: string) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try {
    return staticFile(src);
  } catch {
    return null;
  }
};

type Tok = { t: string; s: "w" | "g" | "r" | "rb" };

// Build hook/payoff lines from a plain quote + keyword when the generator
// didn't supply structured tokens — keeps the card usable for quick tests.
const fallbackLines = (
  quote: string,
  keyword: string,
): { top: Tok[][]; bottom: Tok[][] } => {
  const q = (quote || "").trim();
  if (!q) return { top: [], bottom: [] };
  let hook = q;
  let payoff = "";
  const m = q.match(/(.*?(?:…|\.\.\.))\s*(.*)/s);
  if (m && m[2]) {
    hook = m[1];
    payoff = m[2];
  } else {
    const dot = q.indexOf(". ");
    if (dot !== -1) {
      hook = q.slice(0, dot + 1);
      payoff = q.slice(dot + 2);
    } else {
      const words = q.split(/\s+/);
      const half = Math.ceil(words.length / 2);
      hook = words.slice(0, half).join(" ");
      payoff = words.slice(half).join(" ");
    }
  }
  const kw = keyword.trim().toLowerCase();
  const toToks = (s: string, allowBlock: boolean): Tok[] =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => {
        const bare = w.replace(/[.,!?;:"'…]/g, "").toLowerCase();
        if (kw && bare === kw)
          return { t: w, s: allowBlock ? "rb" : "g" } as Tok;
        return { t: w, s: "w" } as Tok;
      });
  return {
    top: hook ? [toToks(hook, true)] : [],
    bottom: payoff ? [toToks(payoff, false)] : [],
  };
};

// Size hierarchy: GOLD is the hero (largest). White / red / red-block are
// all the SAME size as each other — a red block is a highlight behind a
// word, never bigger than the text. Connectors read clearly, just below
// the hero, so the hierarchy is obvious like the reference posters.
// Per-line size hierarchy (matches the reference posters): a line that
// contains the hero token ("rb" or "g") renders at the HERO size; lines
// with only connective text render smaller. All tokens within a line share
// the same size — so the rhythm comes from line-to-line size contrast, not
// token-to-token, exactly like the references.
const lineSize = (line: Tok[]): number =>
  line.some((t) => t.s === "rb" || t.s === "g") ? 1.0 : 0.6;

// Montserrat 900 uppercase advance ≈ this × fontSize. Conservative so long
// words never clip the safe area.
const CHARW = 0.72;

const headlineFontSize = (lines: Tok[][], width: number) => {
  const scale = width / 1080;
  const contentW = width - 2 * Math.round(width * 0.055);
  const effLen = (l: Tok[]) =>
    l.reduce((n, tk) => n + (tk.t.length + 1) * lineSize(l), 0);
  const maxLen = lines.reduce((m, l) => Math.max(m, effLen(l)), 1);
  let maxTok = 1;
  for (const l of lines)
    for (const tk of l)
      maxTok = Math.max(maxTok, tk.t.length * lineSize(l));
  let base: number;
  if (maxLen <= 9) base = 108;
  else if (maxLen <= 14) base = 94;
  else if (maxLen <= 20) base = 80;
  else if (maxLen <= 27) base = 70;
  else base = 60;
  const fitCap = contentW / (maxTok * CHARW);
  return Math.round(Math.min(base * scale, fitCap));
};

const HEAD_STACK = "'Montserrat','Helvetica Neue',Arial,sans-serif";

const Line: React.FC<{
  line: Tok[];
  fontSize: number;
  fontFamily: string;
  brandGold: string;
  brandGoldLight: string;
  brandGoldDeep: string;
  brandRed: string;
  lead?: string;
  trail?: string;
}> = ({
  line,
  fontSize,
  fontFamily,
  brandGold,
  brandGoldLight,
  brandGoldDeep,
  brandRed,
  lead,
  trail,
}) => {
  // All tokens in the line render at the SAME size; size differentiation
  // is line-to-line (hero vs supporting), like the reference posters.
  const sz = Math.round(fontSize * lineSize(line));
  const whiteShadow =
    "0 3px 14px rgba(0,0,0,0.92), 0 1px 2px rgba(0,0,0,0.85)";
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "baseline",
        columnGap: "0.16em",
        rowGap: "0.02em",
        fontFamily,
        fontWeight: 900,
        fontSize: sz,
        lineHeight: 1,
        letterSpacing: "-0.015em",
        textTransform: "uppercase",
      }}
    >
      {lead ? (
        <span style={{ color: "#fff", textShadow: whiteShadow }}>{lead}</span>
      ) : null}
      {line.map((tk, i) => {
        if (tk.s === "rb") {
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                lineHeight: 1,
                background: brandRed,
                color: "#fff",
                padding: "0 0.10em 0.04em",
                borderRadius: 3,
                marginInline: "0.02em",
                boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
              }}
            >
              {tk.t}
            </span>
          );
        }
        if (tk.s === "g") {
          return (
            <span
              key={i}
              style={{
                lineHeight: 1,
                backgroundImage: `linear-gradient(180deg, ${brandGoldLight} 0%, ${brandGold} 40%, ${brandGoldDeep} 74%, #7E5A11 100%)`,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                WebkitTextFillColor: "transparent",
                filter: "drop-shadow(0 3px 10px rgba(0,0,0,0.75))",
              }}
            >
              {tk.t}
            </span>
          );
        }
        return (
          <span
            key={i}
            style={{
              lineHeight: 1,
              color: tk.s === "r" ? brandRed : "#FFFFFF",
              textShadow: whiteShadow,
            }}
          >
            {tk.t}
          </span>
        );
      })}
      {trail ? (
        <span style={{ color: "#fff", textShadow: whiteShadow }}>{trail}</span>
      ) : null}
    </div>
  );
};

export const JurieQuoteCard: React.FC<JurieQuoteCardProps> = ({
  topLines,
  bottomLines,
  quote,
  keyword,
  ctaComment,
  ctaTail,
  useCta,
  bgSrc,
  brandGold,
  brandGoldLight,
  brandGoldDeep,
  brandRed,
  logoSrc,
  headlineFont,
}) => {
  const { width, height } = useVideoConfig();

  // Load the Anton headline font and hold the still render until it's ready,
  // so the poster never rasterizes with the fallback face.
  const [fontHandle] = useState(() => delayRender("load-montserrat"));
  useEffect(() => {
    const face = new FontFace(
      "Montserrat",
      `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`,
      { weight: "100 900" },
    );
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        continueRender(fontHandle);
      })
      .catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  let top = topLines as Tok[][];
  let bottom = bottomLines as Tok[][];
  if ((!top || top.length === 0) && (!bottom || bottom.length === 0)) {
    const fb = fallbackLines(quote, keyword);
    top = fb.top;
    bottom = fb.bottom;
  }

  const fontFamily = headlineFont
    ? `'${headlineFont}',${HEAD_STACK}`
    : HEAD_STACK;
  const allLines = [...(top || []), ...(bottom || [])];
  const fontSize = headlineFontSize(allLines, width);

  const bg = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const padX = Math.round(width * 0.055);
  const ctaSize = Math.round(width * 0.0225);
  // Logo (when present): top inset + height as fractions of canvas height.
  // hookTop is derived from logoTop+logoHeight so changing logo size auto-
  // adjusts the hook position with a consistent gap.
  const logoTop = Math.round(height * 0.04);
  const logoHeight = Math.round(height * 0.10);
  // Hook + payoff are both bottom-anchored — the photo subject owns the
  // top half (per the reference posters), and the logo (when present) is
  // a small top-center crest that doesn't push the hook around.
  const hookBottom = Math.round(height * 0.34);
  const payoffBottom = Math.round(height * 0.13);

  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      {bg ? (
        <Img
          src={bg}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(ellipse at 50% 40%, #2A2A2E 0%, #0A0A0A 100%)",
          }}
        />
      )}

      {/* very subtle top wash so the logo reads on bright backgrounds */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 16%)",
        }}
      />
      {/* bottom scrim — covers the hook + payoff zone so text reads cleanly */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(0deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.65) 30%, rgba(0,0,0,0.28) 55%, rgba(0,0,0,0) 72%)",
        }}
      />

      {logo && (
        <div
          style={{
            position: "absolute",
            top: logoTop,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <Img
            src={logo}
            style={{
              height: logoHeight,
              width: "auto",
              objectFit: "contain",
              filter: "drop-shadow(0 6px 22px rgba(0,0,0,0.5))",
            }}
          />
        </div>
      )}

      {/* HOOK — sits in the lower-middle of the canvas, like the references */}
      <div
        style={{
          position: "absolute",
          bottom: hookBottom,
          left: padX,
          right: padX,
          display: "flex",
          flexDirection: "column",
          gap: "0.04em",
        }}
      >
        {(top || []).map((line, i) => (
          <Line
            key={i}
            line={line}
            fontSize={fontSize}
            fontFamily={fontFamily}
            brandGold={brandGold}
            brandGoldLight={brandGoldLight}
            brandGoldDeep={brandGoldDeep}
            brandRed={brandRed}
            lead={i === 0 ? "“" : undefined}
          />
        ))}
      </div>

      {/* PAYOFF */}
      <div
        style={{
          position: "absolute",
          bottom: payoffBottom,
          left: padX,
          right: padX,
          display: "flex",
          flexDirection: "column",
          gap: "0.04em",
        }}
      >
        {(bottom || []).map((line, i) => (
          <Line
            key={i}
            line={line}
            fontSize={fontSize}
            fontFamily={fontFamily}
            brandGold={brandGold}
            brandGoldLight={brandGoldLight}
            brandGoldDeep={brandGoldDeep}
            brandRed={brandRed}
            trail={
              i === (bottom || []).length - 1 ? "”" : undefined
            }
          />
        ))}
      </div>

      {/* CTA footer lockup — hidden when useCta=false (quote-only variant) */}
      {useCta && (
      <div
        style={{
          position: "absolute",
          bottom: Math.round(height * 0.042),
          left: 0,
          right: 0,
          textAlign: "center",
          fontFamily: HEAD_STACK,
          fontStyle: "normal",
          textTransform: "uppercase",
          lineHeight: 1.18,
        }}
      >
        <div style={{ fontSize: ctaSize, letterSpacing: "0.12em" }}>
          <span
            style={{
              color: "#fff",
              textShadow: "0 2px 8px rgba(0,0,0,0.9)",
            }}
          >
            COMMENT{" "}
          </span>
          <span
            style={{
              backgroundImage: `linear-gradient(180deg, ${brandGoldLight} 0%, ${brandGold} 50%, ${brandGoldDeep} 100%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.9))",
            }}
          >
            “{ctaComment}”
          </span>
        </div>
        <div
          style={{
            fontSize: Math.round(ctaSize * 0.78),
            color: "#fff",
            letterSpacing: "0.22em",
            textShadow: "0 2px 8px rgba(0,0,0,0.9)",
          }}
        >
          TO
        </div>
        <div
          style={{
            fontSize: Math.round(ctaSize * 1.08),
            color: brandRed,
            fontWeight: 800,
            letterSpacing: "0.10em",
            textShadow: "0 2px 8px rgba(0,0,0,0.9)",
          }}
        >
          {ctaTail}
        </div>
      </div>
      )}
    </AbsoluteFill>
  );
};
