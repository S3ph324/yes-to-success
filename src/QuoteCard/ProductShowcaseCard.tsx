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
  // Measured background busyness per band (0 = flat/clean, 1 = very busy),
  // computed by render-batch from the actual PNG. Drives adaptive scrims,
  // placement, and compact overlay. Defaults assume "busy" so behavior
  // without analysis matches the previous full-scrim look.
  busyTop: z.number().min(0).max(1).default(0.75),
  busyBottom: z.number().min(0).max(1).default(0.75),
  // User-entered promotion (e.g. "35% OFF until June 30") — rendered verbatim
  // as a badge next to the CTA. Never AI-generated.
  promoTag: z.string().default(""),
  // Editorial furniture — brand label + poster index ("Nº 03 — 08") rendered
  // as a hairline header device on spec/minimal/masthead posters.
  brandTag: z.string().default(""),
  posterIndex: z.number().int().min(0).default(0),
  posterTotal: z.number().int().min(0).default(0),
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
// High-contrast didone for masthead headlines — the "elevate your VISION"
// reference face. Fraunces stays for the warmer editorial layouts.
const BODONI   = "'Bodoni Moda','Fraunces',Georgia,serif";

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
        "Bodoni Moda",
        `url(${staticFile("fonts/BodoniModa.ttf")}) format("truetype")`,
        { weight: "400 900", style: "normal" },
      ),
      new FontFace(
        "Bodoni Moda",
        `url(${staticFile("fonts/BodoniModa-Italic.ttf")}) format("truetype")`,
        { weight: "400 900", style: "italic" },
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
  font?: string;
}> = ({ text, size, gold, weight = 700, lineHeight = 1.06, shadow, color = "#FFFFFF", font = FRAUNCES }) => {
  const words = sentenceCase(text).split(/\s+/);
  const accentIdx = words.length > 1 ? words.length - 1 : -1;
  const isFraunces = font === FRAUNCES;
  return (
    <div
      style={{
        fontFamily: font,
        fontWeight: weight,
        fontSize: size,
        color,
        letterSpacing: "-0.01em",
        lineHeight,
        textShadow: shadow ?? "0 3px 28px rgba(0,0,0,0.75)",
        ...(isFraunces ? { fontVariationSettings: '"SOFT" 0, "WONK" 0' } : {}),
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
                  ...(isFraunces ? { fontVariationSettings: '"SOFT" 40, "WONK" 1' } : {}),
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
  // Solid filled caps. The old first-word "hollow outline" trick read as
  // unfinished, ugly type (esp. when a letter clipped the frame edge) — the
  // user called it out, so every word is solid now.
  const words = text.trim().toUpperCase().split(/\s+/);
  return (
    <div
      style={{
        fontFamily: ARCHIVO,
        fontWeight: 900,
        fontStretch: "125%",
        fontSize: size,
        lineHeight: 1.0,
        letterSpacing: "0.005em",
        color,
        textShadow: shadow ?? "0 4px 32px rgba(0,0,0,0.9)",
        wordBreak: "break-word",
      }}
    >
      {words.map((w, idx) => (
        <span
          key={idx}
          style={{ display: words.length > 2 ? "block" : "inline" }}
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
  echoes?: boolean; // off on compact plates — they'd bleed past the plate
}> = ({ text, size, gold, echoes = true }) => {
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
      {echoes && (
        <>
          <div aria-hidden style={{ ...echo, top: 0, transform: "translateY(-82%)", opacity: 0.32 }}>{t}</div>
          <div aria-hidden style={{ ...echo, top: 0, transform: "translateY(82%)", opacity: 0.18 }}>{t}</div>
        </>
      )}
      <div style={{ ...base, position: "relative", color: gold, textShadow: echoes ? "0 3px 24px rgba(0,0,0,0.55)" : "none" }}>
        {t}
      </div>
    </div>
  );
};

/** Clean hero — big mixed-case grotesque with a gold marker-highlight swipe
 *  behind the last word. Youthful clean editorial for minimal/fresh styles
 *  (the old whisper-caps treatment read bland). */
const CleanHero: React.FC<{ text: string; size: number; color?: string; gold: string; shadow?: string }> = ({
  text, size, color = "#FFFFFF", gold, shadow,
}) => {
  const words = sentenceCase(text).split(/\s+/);
  const accentIdx = words.length > 1 ? words.length - 1 : -1;
  return (
    <div
      style={{
        fontFamily: ARCHIVO,
        fontWeight: 800,
        fontSize: size,
        letterSpacing: "-0.02em",
        color,
        lineHeight: 1.08,
        textShadow: shadow ?? "0 2px 22px rgba(0,0,0,0.7)",
      }}
    >
      {words.map((w, idx) => (
        <span
          key={idx}
          style={
            idx === accentIdx
              ? {
                  // marker swipe under the lower half of the word
                  background: `linear-gradient(180deg, transparent 60%, ${gold} 60%, ${gold} 94%, transparent 94%)`,
                  padding: "0 0.06em",
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

/** Spec hero — tracked caps between hairline rules, technical spec-sheet
 *  aesthetic for the pedestal / glass-panel reference styles. */
const SpecHero: React.FC<{ text: string; size: number; scale: number; color?: string; line?: string; shadow?: string }> = ({
  text, size, scale, color = "#FFFFFF", line = "rgba(255,255,255,0.55)", shadow,
}) => (
  <div
    style={{
      // Spec-sheet rules: heavy double line above, hairline below.
      borderTop: `4px double ${line}`,
      borderBottom: `1px solid ${line}`,
      padding: `${Math.round(16 * scale)}px 0`,
      display: "inline-block",
    }}
  >
    <div
      style={{
        fontFamily: ARCHIVO,
        fontWeight: 800,
        fontSize: size,
        // Large caps need far less tracking than small caps — 0.18em at
        // headline scale read airy and flat.
        letterSpacing: "0.06em",
        textTransform: "uppercase" as const,
        color,
        lineHeight: 1.12,
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
  "05-glass-panel-spec", "model-01-bold-type-overlay",
  "model-02-elegant-hold", "model-04-clean-fresh",
]);
const toneFor = (preset: string): "light" | "dark" => {
  const p = preset.toLowerCase();
  if (LIGHT_PRESETS.has(p)) return "light";
  if (/dark|cinematic|earthy|dramatic/.test(p)) return "dark";
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

/** Editorial furniture — hairline header row: tracked brand label left,
 *  "Nº 03 — 08" index right. The kind of technical-depth device editorial
 *  design uses to make a layout read considered instead of generated. */
const Furniture: React.FC<{
  brandTag: string;
  idx: number;
  total: number;
  scale: number;
  color: string;
  line: string;
}> = ({ brandTag, idx, total, scale, color, line }) => (
  <div
    style={{
      borderBottom: `1px solid ${line}`,
      paddingBottom: Math.round(9 * scale),
      marginBottom: Math.round(20 * scale),
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: Math.round(12 * scale),
    }}
  >
    <span style={{
      fontFamily: ARCHIVO,
      fontWeight: 600,
      fontSize: Math.round(13 * scale),
      letterSpacing: "0.32em",
      textTransform: "uppercase" as const,
      color,
      whiteSpace: "nowrap" as const,
      overflow: "hidden",
    }}>
      {brandTag}
    </span>
    {idx > 0 && (
      <span style={{
        fontFamily: ARCHIVO,
        fontWeight: 600,
        fontSize: Math.round(13 * scale),
        letterSpacing: "0.18em",
        color,
        whiteSpace: "nowrap" as const,
      }}>
        {`Nº ${String(idx).padStart(2, "0")}${total ? ` — ${String(total).padStart(2, "0")}` : ""}`}
      </span>
    )}
  </div>
);

// ── Shared sub-components ─────────────────────────────────────────────────

/** Accent rule — short premium gold bar with a red tick. (The old full-width
 *  red→gold gradient spanning the whole column read cheap.) */
const AccentRule: React.FC<{ scale: number; brandRed: string; brandGold: string; mb?: number }> = ({
  scale, brandRed, brandGold, mb = 18,
}) => (
  <div style={{ display: "flex", gap: Math.round(5 * scale), marginBottom: Math.round(mb * scale) }}>
    <div style={{
      width: Math.round(64 * scale),
      height: Math.round(4 * scale),
      background: brandGold,
      borderRadius: 2,
    }} />
    <div style={{
      width: Math.round(12 * scale),
      height: Math.round(4 * scale),
      background: brandRed,
      borderRadius: 2,
    }} />
  </div>
);

/** Promo badge — user-entered promotion rendered verbatim. Red, bold, with a
 *  slight tilt so it reads like a deliberate sticker, not body copy. */
const PromoBadge: React.FC<{ text: string; brandRed: string; scale: number; opacity: number }> = ({
  text, brandRed, scale, opacity,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: `${Math.round(8 * scale)}px ${Math.round(18 * scale)}px`,
      background: brandRed,
      color: "#FFFFFF",
      borderRadius: Math.round(9 * scale),
      fontFamily: ARCHIVO,
      fontWeight: 800,
      fontSize: Math.round(17 * scale),
      letterSpacing: "0.06em",
      textTransform: "uppercase" as const,
      transform: "rotate(-2deg)",
      boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
      opacity,
    }}
  >
    {text}
  </div>
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
  busyTop,
  busyBottom,
  promoTag,
  brandTag,
  posterIndex,
  posterTotal,
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
  // ONE supporting line only — the old lockup stacked a caps descriptor AND an
  // italic tagline under the headline, which buried the product. Prefer the
  // human tagline; fall back to the product line so something always supports
  // the hook. (Short, quiet — the photo is the focus, not the copy.)
  const subText  = (headline ? (tagline || productLine) : tagline).trim();
  const subLine  = subText;
  const isHeroShort = heroText.length < 30; // short = can go bigger

  const hasText = Boolean(heroText);

  // Type-decor templates: the generated image carries its own oversized type,
  // so the overlay must get out of the way — small bottom lockup, no big
  // headline competing with the art, near-zero scrim.
  const typeDecor = /type-overlay/.test(stylePreset);

  // Effective layout — the chosen template's signature placement wins over
  // the copy generator's rotation. Without a template, the rotation's pick
  // flips to the measurably cleaner band so text never sits on the busiest
  // part of the art.
  const presetForced = Boolean(PRESET_LAYOUT[stylePreset]);
  let effLayout = PRESET_LAYOUT[stylePreset] || layout;
  if (typeDecor) effLayout = "bottom"; // references keep their own type up top
  else if (!presetForced && effLayout === "bottom" && busyBottom - busyTop > 0.22) effLayout = "top";
  else if (!presetForced && effLayout === "top" && busyTop - busyBottom > 0.22) effLayout = "bottom";
  // Portraits (model-worn shots): the face sits high & central, so any top- or
  // center-anchored overlay lands ON it and kills the photo's emphasis. The
  // generator keeps the LOWER band clean negative space — always drop the text
  // there for model posters so it never covers the face.
  if (stylePreset.startsWith("model-")) effLayout = "bottom";

  // Busyness of the band the text actually occupies → adaptive overlay:
  // - scrimScale: clean art gets a whisper of a scrim, busy art the full one
  // - compact: the image already reads as a designed poster (e.g. it carries
  //   its own display type) → shrink the overlay and drop secondary lines so
  //   we frame the art instead of fighting it.
  const bandBusy = effLayout === "top" ? busyTop
    : effLayout === "bottom" ? busyBottom
    : (busyTop + busyBottom) / 2;
  // Scrim ceilings: portraits ("busy" band = the model's FACE, not clutter),
  // light tone in general (heavy white washes erase clean art), and
  // type-decor templates (the image IS the design — barely touch it).
  const isPortrait = stylePreset.startsWith("model-");
  const tone2 = toneFor(stylePreset); // needed before sa(); isLight defined below
  const scrimCeiling = typeDecor ? 0.42
    : isPortrait ? 0.72
    : tone2 === "light" ? 0.85
    : 1;
  const scrimScale = Math.min(
    scrimCeiling,
    0.35 + 0.65 * Math.max(0, Math.min(1, bandBusy)),
  );
  const sa = (alpha: number) => +(alpha * scrimScale).toFixed(3);
  // Compact: type-decor always (image carries the display type); otherwise
  // when the measured band is extremely busy.
  const compact = typeDecor || bandBusy > 0.82;
  const cs = typeDecor ? 0.68 : compact ? 0.62 : 1; // hero size factor

  // Logo placement follows the EFFECTIVE layout. render-batch used to decide
  // from the copy generator's rotation layout — when a template override
  // moved the text, the logo landed inside the text block.
  const effLogoPos = effLayout === "top"
    ? "bottom-right"
    : (logoPosition || "top-right").startsWith("bottom")
      ? "top-right"
      : logoPosition;

  // Tone — light templates get bright frosted panels + dark ink type.
  const tone = toneFor(stylePreset);
  const isLight = tone === "light";
  // Compact lockups sit on a solid inverted plate (see heroBlock below), so
  // their type colour inverts with it.
  const inkBase = isLight ? "#1b1822" : "#FFFFFF";
  const ink    = compact ? (isLight ? "#F7F3EC" : "#17151d") : inkBase;
  const inkSub = isLight ? "rgba(27,24,34,0.78)" : "rgba(255,255,255,0.85)";
  const inkTag = isLight ? "rgba(27,24,34,0.56)" : "rgba(255,255,255,0.62)";
  // On a plate the contrast is guaranteed — a glow would just smudge the type
  // (dark ink + heavy black halo on a cream plate looked dirty).
  const heroShadow = compact
    ? "none"
    : isLight
      ? "0 1px 2px rgba(0,0,0,0.06)"
      : undefined;

  // Hero type voice — from the selected poster style template, with a
  // layout-based fallback. One element, reused by every layout below.
  const voice = voiceFor(stylePreset, effLayout);
  // Masthead: serif voice anchored top = the "elevate your VISION" reference
  // structure — centered italic eyebrow, huge serif, details row below.
  const masthead = voice === "serif" && effLayout === "top";
  const heroEl = (() => {
    switch (voice) {
      case "campaign":
        return <CampaignHero text={heroText} size={Math.round((isHeroShort ? 80 : 52) * cs * scale)} color={ink} shadow={heroShadow} />;
      case "echo":
        return <EchoHero text={heroText} size={Math.round((isHeroShort ? 72 : 50) * cs * scale)} gold={brandGold} echoes={!compact} />;
      case "minimal":
        return <CleanHero text={heroText} size={Math.round((isHeroShort ? 74 : 50) * cs * scale)} color={ink} gold={brandGold} shadow={heroShadow} />;
      case "spec":
        return <SpecHero text={heroText} size={Math.round((isHeroShort ? 64 : 44) * cs * scale)} scale={scale} color={ink} line={isLight ? "rgba(27,24,34,0.5)" : "rgba(255,255,255,0.55)"} shadow={heroShadow} />;
      default:
        return (
          <SerifHero
            text={heroText}
            size={Math.round((isHeroShort ? (masthead ? 112 : effLayout === "center" ? 98 : 92) : (effLayout === "center" || masthead ? 64 : 60)) * cs * scale)}
            gold={brandGold}
            color={ink}
            font={masthead ? BODONI : FRAUNCES}
            weight={effLayout === "center" ? 560 : masthead ? 700 : 650}
            lineHeight={effLayout === "center" || masthead ? 1.02 : 1.06}
            shadow={heroShadow ?? (effLayout === "center"
              ? "0 2px 40px rgba(0,0,0,0.8), 0 0 80px rgba(0,0,0,0.4)"
              : undefined)}
          />
        );
    }
  })();

  // Editorial furniture — shown on the considered, light-on-type voices
  // (spec / minimal / masthead) where the layout benefits from a header
  // device. Never in compact mode (the plate is the whole lockup there).
  const showFurniture =
    !compact &&
    (voice === "spec" || voice === "minimal" || masthead) &&
    Boolean((brandTag && brandTag.trim()) || posterIndex > 0);
  const furnitureEl = showFurniture ? (
    <Furniture
      brandTag={(brandTag || "").toUpperCase()}
      idx={posterIndex}
      total={posterTotal}
      scale={scale}
      color={inkTag}
      line={isLight ? "rgba(27,24,34,0.35)" : "rgba(255,255,255,0.4)"}
    />
  ) : null;

  // Compact lockup plate — solid inverted block behind the small headline so
  // it reads on ANY background without washing the art (bare small text over
  // photos lacked contrast).
  const heroBlock = compact ? (
    <div
      style={{
        display: "inline-block",
        background: isLight ? "#17151d" : "rgba(247,243,236,0.97)",
        padding: `${Math.round(12 * scale)}px ${Math.round(18 * scale)}px`,
        boxShadow: "0 6px 28px rgba(0,0,0,0.25)",
      }}
    >
      {heroEl}
    </div>
  ) : heroEl;

  // The single supporting line — quiet by design so the product stays the
  // hero. Soft italic serif for the human tagline; if it's the all-caps
  // product line instead, drop the italic so it doesn't look broken.
  const subLineIsCaps = subLine === subLine.toUpperCase() && /[A-Z]/.test(subLine);
  const subLineStyle: React.CSSProperties = subLineIsCaps
    ? {
        fontFamily: ARCHIVO,
        fontWeight: 600,
        fontSize: Math.round(16 * scale),
        letterSpacing: "0.22em",
        textTransform: "uppercase" as const,
        color: inkSub,
        lineHeight: 1.5,
      }
    : {
        fontFamily: FRAUNCES,
        fontStyle: "italic",
        fontWeight: 400,
        fontSize: Math.round(22 * scale),
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
          {/* position:absolute so objectFit:cover fills the whole frame — as an
              in-flow flex child of AbsoluteFill, height:100% wouldn't resolve and
              the photo left blank bands (worst on tall 9:16). */}
          <Img src={bg} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ background: fallbackBg }} />
      )}
      {/* Corner vignette — dark tone only, scaled by busyness; clean art
          stays unobstructed */}
      {!isLight && (
        <AbsoluteFill
          style={{ background: `radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,${sa(0.4)}) 100%)` }}
        />
      )}
    </>
  );

  // ── Logo ────────────────────────────────────────────────────────────────
  // ALWAYS full colour (the gold mark is the brand — never recolour/monochrome
  // it). On light tone the logo's white lettering would vanish on cream, so a
  // tight dark edge-shadow gives the white type a crisp outline without
  // touching its colour; dark tone keeps the soft glow it already had.
  const logoShadow = isLight
    ? "drop-shadow(0 0 1px rgba(0,0,0,0.7)) drop-shadow(0 0 2px rgba(0,0,0,0.55)) drop-shadow(0 1px 3px rgba(0,0,0,0.4)) drop-shadow(0 2px 12px rgba(0,0,0,0.16))"
    : "drop-shadow(0 3px 18px rgba(0,0,0,0.7)) drop-shadow(0 1px 4px rgba(0,0,0,0.5))";
  const logoAlpha = 1;
  const logoEl = logo ? (
    <div style={{ position: "absolute", ...LOGO_POS[effLogoPos], margin: inset, opacity: fadeInLate * logoAlpha }}>
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
        {hasText && (
          <>
            {/* Localized blur under the text — softens the busy detail right
                behind the type so it POPS, without darkening or flattening the
                rest of the photo (keeps the product/face as the emphasis). */}
            <AbsoluteFill
              style={{
                backdropFilter: `blur(${Math.round(13 * scale)}px)`,
                WebkitBackdropFilter: `blur(${Math.round(13 * scale)}px)`,
                WebkitMaskImage: "linear-gradient(180deg, transparent 46%, #000 68%)",
                maskImage: "linear-gradient(180deg, transparent 46%, #000 68%)",
              }}
            />
            {/* Guaranteed contrast floor — a soft tone-matched gradient at the
                very bottom so the type is always legible even over clean art:
                light wash under dark ink, dark wash under white type. */}
            <AbsoluteFill
              style={{ background: isLight
                ? "linear-gradient(180deg, transparent 54%, rgba(244,241,235,0.34) 78%, rgba(244,241,235,0.72) 100%)"
                : "linear-gradient(180deg, transparent 52%, rgba(0,0,0,0.30) 76%, rgba(0,0,0,0.62) 100%)" }}
            />
          </>
        )}
        {/* Bottom scrim — frosted panel scaled to how busy the band is */}
        <AbsoluteFill
          style={{ background: `linear-gradient(180deg, transparent 35%, rgba(${scrimRGB},${sa(0.72)}) 60%, rgba(${scrimRGB},${sa(0.97)}) 100%)` }}
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
            {furnitureEl}
            {!compact && !subLine && (
              <AccentRule scale={scale} brandRed={brandRed} brandGold={brandGold} />
            )}
            {heroBlock}
            {!compact && subLine && (
              <div style={{ ...subLineStyle, marginTop: Math.round(12 * scale) }}>
                {subLine}
              </div>
            )}
            {(ctaTag || promoTag) && (
              <div style={{ marginTop: Math.round(20 * scale), display: "flex", gap: Math.round(12 * scale), alignItems: "flex-start" }}>
                {promoTag && <PromoBadge text={promoTag} brandRed={brandRed} scale={scale} opacity={fadeInLate} />}
                {ctaTag && <CtaChip text={ctaTag} brandGold={brandGold} scale={scale} opacity={fadeInLate} />}
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
        {/* Top scrim — solid at the very top, fades to transparent. Light tone
            gets a stronger, longer band so masthead type reads like it sits on
            a clean wall (per the reference), not on the photo. Scaled by the
            band's measured busyness — clean art keeps showing through. */}
        <AbsoluteFill
          style={{ background: isLight
            ? `linear-gradient(180deg, rgba(${scrimRGB},${sa(0.97)}) 0%, rgba(${scrimRGB},${sa(0.82)}) 24%, transparent 48%)`
            : `linear-gradient(180deg, rgba(${scrimRGB},${sa(0.97)}) 0%, rgba(${scrimRGB},${sa(0.72)}) 30%, transparent 58%)` }}
        />
        {/* Subtle bottom fade so logo / bottom CTA read if present — gentler
            on portraits so the model's chin/neck isn't swallowed */}
        <AbsoluteFill
          style={{ background: `linear-gradient(180deg, transparent ${isPortrait ? 82 : 75}%, rgba(${scrimRGB},${sa(isPortrait ? 0.38 : 0.55)}) 100%)` }}
        />
        {/* Logo: mirror position to bottom when layout is top — keeps it away from the text */}
        {logo && (
          <div style={{
            position: "absolute",
            bottom: 0, right: 0,
            margin: inset, opacity: fadeInLate * logoAlpha,
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
            {furnitureEl}
            {/* Masthead eyebrow — the single support line sits ABOVE the big
                type as a small italic serif (the "elevate your VISION" look). */}
            {masthead && !compact && subLine && (
              <div style={{
                fontFamily: FRAUNCES,
                fontStyle: "italic",
                fontWeight: 400,
                fontSize: Math.round(26 * scale),
                color: inkTag,
                marginBottom: Math.round(2 * scale),
                fontVariationSettings: '"SOFT" 60, "WONK" 0',
              }}>
                {subLine}
              </div>
            )}
            {heroBlock}
            {!masthead && !compact && (
              <div style={{ marginTop: Math.round(14 * scale) }}>
                <AccentRule scale={scale} brandRed={brandRed} brandGold={brandGold} mb={0} />
              </div>
            )}
            {/* Non-masthead top: single quiet support line below the hero. */}
            {!masthead && !compact && subLine && (
              <div style={{ ...subLineStyle, marginTop: Math.round(14 * scale) }}>
                {subLine}
              </div>
            )}
            {(ctaTag || promoTag) && (
              <div style={{ marginTop: Math.round(16 * scale), display: "flex", gap: Math.round(12 * scale), alignItems: "flex-start", justifyContent: masthead ? "center" : "flex-start" }}>
                {promoTag && <PromoBadge text={promoTag} brandRed={brandRed} scale={scale} opacity={fadeInLate} />}
                {ctaTag && <CtaChip text={ctaTag} brandGold={brandGold} scale={scale} opacity={fadeInLate} />}
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
      {/* Directional contrast wash — left-weighted so the text column reads.
          Scaled by busyness so clean art isn't needlessly washed out. */}
      <AbsoluteFill
        style={{ background: isLight
          ? `linear-gradient(105deg, rgba(255,255,255,${sa(0.66)}) 0%, transparent 55%, rgba(255,255,255,${sa(0.3)}) 100%)`
          : `linear-gradient(105deg, rgba(0,0,0,${sa(0.62)}) 0%, transparent 55%, rgba(0,0,0,${sa(0.28)}) 100%)` }}
      />
      {/* Subtle full-frame wash that animates in */}
      <AbsoluteFill style={{ background: isLight
        ? `rgba(248,246,241,${overlayOpacity * 0.8 * scrimScale})`
        : `rgba(0,0,0,${overlayOpacity * scrimScale})` }} />
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
          {(ctaTag || promoTag) && (
            <div style={{ display: "flex", gap: Math.round(12 * scale), alignItems: "center", marginBottom: Math.round(18 * scale) }}>
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
                  opacity: fadeInLate,
                }}>{ctaTag}</div>
              )}
              {promoTag && <PromoBadge text={promoTag} brandRed={brandRed} scale={scale} opacity={fadeInLate} />}
            </div>
          )}
          {heroBlock}
          {/* One quiet support line below the headline. The left brand bar is
              the only accent — the gold rule that also sat here was redundant. */}
          {!compact && subLine && (
            <div style={{ ...subLineStyle, marginTop: Math.round(16 * scale) }}>
              {subLine}
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
