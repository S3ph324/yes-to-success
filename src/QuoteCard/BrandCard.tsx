import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Img,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { AspectRatio, aspectRatioSchema, aspectToDimensions } from "./aspect";

// ─────────────────────────────────────────────────────────────────────────
// Brand Card — "brand-a-photo": take ONE eyeglasses photo (the real upload, a
// cleaned-up version, or an AI re-shoot — decided upstream by the render
// script) and composite Tranzzie branding (a tagline + optional logo) onto it,
// in one of four switchable layouts. Deliberately light and flexible — the
// image can be the actual photo, unlike the TikTok Shop cards.
// ─────────────────────────────────────────────────────────────────────────

export const BRAND_LAYOUTS = ["minimal", "banner", "editorial", "badge", "custom"] as const;
export type BrandLayout = (typeof BRAND_LAYOUTS)[number];

// ── Custom layout ─────────────────────────────────────────────────────────
// "custom" is driven by a layoutSpec extracted from a reference image the user
// uploaded. Only the reference's TEXT GEOMETRY AND TYPOGRAPHY is carried over
// — never its photo, palette, brand or wording. Everything that actually
// renders is still Tranzzie's own colors/logo/font and the user's own photo
// and copy. The spec arrives pre-clamped from the server; the defaults here
// are a second net so a missing field can never blank the card.
export const BRAND_ANCHORS = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;
export type BrandAnchor = (typeof BRAND_ANCHORS)[number];

export const BRAND_FONT_CLASSES = [
  "sans", "serif", "slab", "mono", "condensed-sans", "display-serif", "script",
] as const;
export type BrandFontClass = (typeof BRAND_FONT_CLASSES)[number];

// Text effects lifted from the reference. Colours are NEVER sampled from it —
// strokeColor/shadow/highlight resolve to Tranzzie's own gold / white / dark.
export const layoutEffectsSchema = z.object({
  strokeWidthEm: z.number().default(0),
  strokeColor: z.enum(["brand", "light", "dark"]).default("light"),
  shadow: z.enum(["none", "soft", "hard-offset", "long"]).default("none"),
  shadowOffsetEm: z.number().default(0.04),
  shadowBlurEm: z.number().default(0.06),
  fill: z.enum(["solid", "outline-only", "gradient"]).default("solid"),
  underline: z.enum(["none", "single", "thick"]).default("none"),
  highlight: z.enum(["none", "marker", "box"]).default("none"),
  opacity: z.number().default(1),
});
export type LayoutEffects = z.infer<typeof layoutEffectsSchema>;
export const DEFAULT_EFFECTS: LayoutEffects = {
  strokeWidthEm: 0, strokeColor: "light", shadow: "none", shadowOffsetEm: 0.04,
  shadowBlurEm: 0.06, fill: "solid", underline: "none", highlight: "none", opacity: 1,
};

export const layoutBlockSchema = z.object({
  role: z.enum(["tagline", "productName", "brandName", "establishedTag"]).default("tagline"),
  anchor: z.enum(BRAND_ANCHORS).default("bottom-left"),
  // Typeface CHARACTER, classified onto axes we can map onto faces we own —
  // never an attempt to name the reference's actual font.
  fontFamily: z.enum(BRAND_FONT_CLASSES).default("sans"),
  fontStyle: z.enum(["normal", "italic"]).default("normal"),
  widthClass: z.enum(["condensed", "normal", "extended"]).default("normal"),
  contrast: z.enum(["low", "medium", "high"]).default("low"),
  effects: layoutEffectsSchema.optional(),
  xPct: z.number().default(6),
  yPct: z.number().default(88),
  maxWidthPct: z.number().default(80),
  align: z.enum(["left", "center", "right"]).default("left"),
  /** Cap height as a fraction of canvas height. */
  fontScale: z.number().default(0.05),
  weight: z.number().default(800),
  case: z.enum(["upper", "title", "as-is"]).default("as-is"),
  trackingEm: z.number().default(0),
  lineHeight: z.number().default(1.15),
  rotationDeg: z.number().default(0),
  /** Phase 1 renders "behind-subject" as "above-photo" (no cutout yet). */
  zOrder: z.enum(["above-photo", "behind-subject"]).default("above-photo"),
  scrim: z.enum(["none", "gradient", "solid-bar", "blur"]).default("none"),
  scrimOpacity: z.number().default(0),
});
export type LayoutBlock = z.infer<typeof layoutBlockSchema>;

