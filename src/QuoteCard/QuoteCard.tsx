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
  layoutForAspect,
  quoteFontSize,
} from "./aspect";

export const quoteCardSchema = z.object({
  quote: z.string(),
  signoff: z.string().default("— John Calub"),
  subtitle: z.string().default("Philippines' #1 Success Coach"),
  theme: z
    .enum(["money", "mindset", "manifestation", "sales", "breakthrough"])
    .default("mindset"),
  aspectRatio: aspectRatioSchema,
  logoSrc: z.string().default("yes-to-success-logo.png"),
  brandPrimary: z.string().default("#C8001E"),
  brandDeep: z.string().default("#3A0008"),
  brandAccent: z.string().default("#FFE17A"),
  brandAccentDeep: z.string().default("#C9952B"),
  url: z.string().default("JOHNCALUBTRAINING.COM"),
});

export type QuoteCardProps = z.infer<typeof quoteCardSchema>;

export const calcMetaQuoteCard = ({
  props,
}: {
  props: QuoteCardProps;
}) => {
  const { width, height } = aspectToDimensions(
    props.aspectRatio as AspectRatio,
  );
  return { width, height, fps: 30, durationInFrames: 90 };
};

const resolveSrc = (src: string | undefined) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try {
    return staticFile(src);
  } catch {
    return null;
  }
};

export const QuoteCard: React.FC<QuoteCardProps> = ({
  quote,
  signoff,
  subtitle,
  aspectRatio,
  logoSrc,
  brandPrimary,
  brandDeep,
  brandAccent,
  brandAccentDeep,
  url,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const layout = layoutForAspect(aspectRatio as AspectRatio, height);

  const opacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });
  const lift = spring({
    frame,
    fps,
    from: 24,
    to: 0,
    durationInFrames: 36,
  });

  const fontSize = quoteFontSize(quote, aspectRatio as AspectRatio, width);
  const logoResolved = resolveSrc(logoSrc);

  // Inset border scaled to canvas
  const borderInset = Math.round(Math.min(width, height) * 0.05);

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at 50% 35%, ${brandPrimary} 0%, #7A0014 55%, ${brandDeep} 100%)`,
        fontFamily: "Georgia, 'Times New Roman', serif",
      }}
    >
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 50%, transparent 40%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: borderInset,
          border: "3px solid",
          borderImage: `linear-gradient(135deg, #FFF1B8 0%, ${brandAccent} 30%, ${brandAccentDeep} 65%, #A07417 100%) 1`,
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: borderInset + 14,
          border: `1px solid ${brandAccent}40`,
        }}
      />

      {/* logo */}
      <div
        style={{
          position: "absolute",
          top: layout.logoTop,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          opacity,
        }}
      >
        {logoResolved ? (
          <Img
            src={logoResolved}
            style={{
              height: layout.logoHeight,
              width: "auto",
              maxWidth: width * 0.76,
              objectFit: "contain",
              filter: "drop-shadow(0 6px 20px rgba(0,0,0,0.55))",
            }}
          />
        ) : (
          <div
            style={{
              fontSize: Math.round(layout.logoHeight * 0.36),
              fontWeight: 900,
              fontStyle: "italic",
              background: `linear-gradient(180deg, #FFF1B8 0%, ${brandAccent} 30%, ${brandAccentDeep} 65%, #A07417 100%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              WebkitTextFillColor: "transparent",
              letterSpacing: "0.02em",
            }}
          >
            YES TO SUCCESS!
          </div>
        )}
      </div>

      {/* quote */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: `0 ${layout.padX}px`,
          transform: `translateY(${lift}px)`,
          opacity,
        }}
      >
        <div
          style={{
            fontSize: Math.round(fontSize * 1.55),
            color: brandAccent,
            lineHeight: 0.4,
            opacity: 0.6,
            marginBottom: 20,
          }}
        >
          “
        </div>
        <div
          style={{
            fontSize,
            fontWeight: 700,
            color: "#FFF8E7",
            textAlign: "center",
            lineHeight: 1.22,
            textShadow: "0 6px 30px rgba(0,0,0,0.5)",
            maxWidth: "100%",
          }}
        >
          {quote}
        </div>
      </AbsoluteFill>

      {/* signoff */}
      <div
        style={{
          position: "absolute",
          bottom: layout.signoffBottom,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity,
        }}
      >
        <div
          style={{
            width: 160,
            height: 2,
            background: `linear-gradient(90deg, transparent 0%, ${brandAccentDeep} 50%, transparent 100%)`,
            margin: "0 auto 24px",
          }}
        />
        <div
          style={{
            fontSize: layout.signoffSize,
            fontStyle: "italic",
            background: `linear-gradient(180deg, #FFF1B8 0%, ${brandAccent} 50%, ${brandAccentDeep} 100%)`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            fontWeight: 700,
          }}
        >
          {signoff}
        </div>
        <div
          style={{
            fontSize: layout.subtitleSize,
            color: "#FFF8E7",
            marginTop: 8,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
          }}
        >
          {subtitle}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: layout.urlBottom,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: layout.urlSize,
          color: `${brandAccent}8C`,
          letterSpacing: "0.3em",
        }}
      >
        {url}
      </div>
    </AbsoluteFill>
  );
};
