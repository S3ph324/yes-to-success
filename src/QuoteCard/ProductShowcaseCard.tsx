import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Img,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import {
  AspectRatio,
  aspectRatioSchema,
  aspectToDimensions,
} from "./aspect";

// ─────────────────────────────────────────────────────────────────────────
// Product Showcase Card — 3 layout variants, each with its OWN type voice.
//
//  "bottom"  Editorial serif — mixed-case Fraunces, last word italic + gold,
//            tracked-caps kicker above. Premium magazine feel.
//  "top"     Campaign statement — ALL-CAPS expanded Archivo Black stacked
//            tight, first word outlined. Fashion-billboard energy.
//  "center"  Vogue editorial — large Fraunces with italic gold accent,
//            left accent bar, small-caps descriptor.
//
// When a short `headline` prop is provided (2-5 words) it renders HUGE as the
// typographic hero; `productLine` drops to a smaller descriptor below it.
// Fonts ship in public/fonts/ so Docker renders match local — without local
// files, headless Chrome on Railway falls back to a monospace face.
// ─────────────────────────────────────────────────────────────────────────

export const productShowcaseCardSchema = z.object({
  productLine: z.string().default(""),
  tagline: z.string().default(""),
  ctaTag: z.string().default(""),
  headline: z.string().default(""),          // short punchy AI hook (optional)
  layout: z.enum(["bottom", "top", "center"]).default("bottom"),
  // Poster style template key (e.g. "03-type-overlay") — maps to an overlay
  // type voice so the on-poster text matches the reference's typography.
  stylePreset: z.string().default(""),
  bgSrc: z.string().default(""),
  aspectRatio: aspectRatioSchema,
  brandGold: z.string().default("#F5C13B"),
  brandRed: z.string().default("#E11522"),
  logoSrc: z.string().default(""),
  logoPosition: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right", "top-center", "bottom-center"])
    .default("top-right"),
  logoSize: z.number().min(0.04).max(0.25).default(0.11),
});

export type ProductShowcaseCardProps = z.infer<
  typeof productShowcaseCardSchema
>;

export const calcMetaProductShowcaseCard = ({
  props,
}: {
  props: ProductShowcaseCardProps;
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

const LOGO_POS: Record<string, React.CSSProperties> = {
  "top-left":      { top: 0, left: 0 },
  "top-right":     { top: 0, right: 0 },
  "bottom-left":   { bottom: 0, left: 0 },
  "bottom-right":  { bottom: 0, right: 0 },
  "top-center":    { top: 0, left: "50%", transform: "translateX(-50%)" },
  "bottom-center": { bottom: 0, left: "50%", transform: "translateX(-50%)" },
};

// ── Typography system ──────────────────────────────────────────────────────
// Fraunces: characterful display serif (variable; SOFT/WONK axes give it the
// hand-drawn warmth generic serifs lack). Archivo: variable-width grotesque —
// stretches to a bold expanded statement face for campaign-style caps.
const FRAUNCES = "'Fraunces',Georgia,serif";
const ARCHIVO  = "'Archivo','Helvetica Neue',Arial,sans-serif";

const useShowcaseFonts = () => {
  const [handle] = useState(() => delayRender("load-showcase-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace(
        "Fraunces",
        `url(${staticFile("fonts/Fraunces.ttf")}) format("truetype")`,
        { weight: "100 900", style: "normal" },
      ),
      new FontFace(
        "Fraunces",
        `url(${staticFile("fonts/Fraunces-Italic.ttf")}) format("truetype")`,
        { weight: "100 900", style: "italic" },
      ),
      new FontFace(
        "Archivo",
        `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`,
        { weight: "100 900", stretch: "62% 125%" },
      ),
    ];
    Promise.all(
      faces.map((f) =>
        f.load().then((loaded) => document.fonts.add(loaded)),
      ),
    )
      .then(() => continueRender(handle))
      .catch(() => continueRender(handle));
  }, [handle]);
};