export const layoutSpecSchema = z
  .object({
    textBlocks: z.array(layoutBlockSchema).default([]),
    logo: z
      .object({
        anchor: z.enum(BRAND_ANCHORS).default("top-left"),
        xPct: z.number().default(6),
        yPct: z.number().default(6),
        scalePct: z.number().default(12),
      })
      .nullable()
      .default(null),
    notes: z.string().default(""),
  })
  .nullable()
  .default(null);
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;

export const brandCardSchema = z.object({
  photoSrc: z.string().default(""),
  tagline: z.string().default(""),
  productName: z.string().default(""),
  logoSrc: z.string().default(""),
  showLogo: z.boolean().default(true),
  layout: z.enum(BRAND_LAYOUTS).default("minimal"),
  layoutSpec: layoutSpecSchema,
  brandGold: z.string().default("#F4B400"),
  brandName: z.string().default("Tranzzie Eyeglasses"),
  establishedTag: z.string().default("SINCE 2019"),
  aspectRatio: aspectRatioSchema,
});

export type BrandCardProps = z.infer<typeof brandCardSchema>;

export const calcMetaBrandCard = ({ props }: { props: BrandCardProps }) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 60 };
};

const ARCHIVO = "'Archivo','Helvetica Neue',Arial,sans-serif";

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

// ── Typeface classes → the faces we actually ship ─────────────────────────
// public/fonts holds Archivo (wght 100-900 + a real wdth 62-125 axis),
// Fraunces (wght + SOFT/WONK, with a true italic file), Bodoni Moda (didone,
// true italic file), Montserrat and Sacramento. So most classes map to a real
// face; the two that cannot are flagged as approximations rather than being
// silently swapped:
//   slab  -> Fraunces with its softness/wonk dialled out (no true slab face)
//   mono  -> the CSS generic monospace (no mono face on disk)
// Archivo has no italic file, so italic on a sans class is a synthesized
// oblique. The dashboard summary surfaces all three of these to the user.
const FRAUNCES = "'Fraunces',Georgia,serif";
const BODONI = "'Bodoni Moda','Fraunces',Georgia,serif";
const SACRAMENTO = "'Sacramento',cursive";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

type Typeface = { stack: string; varSettings?: string; widthAxis: boolean };
const resolveTypeface = (family: BrandFontClass, contrast: string): Typeface => {
  switch (family) {
    case "serif":
      // Extreme stroke contrast reads as a didone, so let contrast pick it.
      return contrast === "high"
        ? { stack: BODONI, varSettings: "'opsz' 72", widthAxis: false }
        : { stack: FRAUNCES, varSettings: "'SOFT' 30, 'WONK' 1, 'opsz' 90", widthAxis: false };
    case "display-serif":
      return { stack: BODONI, varSettings: "'opsz' 96", widthAxis: false };
    case "slab":
      return { stack: FRAUNCES, varSettings: "'SOFT' 0, 'WONK' 0, 'opsz' 144", widthAxis: false };
    case "script":
      return { stack: SACRAMENTO, widthAxis: false };
    case "mono":
      return { stack: MONO, widthAxis: false };
    case "condensed-sans":
    case "sans":
    default:
      return { stack: ARCHIVO, widthAxis: true };
  }
};

