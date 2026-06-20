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
  // Logo placement + size (controllable per brand kit from the dashboard).
  logoPosition: z
    .enum([
      "top-left",
      "top-center",
      "top-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ])
    .default("top-center"),
  // Fraction of canvas height (e.g. 0.10 = 10%). Clamped to a sane range.
  logoSize: z.number().min(0.04).max(0.30).default(0.10),
  headlineFont: z.string().default(""),
  // Visual style variant.
  // "cinematic" — full photo bg + dark scrims + overlay text (default / original)
  // "flat"      — no photo; deep dark bg + thick left gold stripe; type-forward
  // "split"     — photo fills top 58%, solid brand-color panel bottom 42%,
  //               hard gold divider; text lives on the panel (never over photo)
  posterStyle: z.enum(["cinematic", "flat", "split"]).default("cinematic"),
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
  logoPosition,
  logoSize,
  headlineFont,
  posterStyle,
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

  const style = posterStyle || "cinematic";
  const bg = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const padX = Math.round(width * 0.055);
  const ctaSize = Math.round(width * 0.0225);
  // Logo (when present): size + position are brand-kit controlled. Hook
  // and payoff are bottom-anchored, independent of the logo block.
  const logoH = Math.round(
    height * Math.max(0.04, Math.min(0.30, logoSize || 0.10)),
  );
  const insetY = Math.round(height * 0.04);
  const insetX = Math.round(width * 0.045);
  // Build the absolute box for the logo based on logoPosition.
  // Center positions span left:0/right:0 + flex-center. Corner positions
  // anchor to one side with an inset.
  const POS = logoPosition || "top-center";
  const isTop = POS.startsWith("top");
  const isCenter = POS.endsWith("center");
  const logoBoxStyle: React.CSSProperties = {
    position: "absolute",
    display: "flex",
    alignItems: isTop ? "flex-start" : "flex-end",
    justifyContent: isCenter
      ? "center"
      : POS.endsWith("left")
        ? "flex-start"
        : "flex-end",
    left: isCenter ? 0 : POS.endsWith("left") ? insetX : "auto",
    right: isCenter ? 0 : POS.endsWith("right") ? insetX : "auto",
    top: isTop ? insetY : "auto",
    // Lift bottom logos above the CTA + payoff zone (the CTA lives at ~4.2%
    // from bottom and is ~12% tall; the payoff sits at ~13%). Sitting at
    // ~17% from bottom clears both for small/medium logos.
    bottom: !isTop ? Math.round(height * 0.17) : "auto",
  };
  // Hook + payoff are both bottom-anchored — the photo subject owns the
  // top half (per the reference posters), and the logo (when present) is
  // a small top-center crest that doesn't push the hook around.
  const hookBottom = Math.round(height * 0.34);
  const payoffBottom = Math.round(height * 0.13);

  // ── FLAT style — bold graphic design, no photo needed ────────────────────
  if (style === "flat") {
    const textLeft  = Math.round(width * 0.08);
    const flatHookBottom    = Math.round(height * 0.34);
    const flatPayoffBottom  = Math.round(height * 0.13);
    const ctaBarH   = Math.round(height * 0.16);
    const logoH2    = Math.round(height * Math.max(0.04, Math.min(0.30, logoSize || 0.10)));
    return (
      <AbsoluteFill style={{ background: "#080810", overflow: "hidden" }}>

        {/* ── Rich background: deep dark + subtle diagonal gradient ── */}
        <AbsoluteFill style={{
          background: `linear-gradient(145deg, #12121E 0%, #080810 50%, #100008 100%)`,
        }} />

        {/* Top-right bold diagonal accent — large geometric swoosh */}
        <div style={{
          position: "absolute",
          top: -Math.round(height * 0.12),
          right: -Math.round(width * 0.08),
          width: Math.round(width * 0.72),
          height: Math.round(height * 0.52),
          borderRadius: "0 0 0 60%",
          background: `linear-gradient(135deg, ${brandRed}28 0%, ${brandGold}14 60%, transparent 100%)`,
          transform: "rotate(-8deg)",
        }} />

        {/* Strong brand glow centred on text area */}
        <AbsoluteFill style={{
          background: `radial-gradient(ellipse 70% 45% at 50% 58%, ${brandGold}28 0%, transparent 65%)`,
        }} />

        {/* Bottom CTA band — solid branded strip */}
        <div style={{
          position: "absolute", left: 0, right: 0, bottom: 0,
          height: ctaBarH,
          background: `linear-gradient(135deg, ${brandRed} 0%, #6B0010 100%)`,
        }} />
        {/* Thin gold separator above CTA band */}
        <div style={{
          position: "absolute", left: 0, right: 0,
          bottom: ctaBarH,
          height: Math.round(height * 0.004),
          background: `linear-gradient(90deg, transparent, ${brandGold}, transparent)`,
        }} />

        {/* Left gold accent stripe — bold, full height */}
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: Math.round(width * 0.018),
          background: `linear-gradient(180deg, ${brandGoldLight} 0%, ${brandGold} 50%, ${brandGoldDeep} 100%)`,
        }} />

        {/* Large decorative open-quote — visible but not distracting */}
        <div style={{
          position: "absolute",
          top: Math.round(height * 0.02),
          left: textLeft,
          lineHeight: 1,
          fontSize: Math.round(width * 0.32),
          fontFamily,
          fontWeight: 900,
          color: `${brandGold}22`,
          pointerEvents: "none",
          userSelect: "none",
        }}>&#8220;</div>

        {/* Logo — top-left */}
        {logo && (
          <div style={{ position: "absolute", top: Math.round(height * 0.04), left: textLeft }}>
            <Img src={logo} style={{ height: logoH2, width: "auto", objectFit: "contain",
              filter: "drop-shadow(0 4px 14px rgba(0,0,0,0.6)) brightness(1.1)" }} />
          </div>
        )}

        {/* HOOK */}
        <div style={{
          position: "absolute", bottom: flatHookBottom, left: textLeft, right: padX,
          display: "flex", flexDirection: "column", gap: "0.04em",
        }}>
          {(top || []).map((line, i) => (
            <Line key={i} line={line} fontSize={fontSize} fontFamily={fontFamily}
              brandGold={brandGold} brandGoldLight={brandGoldLight}
              brandGoldDeep={brandGoldDeep} brandRed={brandRed}
              lead={i === 0 ? "“" : undefined} />
          ))}
        </div>

        {/* PAYOFF */}
        <div style={{
          position: "absolute", bottom: flatPayoffBottom, left: textLeft, right: padX,
          display: "flex", flexDirection: "column", gap: "0.04em",
        }}>
          {(bottom || []).map((line, i) => (
            <Line key={i} line={line} fontSize={fontSize} fontFamily={fontFamily}
              brandGold={brandGold} brandGoldLight={brandGoldLight}
              brandGoldDeep={brandGoldDeep} brandRed={brandRed}
              trail={i === (bottom || []).length - 1 ? "”" : undefined} />
          ))}
        </div>

        {/* CTA — sits on the red band, white text */}
        {useCta && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: ctaBarH,
            display: "flex", alignItems: "center", justifyContent: "center",
            flexDirection: "column", fontFamily,
            textTransform: "uppercase", lineHeight: 1.2,
          }}>
            <div style={{ fontSize: ctaSize, letterSpacing: "0.12em" }}>
              <span style={{ color: "rgba(255,255,255,0.85)" }}>COMMENT </span>
              <span style={{
                backgroundImage: `linear-gradient(180deg, ${brandGoldLight} 0%, ${brandGold} 100%)`,
                WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent",
                fontWeight: 900,
              }}>"{ctaComment}"</span>
            </div>
            <div style={{ fontSize: Math.round(ctaSize * 0.72), color: "rgba(255,255,255,0.65)",
              letterSpacing: "0.26em", marginTop: 2 }}>TO {ctaTail}</div>
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── SPLIT style ────────────────────────────────────────────────────────────
  if (style === "split") {
    const photoFrac = 0.57; // fraction of canvas height for the photo
    const photoH = Math.round(height * photoFrac);
    const dividerH = 4;
    const panelTop = photoH + dividerH;
    const logoH = Math.round(height * Math.max(0.04, Math.min(0.30, logoSize || 0.10)));
    // Text lives entirely inside the solid panel — bottom-anchored inside that panel.
    const splitHookBottom = Math.round(height * 0.32);
    const splitPayoffBottom = Math.round(height * 0.125);
    // Cap font size so text fits comfortably inside the ~43% panel.
    const panelFontSize = Math.min(fontSize, Math.round(width * 0.072));
    return (
      <AbsoluteFill style={{ background: "#0A0A0A", overflow: "hidden" }}>
        {/* Photo — top portion only */}
        {bg && (
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: photoH, overflow: "hidden" }}>
            <Img src={bg} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
            {/* Light top scrim so logo reads */}
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
              background: "linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 30%)" }} />
          </div>
        )}
        {!bg && (
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: photoH,
            background: `radial-gradient(ellipse at 50% 40%, #2A2A2E 0%, #0A0A0A 100%)` }} />
        )}
        {/* Gold divider line */}
        <div style={{ position: "absolute", top: photoH, left: 0, right: 0, height: dividerH,
          background: `linear-gradient(90deg, ${brandGoldDeep}, ${brandGoldLight} 40%, ${brandGold} 60%, ${brandGoldDeep})`,
        }} />
        {/* Solid panel */}
        <div style={{ position: "absolute", top: panelTop, left: 0, right: 0, bottom: 0,
          background: "#0A0A0A" }} />
        {/* Logo inside photo region — top-left */}
        {logo && (
          <div style={{ position: "absolute", top: Math.round(height * 0.04),
            left: Math.round(width * 0.05) }}>
            <Img src={logo} style={{ height: logoH, width: "auto", objectFit: "contain",
              filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.6))" }} />
          </div>
        )}
        {/* HOOK — bottom-anchored, lives in the panel zone */}
        <div style={{ position: "absolute", bottom: splitHookBottom,
          left: padX, right: padX,
          display: "flex", flexDirection: "column", gap: "0.04em" }}>
          {(top || []).map((line, i) => (
            <Line key={i} line={line} fontSize={panelFontSize} fontFamily={fontFamily}
              brandGold={brandGold} brandGoldLight={brandGoldLight}
              brandGoldDeep={brandGoldDeep} brandRed={brandRed}
              lead={i === 0 ? "“" : undefined} />
          ))}
        </div>
        {/* PAYOFF */}
        <div style={{ position: "absolute", bottom: splitPayoffBottom,
          left: padX, right: padX,
          display: "flex", flexDirection: "column", gap: "0.04em" }}>
          {(bottom || []).map((line, i) => (
            <Line key={i} line={line} fontSize={panelFontSize} fontFamily={fontFamily}
              brandGold={brandGold} brandGoldLight={brandGoldLight}
              brandGoldDeep={brandGoldDeep} brandRed={brandRed}
              trail={i === (bottom || []).length - 1 ? "”" : undefined} />
          ))}
        </div>
        {/* CTA */}
        {useCta && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.038),
            left: 0, right: 0, textAlign: "center", fontFamily,
            textTransform: "uppercase", lineHeight: 1.18 }}>
            <div style={{ fontSize: ctaSize, letterSpacing: "0.12em" }}>
              <span style={{ color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.9)" }}>COMMENT </span>
              <span style={{ backgroundImage: `linear-gradient(180deg, ${brandGoldLight} 0%, ${brandGold} 50%, ${brandGoldDeep} 100%)`,
                WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent",
                filter: "drop-shadow(0 2px 6px rgba(0,0,0,0.9))" }}>"{ctaComment}"</span>
            </div>
            <div style={{ fontSize: Math.round(ctaSize * 0.78), color: "#fff",
              letterSpacing: "0.22em", textShadow: "0 2px 8px rgba(0,0,0,0.9)" }}>TO</div>
            <div style={{ fontSize: Math.round(ctaSize * 1.08), color: brandRed,
              fontWeight: 800, letterSpacing: "0.10em", textShadow: "0 2px 8px rgba(0,0,0,0.9)" }}>
              {ctaTail}
            </div>
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── CINEMATIC style (default) ──────────────────────────────────────────────
  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      {bg ? (
        <Img
          src={bg}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
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
        <div style={logoBoxStyle}>
          <Img
            src={logo}
            style={{
              height: logoH,
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
