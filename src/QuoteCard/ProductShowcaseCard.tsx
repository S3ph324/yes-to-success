import {
  AbsoluteFill,
  Img,
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
// Product Showcase Card — 3 bold layout variants.
//
//  "bottom"  (default): deep gradient bottom panel, headline/tagline/CTA
//  "top":    inverted — gradient at top, text block at top, photo hero below
//  "center": magazine editorial — text block centered vertically, full overlay
//
// When a short `headline` prop is provided (2-5 words) it renders HUGE as the
// typographic hero; `productLine` drops to a smaller descriptor below it.
// Without `headline`, `productLine` is the headline at full 58px scale.
// ─────────────────────────────────────────────────────────────────────────

export const productShowcaseCardSchema = z.object({
  productLine: z.string().default(""),
  tagline: z.string().default(""),
  ctaTag: z.string().default(""),
  headline: z.string().default(""),          // short punchy AI hook (optional)
  layout: z.enum(["bottom", "top", "center"]).default("bottom"),
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

/** CTA chip */
const CtaChip: React.FC<{ text: string; brandGold: string; scale: number; opacity: number }> = ({
  text, brandGold, scale, opacity,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      padding: `${Math.round(8 * scale)}px ${Math.round(22 * scale)}px`,
      background: brandGold,
      color: "#15120a",
      borderRadius: 999,
      fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
      fontWeight: 800,
      fontSize: Math.round(18 * scale),
      letterSpacing: "0.13em",
      textTransform: "uppercase" as const,
      marginBottom: Math.round(14 * scale),
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
  bgSrc,
  brandGold,
  brandRed,
  logoSrc,
  logoPosition,
  logoSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

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

  const heroSize   = isHeroShort
    ? Math.round(72 * scale)   // short hook → big impact
    : Math.round(54 * scale);  // longer line → readable
  const subSize    = Math.round(26 * scale);
  const extraSize  = Math.round(22 * scale);

  const hasText = Boolean(heroText);

  // ── Background ──────────────────────────────────────────────────────────
  const heroBg = (
    <>
      {bg ? (
        <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
          <Img src={bg} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{ background: "radial-gradient(ellipse at 50% 35%, #2e2e36 0%, #080810 100%)" }}
        />
      )}
      {/* Corner vignette */}
      <AbsoluteFill
        style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.4) 100%)" }}
      />
    </>
  );

  // ── Logo ────────────────────────────────────────────────────────────────
  const logoEl = logo ? (
    <div style={{ position: "absolute", ...LOGO_POS[logoPosition], margin: inset, opacity: fadeInLate }}>
      <Img
        src={logo}
        style={{
          height: logoH, width: "auto", objectFit: "contain",
          filter: "drop-shadow(0 3px 18px rgba(0,0,0,0.7)) drop-shadow(0 1px 4px rgba(0,0,0,0.5))",
        }}
      />
    </div>
  ) : null;

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: "bottom" — deep gradient panel at bottom (classic poster)
  // ─────────────────────────────────────────────────────────────────────────
  if (layout === "bottom") {
    return (
      <AbsoluteFill style={{ background: "#0a0a0c", overflow: "hidden" }}>
        {heroBg}
        {/* Bottom scrim */}
        <AbsoluteFill
          style={{ background: "linear-gradient(180deg, transparent 35%, rgba(8,6,12,0.72) 60%, rgba(8,6,12,0.97) 100%)" }}
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
            <AccentRule scale={scale} brandRed={brandRed} brandGold={brandGold} />
            {ctaTag && <CtaChip text={ctaTag} brandGold={brandGold} scale={scale} opacity={fadeInLate} />}
            <div style={{
              fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
              fontWeight: 800, fontSize: heroSize, color: "#FFFFFF",
              letterSpacing: isHeroShort ? "-0.025em" : "-0.018em",
              lineHeight: 1.08, textShadow: "0 3px 28px rgba(0,0,0,0.75)",
            }}>{heroText}</div>
            {subText && (
              <div style={{
                fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
                fontWeight: 400, fontSize: subSize,
                color: "rgba(255,255,255,0.78)",
                marginTop: Math.round(10 * scale),
                letterSpacing: "0.006em", lineHeight: 1.4,
              }}>{subText}</div>
            )}
            {extraTagline && (
              <div style={{
                fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
                fontWeight: 300, fontSize: extraSize,
                color: "rgba(255,255,255,0.55)",
                marginTop: Math.round(6 * scale),
                letterSpacing: "0.01em", lineHeight: 1.4,
              }}>{extraTagline}</div>
            )}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: "top" — gradient panel at top, text above, photo hero below
  // ─────────────────────────────────────────────────────────────────────────
  if (layout === "top") {
    return (
      <AbsoluteFill style={{ background: "#0a0a0c", overflow: "hidden" }}>
        {heroBg}
        {/* Top scrim — darker at the very top, fades to transparent */}
        <AbsoluteFill
          style={{ background: "linear-gradient(180deg, rgba(6,4,10,0.97) 0%, rgba(6,4,10,0.72) 30%, transparent 58%)" }}
        />
        {/* Subtle bottom fade so logo / bottom CTA read if present */}
        <AbsoluteFill
          style={{ background: "linear-gradient(180deg, transparent 75%, rgba(6,4,10,0.55) 100%)" }}
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
              filter: "drop-shadow(0 3px 18px rgba(0,0,0,0.7))",
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
            }}
          >
            {ctaTag && <CtaChip text={ctaTag} brandGold={brandGold} scale={scale} opacity={fadeInLate} />}
            <div style={{
              fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
              fontWeight: 800, fontSize: heroSize, color: "#FFFFFF",
              letterSpacing: isHeroShort ? "-0.025em" : "-0.018em",
              lineHeight: 1.08, textShadow: "0 4px 32px rgba(0,0,0,0.9)",
            }}>{heroText}</div>
            <AccentRule scale={scale} brandRed={brandRed} brandGold={brandGold} mb={0} />
            {subText && (
              <div style={{
                fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
                fontWeight: 400, fontSize: subSize,
                color: "rgba(255,255,255,0.80)",
                marginTop: Math.round(12 * scale),
                letterSpacing: "0.006em", lineHeight: 1.4,
              }}>{subText}</div>
            )}
            {extraTagline && (
              <div style={{
                fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
                fontWeight: 300, fontSize: extraSize,
                color: "rgba(255,255,255,0.55)",
                marginTop: Math.round(6 * scale),
                letterSpacing: "0.01em", lineHeight: 1.4,
              }}>{extraTagline}</div>
            )}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYOUT: "center" — magazine editorial, text centered vertically
  // ─────────────────────────────────────────────────────────────────────────
  // Full-frame overlay at 50% + text block centered with a frosted strip.
  const overlayOpacity = interpolate(frame, [0, 30], [0.2, 0.65], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ background: "#0a0a0c", overflow: "hidden" }}>
      {heroBg}
      {/* Directional vignette — darker on left for text contrast */}
      <AbsoluteFill
        style={{ background: "linear-gradient(105deg, rgba(0,0,0,0.62) 0%, transparent 55%, rgba(0,0,0,0.28) 100%)" }}
      />
      {/* Subtle full-frame darkening overlay that animates in */}
      <AbsoluteFill style={{ background: `rgba(0,0,0,${overlayOpacity})` }} />
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
              fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
              fontWeight: 700,
              fontSize: Math.round(14 * scale),
              letterSpacing: "0.14em",
              textTransform: "uppercase" as const,
              marginBottom: Math.round(16 * scale),
              opacity: fadeInLate,
            }}>{ctaTag}</div>
          )}
          <div style={{
            fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
            fontWeight: 900,
            fontSize: isHeroShort ? Math.round(78 * scale) : Math.round(58 * scale),
            color: "#FFFFFF",
            letterSpacing: isHeroShort ? "-0.03em" : "-0.02em",
            lineHeight: 1.02,
            textShadow: "0 2px 40px rgba(0,0,0,0.8), 0 0 80px rgba(0,0,0,0.4)",
          }}>{heroText}</div>
          {/* Gold accent rule below headline */}
          <div style={{
            height: Math.round(3 * scale),
            width: "45%",
            background: `linear-gradient(90deg, ${brandGold} 0%, transparent 100%)`,
            marginTop: Math.round(16 * scale),
            marginBottom: Math.round(14 * scale),
            borderRadius: 2,
          }} />
          {subText && (
            <div style={{
              fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
              fontWeight: 400, fontSize: subSize,
              color: "rgba(255,255,255,0.82)",
              letterSpacing: "0.01em", lineHeight: 1.45,
            }}>{subText}</div>
          )}
          {extraTagline && (
            <div style={{
              fontFamily: "system-ui,-apple-system,'Helvetica Neue',sans-serif",
              fontWeight: 300, fontSize: extraSize,
              color: "rgba(255,255,255,0.55)",
              marginTop: Math.round(8 * scale),
              letterSpacing: "0.012em", lineHeight: 1.45,
            }}>{extraTagline}</div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