/** AI copy often arrives ALL CAPS — sentence-case it so the serif treatments
 *  read editorial, not shouty. Mixed-case input passes through untouched. */
const sentenceCase = (s: string) => {
  const t = s.trim();
  if (t !== t.toUpperCase()) return t; // already mixed case — author's intent
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

/** Serif hero — last word italic + brand gold (Fraunces WONK for character).
 *  Single-word headlines render plain; the accent needs a counterpart. */
const SerifHero: React.FC<{
  text: string;
  size: number;
  gold: string;
  weight?: number;
  lineHeight?: number;
  shadow?: string;
  color?: string;
}> = ({ text, size, gold, weight = 700, lineHeight = 1.06, shadow, color = "#FFFFFF" }) => {
  const words = sentenceCase(text).split(/\s+/);
  const accentIdx = words.length > 1 ? words.length - 1 : -1;
  return (
    <div
      style={{
        fontFamily: FRAUNCES,
        fontWeight: weight,
        fontSize: size,
        color,
        letterSpacing: "-0.01em",
        lineHeight,
        textShadow: shadow ?? "0 3px 28px rgba(0,0,0,0.75)",
        fontVariationSettings: '"SOFT" 0, "WONK" 0',
      }}
    >
      {words.map((w, idx) => (
        <span
          key={idx}
          style={
            idx === accentIdx
              ? {
                  fontStyle: "italic",
                  color: gold,
                  fontVariationSettings: '"SOFT" 40, "WONK" 1',
                }
              : undefined
          }
        >
          {w}
          {idx < words.length - 1 ? " " : ""}
        </span>
      ))}
    </div>
  );
};

/** Campaign hero — ALL-CAPS expanded Archivo Black, stacked tight, first
 *  word outlined (transparent fill) for fashion-billboard contrast. */
const CampaignHero: React.FC<{
  text: string;
  size: number;
  shadow?: string;
  color?: string;
}> = ({ text, size, shadow, color = "#FFFFFF" }) => {
  const words = text.trim().toUpperCase().split(/\s+/);
  const stroke = Math.max(2, Math.round(size * 0.025));
  return (
    <div
      style={{
        fontFamily: ARCHIVO,
        fontWeight: 900,
        fontStretch: "125%",
        fontSize: size,
        lineHeight: 0.98,
        letterSpacing: "0.01em",
        color,
        textShadow: shadow ?? "0 4px 32px rgba(0,0,0,0.9)",
      }}
    >
      {words.map((w, idx) => (
        <span
          key={idx}
          style={
            idx === 0 && words.length > 1
              ? {
                  display: "block",
                  color: "transparent",
                  WebkitTextStroke: `${stroke}px ${color}`,
                  textShadow: "none",
                }
              : { display: words.length > 2 ? "block" : "inline" }
          }
        >
          {w}
          {idx < words.length - 1 && words.length <= 2 ? " " : ""}
        </span>
      ))}
    </div>
  );
};

/** Echo hero — heavy expanded caps in brand gold with outline echo copies
 *  stacked behind, matching the "type overlay" reference posters. */
const EchoHero: React.FC<{
  text: string;
  size: number;
  gold: string;
}> = ({ text, size, gold }) => {
  const t = text.trim().toUpperCase();
  const stroke = Math.max(1.5, Math.round(size * 0.02));
  const base: React.CSSProperties = {
    fontFamily: ARCHIVO,
    fontWeight: 900,
    fontStretch: "125%",
    fontSize: size,
    lineHeight: 1.02,
    letterSpacing: "0.01em",
  };
  const echo: React.CSSProperties = {
    ...base,
    position: "absolute",
    left: 0,
    right: 0,
    color: "transparent",
    WebkitTextStroke: `${stroke}px ${gold}`,
  };
  return (
    <div style={{ position: "relative" }}>
      <div aria-hidden style={{ ...echo, top: 0, transform: "translateY(-82%)", opacity: 0.32 }}>{t}</div>
      <div aria-hidden style={{ ...echo, top: 0, transform: "translateY(82%)", opacity: 0.18 }}>{t}</div>
      <div style={{ ...base, position: "relative", color: gold, textShadow: "0 3px 24px rgba(0,0,0,0.55)" }}>
        {t}
      </div>
    </div>
  );
};

/** Minimal hero — restrained tracked caps, medium weight. For clean/minimal
 *  reference styles where the product owns the poster and type whispers. */
const MinimalHero: React.FC<{ text: string; size: number; color?: string; shadow?: string }> = ({
  text, size, color = "#FFFFFF", shadow,
}) => (
  <div
    style={{
      fontFamily: ARCHIVO,
      fontWeight: 500,
      fontSize: size,
      letterSpacing: "0.3em",
      textTransform: "uppercase" as const,
      color,
      lineHeight: 1.4,
      textShadow: shadow ?? "0 2px 22px rgba(0,0,0,0.7)",
    }}
  >
    {text}
  </div>
);

/** Spec hero — tracked caps between hairline rules, technical spec-sheet
 *  aesthetic for the pedestal / glass-panel reference styles. */
const SpecHero: React.FC<{ text: string; size: number; scale: number; color?: string; line?: string; shadow?: string }> = ({
  text, size, scale, color = "#FFFFFF", line = "rgba(255,255,255,0.55)", shadow,
}) => (
  <div
    style={{
      borderTop: `1px solid ${line}`,
      borderBottom: `1px solid ${line}`,
      padding: `${Math.round(14 * scale)}px 0`,
      display: "inline-block",
    }}
  >
    <div
      style={{
        fontFamily: ARCHIVO,
        fontWeight: 600,
        fontSize: size,
        letterSpacing: "0.2em",
        textTransform: "uppercase" as const,
        color,
        lineHeight: 1.35,
        textShadow: shadow ?? "0 2px 18px rgba(0,0,0,0.7)",
      }}
    >
      {text}
    </div>
  </div>
);

// Which type voice each poster style template gets. Unknown keys fall through
// to substring heuristics, so future presets pick a sensible voice from their
// filename alone; no key at all → the original layout-based rotation.
type TypeVoice = "serif" | "campaign" | "echo" | "minimal" | "spec";
const PRESET_VOICE: Record<string, TypeVoice> = {
  "01-dramatic-multiangle":      "minimal",
  "02-minimal-pedestal":         "spec",
  "03-type-overlay":             "echo",
  "04-editorial-props":          "serif",
  "05-glass-panel-spec":         "spec",
  "model-01-bold-type-overlay":  "campaign",
  "model-02-elegant-hold":       "serif",
  "model-03-earthy-editorial":   "serif",
  "model-04-clean-fresh":        "minimal",
  "model-05-outdoor-cinematic":  "campaign",
};
const voiceFor = (preset: string, layout: string): TypeVoice => {
  if (PRESET_VOICE[preset]) return PRESET_VOICE[preset];
  const p = preset.toLowerCase();
  if (p && p !== "custom" && p !== "auto") {
    if (p.includes("type-overlay") || p.includes("echo")) return "echo";
    if (p.includes("spec") || p.includes("pedestal") || p.includes("panel")) return "spec";
    if (p.includes("minimal") || p.includes("clean")) return "minimal";
    if (p.includes("bold") || p.includes("cinematic") || p.includes("campaign")) return "campaign";
  }
  return layout === "top" ? "campaign" : "serif";
};

// Light/dark tone per template — light references (cream/white/minimal) get
// bright frosted panels + dark ink type instead of dark scrims + white type.
// Keep in sync with LIGHT_PRESETS in scripts/generate-backgrounds-jurie.mjs.
const LIGHT_PRESETS = new Set([
  "02-minimal-pedestal", "03-type-overlay", "04-editorial-props",
  "05-glass-panel-spec", "model-02-elegant-hold", "model-04-clean-fresh",
]);
const toneFor = (preset: string): "light" | "dark" => {
  const p = preset.toLowerCase();
  if (LIGHT_PRESETS.has(p)) return "light";
  if (/dark|cinematic|bold|earthy|dramatic/.test(p)) return "dark";
  if (/minimal|clean|pedestal|panel|spec|elegant|fresh|cream|white|overlay/.test(p)) return "light";
  return "dark";
};

// Per-template layout — each reference poster has a signature text placement
// (e.g. "Elegant product hold" is a top masthead over the model). Overrides
// the copy generator's blind bottom/top/center rotation when a template is
// chosen; no template → rotation stands.
const PRESET_LAYOUT: Record<string, "bottom" | "top" | "center"> = {
  "01-dramatic-multiangle":      "center",
  "02-minimal-pedestal":         "top",
  "03-type-overlay":             "center",
  "04-editorial-props":          "bottom",
  "05-glass-panel-spec":         "top",
  "model-01-bold-type-overlay":  "top",
  "model-02-elegant-hold":       "top",
  "model-03-earthy-editorial":   "bottom",
  "model-04-clean-fresh":        "top",
  "model-05-outdoor-cinematic":  "bottom",
};

/** Tracked-caps kicker — small Archivo line above the hero ("THE PINK DROP"). */
const Kicker: React.FC<{ text: string; scale: number; gold: string; color?: string }> = ({
  text, scale, gold, color = "rgba(255,255,255,0.82)",
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: Math.round(12 * scale),
      marginBottom: Math.round(14 * scale),
    }}
  >
    <div style={{ width: Math.round(34 * scale), height: 2, background: gold }} />
    <div
      style={{
        fontFamily: ARCHIVO,
        fontWeight: 600,
        fontSize: Math.round(17 * scale),
        letterSpacing: "0.22em",
        textTransform: "uppercase" as const,
        color,
      }}
    >
      {text}
    </div>
  </div>
);