const useBrandFonts = () => {
  const [handle] = useState(() => delayRender("load-brand-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" }),
      new FontFace("Fraunces", `url(${staticFile("fonts/Fraunces.ttf")}) format("truetype")`, { weight: "100 900", style: "normal" }),
      new FontFace("Fraunces", `url(${staticFile("fonts/Fraunces-Italic.ttf")}) format("truetype")`, { weight: "100 900", style: "italic" }),
      new FontFace("Bodoni Moda", `url(${staticFile("fonts/BodoniModa.ttf")}) format("truetype")`, { weight: "400 900", style: "normal" }),
      new FontFace("Bodoni Moda", `url(${staticFile("fonts/BodoniModa-Italic.ttf")}) format("truetype")`, { weight: "400 900", style: "italic" }),
      new FontFace("Montserrat", `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`, { weight: "100 900" }),
      new FontFace("Sacramento", `url(${staticFile("fonts/Sacramento.ttf")}) format("truetype")`, { weight: "400" }),
    ];
    // One slow/missing face must not hang the render, so settle rather than all.
    Promise.allSettled(
      faces.map((f) => f.load().then((l) => { document.fonts.add(l); })),
    ).then(() => continueRender(handle)).catch(() => continueRender(handle));
  }, [handle]);
};

// Tranzzie laurel-glasses mark (fallback when there is no logo file).
const BrandMark: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const s = (w = 2) => ({ fill: "none", stroke: color, strokeWidth: w, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });
  return (
    <svg viewBox="0 0 120 60" width={size} height={size * 0.5} style={{ display: "block" }}>
      <path d="M18 30c-8-2-12-8-12-8s5-1 9 2M18 38c-8 0-13-4-13-4s5-3 10-2M22 22c-7-4-9-11-9-11s5 1 8 5" {...s(2)} />
      <path d="M102 30c8-2 12-8 12-8s-5-1-9 2M102 38c8 0 13-4 13-4s-5-3-10-2M98 22c7-4 9-11 9-11s-5 1-8 5" {...s(2)} />
      <path d="M30 28c0-6 6-9 12-9s12 3 12 11-5 12-12 12-12-6-12-14z" {...s(3)} />
      <path d="M66 30c0-8 5-11 12-11s12 3 12 9-6 14-12 14-12-6-12-12z" {...s(3)} />
      <path d="M54 26h12" {...s(3)} />
    </svg>
  );
};

