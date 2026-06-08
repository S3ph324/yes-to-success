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
// Product Showcase Card — clean product-photography poster (eyeglasses
// showcase and similar). This is deliberately NOT a quote card: no hook→
// payoff overlay, no big colored word emphasis, no CTA lockup footer. The
// product photo IS the hero — branding stays small and editorial: a thin
// two-tone accent rule, a single clean product line + optional tagline, an
// optional small CTA chip, and a small logo watermark in a corner. Think
// "premium e-commerce / OOTD ad", not "motivational quote graphic".
// ─────────────────────────────────────────────────────────────────────────

export const productShowcaseCardSchema = z.object({
  // One short, clean line naming/describing the product, e.g.
  // "Aria Round — Tortoise" or "Your everyday pair, elevated."
  productLine: z.string().default(""),
  // Optional short supporting clause under the product line (one phrase).
  tagline: z.string().default(""),
  // Small CTA chip text, e.g. "SHOP NOW". Empty string hides the chip.
  ctaTag: z.string().default(""),
  bgSrc: z.string().default(""),
  aspectRatio: aspectRatioSchema,
  brandGold: z.string().default("#F5C13B"),
  brandRed: z.string().default("#E11522"),
  logoSrc: z.string().default(""),
  logoPosition: z
    .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
    .default("top-right"),
  // Fraction of canvas height. Kept small — this is a watermark, not a hero.
  logoSize: z.number().min(0.04).max(0.2).default(0.085),
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
  "top-left": { top: 0, left: 0 },
  "top-right": { top: 0, right: 0 },
  "bottom-left": { bottom: 0, left: 0 },
  "bottom-right": { bottom: 0, right: 0 },
};

export const ProductShowcaseCard: React.FC<ProductShowcaseCardProps> = ({
  productLine,
  tagline,
  ctaTag,
  bgSrc,
  // aspectRatio is consumed by calcMetaProductShowcaseCard (drives canvas
  // width/height) — the component itself derives everything from width/height
  // via useVideoConfig(), so it's intentionally not destructured here.
  brandGold,
  brandRed,
  logoSrc,
  logoPosition,
  logoSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  const opacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });
  const lift = spring({ frame, fps, from: 22, to: 0, durationInFrames: 30 });
  const bgScale = interpolate(frame, [0, 90], [1.035, 1.0], {
    extrapolateRight: "clamp",
  });

  const bg = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const inset = Math.round(Math.min(width, height) * 0.055);
  const logoH = Math.round(height * logoSize);
  const scale = width / 1080;
  const hasCaption = Boolean(productLine || tagline);

  return (
    <AbsoluteFill style={{ background: "#101010", overflow: "hidden" }}>
      {/* hero product photo — full bleed, no quote-card scrims/treatment */}
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
              "radial-gradient(ellipse at 50% 40%, #2A2A2A 0%, #0A0A0A 100%)",
          }}
        />
      )}

      {/* faint bottom scrim — only enough to keep the caption legible; never
          the wall-to-wall dark gradient a quote-card overlay needs */}
      {hasCaption && (
        <AbsoluteFill
          style={{
            background:
              "linear-gradient(180deg, rgba(0,0,0,0) 60%, rgba(0,0,0,0.50) 100%)",
          }}
        />
      )}

      {/* logo mark — small, corner, watermark — never the hero element */}
      {logo && (
        <div
          style={{
            position: "absolute",
            ...LOGO_POS[logoPosition],
            margin: inset,
            opacity: opacity * 0.92,
          }}
        >
          <Img
            src={logo}
            style={{
              height: logoH,
              width: "auto",
              objectFit: "contain",
              filter: "drop-shadow(0 4px 16px rgba(0,0,0,0.6))",
            }}
          />
        </div>
      )}

      {/* CTA chip — small pill in the opposite corner from the caption */}
      {ctaTag && (
        <div
          style={{
            position: "absolute",
            top: inset,
            left: inset,
            opacity,
            transform: `translateY(${lift * 0.6}px)`,
          }}
        >
          <div
            style={{
              padding: `${Math.round(10 * scale)}px ${Math.round(20 * scale)}px`,
              borderRadius: 999,
              border: `1.5px solid ${brandGold}`,
              background: "rgba(10,10,10,0.38)",
              backdropFilter: "blur(6px)",
              color: brandGold,
              fontFamily: "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
              fontWeight: 600,
              fontSize: Math.round(20 * scale),
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {ctaTag}
          </div>
        </div>
      )}

      {/* caption — ONE clean product line + optional supporting clause; no
          hook/payoff structure, no per-word color emphasis */}
      {hasCaption && (
        <div
          style={{
            position: "absolute",
            left: inset,
            right: inset,
            bottom: Math.round(height * 0.06),
            opacity,
            transform: `translateY(${lift}px)`,
          }}
        >
          <div
            style={{
              width: Math.round(56 * scale),
              height: 3,
              background: `linear-gradient(90deg, ${brandRed} 0%, ${brandGold} 100%)`,
              marginBottom: Math.round(16 * scale),
              borderRadius: 2,
            }}
          />
          {productLine && (
            <div
              style={{
                fontFamily:
                  "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
                fontWeight: 700,
                fontSize: Math.round(44 * scale),
                color: "#FFFFFF",
                letterSpacing: "-0.01em",
                lineHeight: 1.18,
                textShadow: "0 2px 16px rgba(0,0,0,0.55)",
              }}
            >
              {productLine}
            </div>
          )}
          {tagline && (
            <div
              style={{
                fontFamily:
                  "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
                fontWeight: 400,
                fontSize: Math.round(24 * scale),
                color: "rgba(255,255,255,0.78)",
                marginTop: Math.round(8 * scale),
                letterSpacing: "0.01em",
                lineHeight: 1.35,
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
