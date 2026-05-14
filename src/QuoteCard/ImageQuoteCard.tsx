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

export const imageQuoteCardSchema = z.object({
  quote: z.string(),
  signoff: z.string().default("— John Calub"),
  subtitle: z.string().default("Philippines' #1 Success Coach"),
  bgSrc: z.string().default(""),
  aspectRatio: aspectRatioSchema,
  logoSrc: z.string().default("yes-to-success-logo.png"),
  brandAccent: z.string().default("#FFE17A"),
  brandAccentDeep: z.string().default("#C9952B"),
  url: z.string().default("JOHNCALUBTRAINING.COM"),
});

export type ImageQuoteCardProps = z.infer<typeof imageQuoteCardSchema>;

export const calcMetaImageQuoteCard = ({
  props,
}: {
  props: ImageQuoteCardProps;
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

export const ImageQuoteCard: React.FC<ImageQuoteCardProps> = ({
  quote,
  signoff,
  subtitle,
  bgSrc,
  aspectRatio,
  logoSrc,
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
    from: 30,
    to: 0,
    durationInFrames: 36,
  });
  const bgScale = interpolate(frame, [0, 90], [1.04, 1.0], {
    extrapolateRight: "clamp",
  });

  const fontSize = quoteFontSize(quote, aspectRatio as AspectRatio, width);
  const bg = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const cornerInset = Math.round(Math.min(width, height) * 0.045);
  const cornerSize = Math.round(Math.min(width, height) * 0.065);

  return (
    <AbsoluteFill style={{ background: "#0A0A0A", overflow: "hidden" }}>
      {bg ? (
        <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
          <Img
            src={bg}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(ellipse at 50% 35%, #4A0810 0%, #1A0204 100%)",
          }}
        />
      )}

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 30%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.92) 100%)",
        }}
      />

      {/* gold corner accents */}
      {(
        [
          { pos: { top: cornerInset, left: cornerInset }, t: true, l: true },
          { pos: { top: cornerInset, right: cornerInset }, t: true, r: true },
          {
            pos: { bottom: cornerInset, left: cornerInset },
            b: true,
            l: true,
          },
          {
            pos: { bottom: cornerInset, right: cornerInset },
            b: true,
            r: true,
          },
        ] as const
      ).map((c, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            ...c.pos,
            width: cornerSize,
            height: cornerSize,
            borderTop:
              "t" in c && c.t ? `3px solid ${brandAccent}` : "none",
            borderBottom:
              "b" in c && c.b ? `3px solid ${brandAccent}` : "none",
            borderLeft:
              "l" in c && c.l ? `3px solid ${brandAccent}` : "none",
            borderRight:
              "r" in c && c.r ? `3px solid ${brandAccent}` : "none",
            opacity: 0.7,
          }}
        />
      ))}

      {/* logo */}
      <div
        style={{
          position: "absolute",
          top: layout.logoTop,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          opacity,
        }}
      >
        {logo && (
          <Img
            src={logo}
            style={{
              height: layout.logoHeight,
              width: "auto",
              maxWidth: width * 0.78,
              objectFit: "contain",
              filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.8))",
            }}
          />
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
            fontSize,
            fontWeight: 800,
            color: "#FFFFFF",
            fontFamily: "Georgia, serif",
            textAlign: "center",
            lineHeight: 1.22,
            textShadow:
              "0 4px 24px rgba(0,0,0,0.95), 0 0 60px rgba(0,0,0,0.7)",
            letterSpacing: "-0.005em",
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
            width: 100,
            height: 2,
            background: `linear-gradient(90deg, transparent 0%, ${brandAccentDeep} 50%, transparent 100%)`,
            margin: "0 auto 20px",
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
            fontFamily: "Georgia, serif",
            fontWeight: 700,
            textShadow: "0 2px 12px rgba(0,0,0,0.6)",
          }}
        >
          {signoff}
        </div>
        <div
          style={{
            fontSize: layout.subtitleSize,
            color: "#FFF8E7",
            marginTop: 6,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            textShadow: "0 2px 8px rgba(0,0,0,0.8)",
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
          color: `${brandAccent}A0`,
          letterSpacing: "0.32em",
          textShadow: "0 2px 6px rgba(0,0,0,0.8)",
        }}
      >
        {url}
      </div>
    </AbsoluteFill>
  );
};
