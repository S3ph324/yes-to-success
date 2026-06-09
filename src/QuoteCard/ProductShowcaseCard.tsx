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
// Product Showcase Card — bold poster-style eyeglasses ad.
// The AI product photo is the hero (full-bleed). Copy lives in a strong
// frosted/dark panel at the bottom — big headline, tagline, solid-gold CTA
// chip. Logo is prominent at top-right. This is deliberately NOT the old
// "quiet editorial watermark" style — it reads like a campaign poster.
// ─────────────────────────────────────────────────────────────────────────

export const productShowcaseCardSchema = z.object({
  productLine: z.string().default(""),
  tagline: z.string().default(""),
  ctaTag: z.string().default(""),
  bgSrc: z.string().default(""),
  aspectRatio: aspectRatioSchema,
  brandGold: z.string().default("#F5C13B"),
  brandRed: z.string().default("#E11522"),
  logoSrc: z.string().default(""),
  logoPosition: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
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
  "top-left":     { top: 0, left: 0 },
  "top-right":    { top: 0, right: 0 },
  "bottom-left":  { bottom: 0, left: 0 },
  "bottom-right": { bottom: 0, right: 0 },
};

export const ProductShowcaseCard: React.FC<ProductShowcaseCardProps> = ({
  productLine,
  tagline,
  ctaTag,
  bgSrc,
  brandGold,
  brandRed,
  logoSrc,
  logoPosition,
  logoSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // Animation
  const fadeIn = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const lift = spring({ frame, fps, from: 28, to: 0, durationInFrames: 32 });
  const bgScale = interpolate(frame, [0, 90], [1.04, 1.0], {
    extrapolateRight: "clamp",
  });
  // CTA / logo animate in slightly later for a staggered feel
  const fadeInLate = interpolate(frame, [10, 30], [0, 1], {
    extrapolateRight: "clamp",
  });

  const bg   = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const scale  = width / 1080;
  const inset  = Math.round(Math.min(width, height) * 0.052);
  const logoH  = Math.round(height * logoSize);

  const hasCaption = Boolean(productLine || tagline);

  // Bottom panel covers ~38% of frame height — the region where all text lives.
  const panelH = Math.round(height * 0.38);

  return (
    <AbsoluteFill style={{ background: "#0a0a0c", overflow: "hidden" }}>

      {/* ── Hero background ── */}
      {bg ? (
        <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
          <Img
            src={bg}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(ellipse at 50% 35%, #2e2e36 0%, #080810 100%)",
          }}
        />
      )}

      {/* ── Full-frame vignette — darkens corners for depth ── */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.45) 100%)",
        }}
      />

      {/* ── Bottom poster panel ──
           Two-layer approach: a deep gradient from mid-frame down, plus a
           solid-ish strip at the very bottom so type always reads cleanly. */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, transparent 38%, rgba(8,6,12,0.72) 62%, rgba(8,6,12,0.96) 100%)",
        }}
      />

      {/* ── Logo — prominent, top corner ── */}
      {logo && (
        <div
          style={{
            position: "absolute",
            ...LOGO_POS[logoPosition],
            margin: inset,
            opacity: fadeInLate,
          }}
        >
          <Img
            src={logo}
            style={{
              height: logoH,
              width: "auto",
              objectFit: "contain",
              filter:
                "drop-shadow(0 3px 18px rgba(0,0,0,0.7)) drop-shadow(0 1px 4px rgba(0,0,0,0.5))",
            }}
          />
        </div>
      )}

      {/* ── Bottom caption zone ── */}
      {hasCaption && (
        <div
          style={{
            position: "absolute",
            left: inset,
            right: inset,
            bottom: Math.round(height * 0.055),
            opacity: fadeIn,
            transform: `translateY(${lift}px)`,
          }}
        >
          {/* Accent rule — spans full text column, red→gold gradient */}
          <div
            style={{
              height: Math.round(4 * scale),
              background: `linear-gradient(90deg, ${brandRed} 0%, ${brandGold} 55%, transparent 100%)`,
              marginBottom: Math.round(18 * scale),
              borderRadius: 2,
            }}
          />

          {/* CTA chip — solid gold, placed ABOVE headline for poster rhythm */}
          {ctaTag && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: `${Math.round(8 * scale)}px ${Math.round(22 * scale)}px`,
                background: brandGold,
                color: "#15120a",
                borderRadius: 999,
                fontFamily:
                  "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
                fontWeight: 800,
                fontSize: Math.round(18 * scale),
                letterSpacing: "0.13em",
                textTransform: "uppercase",
                marginBottom: Math.round(16 * scale),
                boxShadow: `0 4px 24px rgba(0,0,0,0.4)`,
              }}
            >
              {ctaTag}
            </div>
          )}

          {/* Main product headline — poster-scale, heavy weight */}
          {productLine && (
            <div
              style={{
                fontFamily:
                  "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
                fontWeight: 800,
                fontSize: Math.round(58 * scale),
                color: "#FFFFFF",
                letterSpacing: "-0.018em",
                lineHeight: 1.1,
                textShadow: "0 3px 28px rgba(0,0,0,0.75)",
              }}
            >
              {productLine}
            </div>
          )}

          {/* Tagline — secondary line, smaller but still confident */}
          {tagline && (
            <div
              style={{
                fontFamily:
                  "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
                fontWeight: 400,
                fontSize: Math.round(27 * scale),
                color: "rgba(255,255,255,0.82)",
                marginTop: Math.round(10 * scale),
                letterSpacing: "0.008em",
                lineHeight: 1.4,
              }}
            >
              {tagline}
            </div>
          )}
        </div>
      )}
    </AbsoluteFill>
  );
};