// ── Shared sub-components ─────────────────────────────────────────────────

/** Accent rule — red→gold gradient, always spans the text column */
const AccentRule: React.FC<{ scale: number; brandRed: string; brandGold: string; mb?: number }> = ({
  scale, brandRed, brandGold, mb = 18,
}) => (
  <div
    style={{
      height: Math.round(4 * scale),
      background: `linear-gradient(90deg, ${brandRed} 0%, ${brandGold} 55%, transparent 100%)`,
      marginBottom: Math.round(mb * scale),
      borderRadius: 2,
    }}
  />
);

/** CTA chip — small tracked uppercase pill; the hero owns the hierarchy. */
const CtaChip: React.FC<{ text: string; brandGold: string; scale: number; opacity: number }> = ({
  text, brandGold, scale, opacity,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: `${Math.round(7 * scale)}px ${Math.round(20 * scale)}px`,
      background: brandGold,
      color: "#15120a",
      borderRadius: 999,
      fontFamily: ARCHIVO,
      fontWeight: 700,
      fontSize: Math.round(15 * scale),
      letterSpacing: "0.16em",
      textTransform: "uppercase" as const,
      marginBottom: Math.round(18 * scale),
      boxShadow: "0 4px 24px rgba(0,0,0,0.45)",
      opacity,
    }}
  >
    {text}
  </div>
);