export const BrandCard: React.FC<BrandCardProps> = ({
  photoSrc, tagline, productName, logoSrc, showLogo, layout, layoutSpec, brandGold, brandName, establishedTag,
}) => {
  useBrandFonts();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(width * 0.06);
  const gold = brandGold;
  const DARK = "#141210";
  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const rise = interpolate(frame, [4, 22], [Math.round(24 * scale), 0], { extrapolateRight: "clamp" });
  const tShadow = "0 2px 14px rgba(0,0,0,0.6)";

  const photo = resolveSrc(photoSrc);
  const logo = resolveSrc(logoSrc);
  const tagSize = tagline.length > 80 ? 34 : tagline.length > 48 ? 40 : 48;

  const logoEl = (size: number, tone: "light" | "dark") => {
    if (!showLogo) return null;
    if (logo) return <Img src={logo} style={{ height: size, width: "auto", objectFit: "contain", filter: tone === "light" ? "drop-shadow(0 2px 12px rgba(0,0,0,0.5))" : "none" }} />;
    return <BrandMark size={Math.round(size * 1.5)} color={tone === "light" ? "#fff" : DARK} />;
  };

  const cover = (fit: "cover" | "contain" = "cover") =>
    photo ? (
      <Img src={photo} style={{ width: "100%", height: "100%", objectFit: fit }} />
    ) : (
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontFamily: ARCHIVO, fontSize: Math.round(22 * scale) }}>eyeglasses photo</AbsoluteFill>
    );

  const scrim = (
    <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.10) 20%, transparent 42%, transparent 52%, rgba(0,0,0,0.35) 74%, rgba(0,0,0,0.82) 100%)" }} />
  );

  const nameEl = productName ? (
    <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(17 * scale), letterSpacing: "0.3em", color: gold, textTransform: "uppercase", marginBottom: Math.round(10 * scale) }}>{productName}</div>
  ) : null;

  const establishedEl = establishedTag ? (
    <div style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(12 * scale), letterSpacing: "0.3em", color: gold, marginTop: Math.round(12 * scale), textTransform: "uppercase" }}>• {establishedTag} •</div>
  ) : null;

  // ── CUSTOM — geometry lifted from the user's reference, content is ours ────
  // Falls through to "minimal" if the spec is missing or has no usable block,
  // so a failed extraction degrades to a real card instead of an empty one.
  // These clamps mirror the server's and are the last line of defence: anchors
  // are pinned on-canvas (0..100) so no value can push the copy out of frame,
  // and fontScale/maxWidthPct have floors so it cannot shrink to nothing.
  const usableBlocks = (layoutSpec?.textBlocks ?? []).filter((b) => {
    const t = { tagline, productName, brandName, establishedTag }[b.role];
    return Boolean(t && String(t).trim());
  });
  if (layout === "custom" && usableBlocks.length > 0) {
    const clamp = (n: number, lo: number, hi: number) =>
      Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
    // An out-of-vocabulary anchor would silently behave as top-left and drag
    // the block off-frame, so normalise before using it for anything.
    const safeAnchor = (a: BrandAnchor): BrandAnchor =>
      (BRAND_ANCHORS as readonly string[]).includes(a) ? a : "bottom-left";
    const segs = (a: BrandAnchor) =>
      a === "center" ? (["center", "center"] as const) : (a.split("-") as [string, string]);
    // Anchor = which corner/edge of the block sits at (xPct, yPct).
    const anchorShift = (a: BrandAnchor) => {
      const [v, h] = segs(safeAnchor(a));
      const tx = h === "center" ? "-50%" : h === "right" ? "-100%" : "0";
      const ty = v === "center" ? "-50%" : v === "bottom" ? "-100%" : "0";
      return `translate(${tx}, ${ty})`;
    };
    // Mirrors the server's anchor-aware bounds: bound each axis by the
    // direction the box grows so the copy can never leave the frame.
    const posX = (a: BrandAnchor, x: number) => {
      const [, h] = segs(safeAnchor(a));
      return clamp(x, h === "right" ? 10 : 0, h === "left" ? 92 : 100);
    };
    const posY = (a: BrandAnchor, y: number) => {
      const [v] = segs(safeAnchor(a));
      return clamp(y, v === "bottom" ? 8 : v === "center" ? 4 : 0, v === "top" ? 88 : v === "center" ? 96 : 100);
    };
    const roleText: Record<LayoutBlock["role"], string> = {
      tagline, productName, brandName, establishedTag,
    };
    // Colors are always Tranzzie's — never sampled from the reference.
    const roleColor: Record<LayoutBlock["role"], string> = {
      tagline: "#fff",
      productName: gold,
      brandName: "rgba(255,255,255,0.88)",
      establishedTag: gold,
    };
    const blockScrim = (b: LayoutBlock) => {
      const o = clamp(b.scrimOpacity, 0, 1);
      if (b.scrim === "none" || o === 0) return {};
      if (b.scrim === "solid-bar") return { background: `rgba(20,18,16,${o})` };
      if (b.scrim === "blur") return { background: `rgba(20,18,16,${o * 0.6})`, backdropFilter: `blur(${Math.round(10 * scale)}px)` };
      return { background: `linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,${o}) 55%, rgba(0,0,0,${o}) 100%)` };
    };
    // Effect colours resolve to Tranzzie's palette only.
    const fxColor = (c: string) => (c === "brand" ? gold : c === "dark" ? DARK : "#fff");
    const lg = layoutSpec?.logo ?? null;
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {usableBlocks.map((b, i) => {
          const txt = roleText[b.role];
          // fontScale is a CAP height fraction; ~0.72 converts it to font-size.
          const fontPx = Math.round((clamp(b.fontScale, 0.015, 0.25) / 0.72) * height);
          const face = resolveTypeface(b.fontFamily, b.contrast);
          const fx = b.effects ?? DEFAULT_EFFECTS;
          const ink = roleColor[b.role];
          const strokeC = fxColor(fx.strokeColor);
          // Outline-only with no stroke would render nothing at all, so an
          // unfilled block always keeps a minimum visible outline.
          const rawStroke = clamp(fx.strokeWidthEm, 0, 0.08);
          const strokeEm = fx.fill === "outline-only" ? Math.max(0.015, rawStroke) : rawStroke;
          const offEm = clamp(fx.shadowOffsetEm, 0, 0.5);
          const blurEm = clamp(fx.shadowBlurEm, 0, 0.5);
          const shadowC = fx.shadow === "none" ? "" : "rgba(0,0,0,0.62)";
          const textShadow =
            fx.shadow === "soft" ? `0 ${offEm}em ${Math.max(blurEm, 0.08)}em ${shadowC}`
            : fx.shadow === "hard-offset" ? `${offEm}em ${offEm}em 0 ${shadowC}`
            // "long" = a stacked cast shadow, built from repeated hard offsets.
            : fx.shadow === "long" ? Array.from({ length: 8 }, (_, k) =>
                `${((k + 1) * offEm) / 2}em ${((k + 1) * offEm) / 2}em 0 ${shadowC}`).join(", ")
            : b.scrim === "none" && fx.highlight === "none" ? tShadow : "none";
          const isGradient = fx.fill === "gradient";
          const gradientStyle = isGradient
            ? { backgroundImage: `linear-gradient(180deg, ${ink} 0%, ${gold} 100%)`,
                WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }
            : {};
          return (
            <div
              key={`${b.role}-${i}`}
              style={{
                position: "absolute",
                left: `${posX(b.anchor, b.xPct)}%`,
                top: `${posY(b.anchor, b.yPct)}%`,
                width: `${clamp(b.maxWidthPct, 12, 140)}%`,
                transform: `${anchorShift(b.anchor)} rotate(${clamp(b.rotationDeg, -90, 90)}deg)`,
                transformOrigin: "center",
                textAlign: b.align,
                fontFamily: face.stack,
                fontVariationSettings: face.varSettings || undefined,
                fontStyle: b.fontStyle === "italic" ? "italic" : "normal",
                // Only Archivo carries a real width axis; asking for a stretch
                // on a face without one just does nothing rather than faking it.
                fontStretch: face.widthAxis
                  ? (b.widthClass === "condensed" ? "70%" : b.widthClass === "extended" ? "120%" : "100%")
                  : undefined,
                fontWeight: clamp(Math.round(b.weight / 100) * 100, 100, 900),
                fontSize: fontPx,
                lineHeight: clamp(b.lineHeight, 0.8, 2.2),
                letterSpacing: `${clamp(b.trackingEm, -0.05, 0.6)}em`,
                textTransform: b.case === "upper" ? "uppercase" : b.case === "title" ? "capitalize" : "none",
                color: fx.fill === "outline-only" ? "transparent" : ink,
                WebkitTextStrokeWidth: strokeEm > 0 ? `${strokeEm}em` : undefined,
                WebkitTextStrokeColor: strokeEm > 0 ? strokeC : undefined,
                textDecoration: fx.underline === "none" ? "none" : "underline",
                textDecorationThickness: fx.underline === "thick" ? "0.12em" : undefined,
                textUnderlineOffset: fx.underline === "none" ? undefined : "0.14em",
                // Floor keeps a hallucinated 0 from erasing the copy entirely.
                opacity: clamp(fx.opacity, 0.15, 1),
                textShadow: textShadow || undefined,
                padding: b.scrim === "none" ? 0 : `${Math.round(fontPx * 0.34)}px ${Math.round(fontPx * 0.44)}px`,
                ...blockScrim(b),
                ...gradientStyle,
              }}
            >
              {/* A highlight is a bar behind JUST the text, so it has to live on
                  an inline box — distinct from the block-level scrim above. */}
              {fx.highlight === "none" ? txt : (
                <span
                  style={{
                    // Marker hugs the text; box pads it out into a solid plate.
                    background: fx.highlight === "marker" ? `${gold}` : "rgba(20,18,16,0.86)",
                    color: fx.highlight === "marker" ? DARK : undefined,
                    WebkitBoxDecorationBreak: "clone",
                    boxDecorationBreak: "clone",
                    padding: fx.highlight === "marker" ? "0.02em 0.12em" : "0.12em 0.26em",
                    borderRadius: fx.highlight === "box" ? "0.06em" : 0,
                  }}
                >
                  {txt}
                </span>
              )}
            </div>
          );
        })}
        {showLogo && lg && (
          <div
            style={{
              position: "absolute",
              left: `${posX(lg.anchor, lg.xPct)}%`,
              top: `${posY(lg.anchor, lg.yPct)}%`,
              transform: anchorShift(lg.anchor),
            }}
          >
            {logoEl(Math.round((clamp(lg.scalePct, 3, 40) / 100) * height), "light")}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── MINIMAL — full-bleed photo, logo top-left, tagline bottom-left ─────────
  if (layout === "minimal" || layout === "custom") {
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}{scrim}
        {showLogo && <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(Math.round(84 * scale), "light")}</div>}
        <div style={{ position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.06), transform: `translateY(${rise}px)` }}>
          {nameEl}
          {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(tagSize * scale), color: "#fff", lineHeight: 1.12, letterSpacing: "0.005em", maxWidth: Math.round(width * 0.82), textShadow: tShadow }}>{tagline}</div>}
          <div style={{ width: Math.round(70 * scale), height: Math.round(4 * scale), background: gold, marginTop: Math.round(16 * scale) }} />
        </div>
      </AbsoluteFill>
    );
  }

  // ── BANNER — photo on top, solid brand band across the bottom ──────────────
  if (layout === "banner") {
    const bandH = Math.round(height * 0.26);
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: height - bandH }}>{cover()}</div>
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: bandH, background: DARK, borderTop: `${Math.round(4 * scale)}px solid ${gold}`, display: "flex", alignItems: "center", gap: Math.round(22 * scale), padding: `0 ${inset}px` }}>
          {showLogo && logoEl(Math.round(78 * scale), "light")}
          <div style={{ flex: 1, transform: `translateY(${rise}px)` }}>
            {nameEl}
            {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round((tagSize - 4) * scale), color: "#fff", lineHeight: 1.1 }}>{tagline}</div>}
          </div>
          {establishedTag && <div style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(12 * scale), letterSpacing: "0.28em", color: gold, whiteSpace: "nowrap", textTransform: "uppercase" }}>{establishedTag}</div>}
        </div>
      </AbsoluteFill>
    );
  }

  // ── EDITORIAL — split: photo one side, solid panel with big tagline ────────
  if (layout === "editorial") {
    const panelW = Math.round(width * 0.42);
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: width - panelW }}>{cover()}</div>
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: panelW, background: `linear-gradient(160deg, #1c1813 0%, ${DARK} 100%)`, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: inset }}>
          <div>{showLogo && logoEl(Math.round(80 * scale), "light")}</div>
          <div style={{ transform: `translateY(${rise}px)` }}>
            {nameEl}
            {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round((tagSize + 2) * scale), color: "#fff", lineHeight: 1.1 }}>{tagline}</div>}
            <div style={{ width: Math.round(60 * scale), height: Math.round(4 * scale), background: gold, marginTop: Math.round(16 * scale) }} />
          </div>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(13 * scale), letterSpacing: "0.22em", color: "rgba(255,255,255,0.8)", textTransform: "uppercase" }}>{brandName}{establishedTag ? ` · ${establishedTag}` : ""}</div>
        </div>
      </AbsoluteFill>
    );
  }

  // ── BADGE — full-bleed photo + floating rounded card (logo + tagline) ──────
  return (
    <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
      {cover()}
      <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.35) 100%)" }} />
      <div style={{ position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.06), transform: `translateY(${rise}px)` }}>
        <div style={{ background: "rgba(20,18,16,0.78)", backdropFilter: "blur(6px)", border: `1px solid rgba(255,255,255,0.14)`, borderRadius: Math.round(18 * scale), padding: `${Math.round(22 * scale)}px ${Math.round(26 * scale)}px`, display: "flex", alignItems: "center", gap: Math.round(20 * scale) }}>
          {showLogo && <div style={{ flexShrink: 0 }}>{logoEl(Math.round(72 * scale), "light")}</div>}
          <div>
            {nameEl}
            {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round((tagSize - 6) * scale), color: "#fff", lineHeight: 1.12 }}>{tagline}</div>}
            {establishedEl}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