export const ProductShowcaseCard: React.FC<ProductShowcaseCardProps> = ({
  productLine,
  tagline,
  ctaTag,
  headline,
  layout,
  stylePreset,
  bgSrc,
  brandGold,
  brandRed,
  logoSrc,
  logoPosition,
  logoSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  useShowcaseFonts();

  // Animations
  const fadeIn     = interpolate(frame, [0, 22], [0, 1], { extrapolateRight: "clamp" });
  const fadeInLate = interpolate(frame, [10, 32], [0, 1], { extrapolateRight: "clamp" });
  const lift       = spring({ frame, fps, from: 32, to: 0, durationInFrames: 34 });
  const bgScale    = interpolate(frame, [0, 90], [1.05, 1.0], { extrapolateRight: "clamp" });

  const bg   = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const scale  = width / 1080;
  const inset  = Math.round(Math.min(width, height) * 0.052);
  const logoH  = Math.round(height * logoSize);

  // When a short creative headline is provided, it becomes the HERO type.
  // productLine drops to a descriptor sub-line.
  const heroText = headline || productLine;
  const subText  = headline ? productLine : tagline;
  const extraTagline = headline ? tagline : "";
  const isHeroShort = heroText.length < 30; // short = can go bigger

  const hasText = Boolean(heroText);

  // Effective layout — the chosen template's signature placement wins over
  // the copy generator's rotation.
  const effLayout = PRESET_LAYOUT[stylePreset] || layout;

  // Tone — light templates get bright frosted panels + dark ink type.
  const tone = toneFor(stylePreset);
  const isLight = tone === "light";
  const ink    = isLight ? "#1b1822" : "#FFFFFF";
  const inkSub = isLight ? "rgba(27,24,34,0.78)" : "rgba(255,255,255,0.85)";
  const inkTag = isLight ? "rgba(27,24,34,0.56)" : "rgba(255,255,255,0.62)";
  const heroShadow = isLight ? "0 1px 2px rgba(0,0,0,0.06)" : undefined;

  // Hero type voice — from the selected poster style template, with a
  // layout-based fallback. One element, reused by every layout below.
  const voice = voiceFor(stylePreset, effLayout);
  // Masthead: serif voice anchored top = the "elevate your VISION" reference
  // structure — centered italic eyebrow, huge serif, details row below.
  const masthead = voice === "serif" && effLayout === "top";
  const heroEl = (() => {
    switch (voice) {
      case "campaign":
        return <CampaignHero text={heroText} size={Math.round((isHeroShort ? 80 : 52) * scale)} color={ink} shadow={heroShadow} />;
      case "echo":
        return <EchoHero text={heroText} size={Math.round((isHeroShort ? 72 : 50) * scale)} gold={brandGold} />;
      case "minimal":
        return <MinimalHero text={heroText} size={Math.round((isHeroShort ? 46 : 34) * scale)} color={ink} shadow={heroShadow} />;
      case "spec":
        return <SpecHero text={heroText} size={Math.round((isHeroShort ? 40 : 30) * scale)} scale={scale} color={ink} line={isLight ? "rgba(27,24,34,0.45)" : "rgba(255,255,255,0.55)"} shadow={heroShadow} />;
      default:
        return (
          <SerifHero
            text={heroText}
            size={Math.round((isHeroShort ? (masthead ? 110 : effLayout === "center" ? 98 : 92) : (effLayout === "center" || masthead ? 64 : 60)) * scale)}
            gold={brandGold}
            color={ink}
            weight={effLayout === "center" ? 560 : masthead ? 600 : 650}
            lineHeight={effLayout === "center" || masthead ? 1.04 : 1.06}
            shadow={heroShadow ?? (effLayout === "center"
              ? "0 2px 40px rgba(0,0,0,0.8), 0 0 80px rgba(0,0,0,0.4)"
              : undefined)}
          />
        );
    }
  })();

  // Supporting type — shared across layouts.
  // Descriptor: tracked-caps Archivo. Tagline: italic Fraunces, muted.
  const descriptorStyle: React.CSSProperties = {
    fontFamily: ARCHIVO,
    fontWeight: 600,
    fontSize: Math.round(21 * scale),
    letterSpacing: "0.18em",
    textTransform: "uppercase" as const,
    color: inkSub,
    lineHeight: 1.4,
  };
  const taglineStyle: React.CSSProperties = {
    fontFamily: FRAUNCES,
    fontStyle: "italic",
    fontWeight: 400,
    fontSize: Math.round(23 * scale),
    color: inkTag,
    letterSpacing: "0.01em",
    lineHeight: 1.45,
    fontVariationSettings: '"SOFT" 60, "WONK" 0',
  };

  // Tone-dependent surfaces.
  const baseFill = isLight ? "#f6f4ef" : "#0a0a0c";
  const fallbackBg = isLight
    ? "radial-gradient(ellipse at 50% 35%, #ffffff 0%, #e9e4da 100%)"
    : "radial-gradient(ellipse at 50% 35%, #2e2e36 0%, #080810 100%)";
  const scrimRGB = isLight ? "248,246,241" : "8,6,12";

  // ── Background ──────────────────────────────────────────────────────────
  const heroBg = (
    <>
      {bg ? (
        <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
          <Img src={bg} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ background: fallbackBg }} />
      )}
      {/* Corner vignette — dark tone only; vignettes muddy a high-key shot */}
      {!isLight && (
        <AbsoluteFill
          style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.4) 100%)" }}
        />
      )}
    </>
  );

  // ── Logo ────────────────────────────────────────────────────────────────
  const logoShadow = isLight
    ? "drop-shadow(0 2px 10px rgba(0,0,0,0.30))"
    : "drop-shadow(0 3px 18px rgba(0,0,0,0.7)) drop-shadow(0 1px 4px rgba(0,0,0,0.5))";
  const logoEl = logo ? (
    <div style={{ position: "absolute", ...LOGO_POS[logoPosition], margin: inset, opacity: fadeInLate }}>
      <Img
        src={logo}
        style={{
          height: logoH, width: "auto", objectFit: "contain",
          filter: logoShadow,
        }}
      />
    </div>
  ) : null;

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: "bottom" — editorial serif over a deep gradient panel
  // ─────────────────────────────────────────────────────────────────────────
  if (effLayout === "bottom") {
    return (
      <AbsoluteFill style={{ background: baseFill, overflow: "hidden" }}>
        {heroBg}
        {/* Bottom scrim — frosted white panel on light tone, deep fade on dark */}
        <AbsoluteFill
          style={{ background: `linear-gradient(180deg, transparent 35%, rgba(${scrimRGB},0.72) 60%, rgba(${scrimRGB},0.97) 100%)` }}
        />
        {logoEl}
        {hasText && (
          <div
            style={{
              position: "absolute",
              left: inset, right: inset,
              bottom: Math.round(height * 0.055),
              opacity: fadeIn,
              transform: `translateY(${lift}px)`,
            }}
          >
            {subText ? (
              <Kicker text={subText} scale={scale} gold={brandGold} color={inkSub} />
            ) : (
              <AccentRule scale={scale} brandRed={brandRed} brandGold={brandGold} />
            )}
            {heroEl}
            {extraTagline && (
              <div style={{ ...taglineStyle, marginTop: Math.round(10 * scale) }}>
                {extraTagline}
              </div>
            )}
            {ctaTag && (
              <div style={{ marginTop: Math.round(20 * scale) }}>
                <CtaChip text={ctaTag} brandGold={brandGold} scale={scale} opacity={fadeInLate} />
              </div>
            )}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: "top" — campaign statement caps at top, photo hero below
  // ─────────────────────────────────────────────────────────────────────────
  if (effLayout === "top") {
    return (
      <AbsoluteFill style={{ background: baseFill, overflow: "hidden" }}>
        {heroBg}
        {/* Top scrim — solid at the very top, fades to transparent */}
        <AbsoluteFill
          style={{ background: `linear-gradient(180deg, rgba(${scrimRGB},0.97) 0%, rgba(${scrimRGB},0.72) 30%, transparent 58%)` }}
        />
        {/* Subtle bottom fade so logo / bottom CTA read if present */}
        <AbsoluteFill
          style={{ background: `linear-gradient(180deg, transparent 75%, rgba(${scrimRGB},0.55) 100%)` }}
        />
        {/* Logo: mirror position to bottom when layout is top — keeps it away from the text */}
        {logo && (
          <div style={{
            position: "absolute",
            bottom: 0, right: 0,
            margin: inset, opacity: fadeInLate,
          }}>
            <Img src={logo} style={{
              height: logoH, width: "auto", objectFit: "contain",
              filter: logoShadow,
            }} />
          </div>
        )}
        {hasText && (
          <div
            style={{
              position: "absolute",
              left: inset, right: inset,
              top: Math.round(height * 0.058),
              opacity: fadeIn,
              transform: `translateY(${-lift}px)`,  // animate from above
              textAlign: masthead ? ("center" as const) : ("left" as const),
            }}
          >
            {/* Masthead eyebrow — small italic serif line above the big type */}
            {masthead && extraTagline && (
              <div style={{
                ...taglineStyle,
                fontSize: Math.round(27 * scale),
                marginBottom: Math.round(2 * scale),
              }}>
                {extraTagline}
              </div>
            )}
            {heroEl}
            {!masthead && (
              <div style={{ marginTop: Math.round(14 * scale) }}>
                <AccentRule scale={scale} brandRed={brandRed} brandGold={brandGold} mb={0} />
              </div>
            )}
            {subText && (
              <div style={{
                ...descriptorStyle,
                marginTop: Math.round(masthead ? 18 : 14) * scale,
                ...(masthead ? { fontSize: Math.round(16 * scale), letterSpacing: "0.26em" } : {}),
              }}>
                {subText}
              </div>
            )}
            {!masthead && extraTagline && (
              <div style={{ ...taglineStyle, marginTop: Math.round(8 * scale) }}>
                {extraTagline}
              </div>
            )}
            {ctaTag && (
              <div style={{ marginTop: Math.round(16 * scale) }}>
                <CtaChip text={ctaTag} brandGold={brandGold} scale={scale} opacity={fadeInLate} />
              </div>
            )}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: "center" — vogue editorial, large serif centered vertically
  // ─────────────────────────────────────────────────────────────────────────
  const overlayOpacity = interpolate(frame, [0, 30], [0.2, 0.65], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: baseFill, overflow: "hidden" }}>
      {heroBg}
      {/* Directional contrast wash — left-weighted so the text column reads */}
      <AbsoluteFill
        style={{ background: isLight
          ? "linear-gradient(105deg, rgba(255,255,255,0.66) 0%, transparent 55%, rgba(255,255,255,0.3) 100%)"
          : "linear-gradient(105deg, rgba(0,0,0,0.62) 0%, transparent 55%, rgba(0,0,0,0.28) 100%)" }}
      />
      {/* Subtle full-frame wash that animates in */}
      <AbsoluteFill style={{ background: isLight
        ? `rgba(248,246,241,${overlayOpacity * 0.8})`
        : `rgba(0,0,0,${overlayOpacity})` }} />
      {logoEl}
      {hasText && (
        <div
          style={{
            position: "absolute",
            left: inset, right: inset,
            top: "50%",
            transform: `translateY(calc(-50% + ${lift}px))`,
            opacity: fadeIn,
          }}
        >
          {/* Left-border accent line for editorial feel */}
          <div style={{
            width: Math.round(5 * scale),
            height: "100%",
            background: `linear-gradient(180deg, ${brandGold} 0%, ${brandRed} 100%)`,
            position: "absolute",
            left: -Math.round(20 * scale),
            top: 0,
            borderRadius: 3,
          }} />
          {ctaTag && (
            <div style={{
              display: "inline-flex", alignItems: "center",
              padding: `${Math.round(5 * scale)}px ${Math.round(16 * scale)}px`,
              border: `2px solid ${brandGold}`,
              color: brandGold,
              borderRadius: 999,
              fontFamily: ARCHIVO,
              fontWeight: 700,
              fontSize: Math.round(14 * scale),
              letterSpacing: "0.16em",
              textTransform: "uppercase" as const,
              marginBottom: Math.round(18 * scale),
              opacity: fadeInLate,
            }}>{ctaTag}</div>
          )}
          {heroEl}
          {/* Gold accent rule below headline */}
          <div style={{
            height: Math.round(3 * scale),
            width: "45%",
            background: `linear-gradient(90deg, ${brandGold} 0%, transparent 100%)`,
            marginTop: Math.round(16 * scale),
            marginBottom: Math.round(14 * scale),
            borderRadius: 2,
          }} />
          {subText && <div style={descriptorStyle}>{subText}</div>}
          {extraTagline && (
            <div style={{ ...taglineStyle, marginTop: Math.round(9 * scale) }}>
              {extraTagline}
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
