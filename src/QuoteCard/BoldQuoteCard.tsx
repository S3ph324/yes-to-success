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
} from "./aspect";

export const boldQuoteCardSchema = z.object({
  quote: z.string(),
  keyword: z.string().default(""),
  signoff: z.string().default("— John Calub"),
  subtitle: z.string().default("Philippines' #1 Success Coach"),
  aspectRatio: aspectRatioSchema,
  logoSrc: z.string().default("yes-to-success-logo.png"),
  brandPrimary: z.string().default("#0F0F12"),
  brandAccent: z.string().default("#FFE17A"),
  brandAccentDeep: z.string().default("#C9952B"),
  brandRed: z.string().default("#C8001E"),
  url: z.string().default("JOHNCALUBTRAINING.COM"),
});

export type BoldQuoteCardProps = z.infer<typeof boldQuoteCardSchema>;

export const calcMetaBoldQuoteCard = ({
  props,
}: {
  props: BoldQuoteCardProps;
}) => {
  const { width, height } = aspectToDimensions(
    props.aspectRatio as AspectRatio,
  );
  return { width, height, fps: 30, durationInFrames: 90 };
};

const restFontSize = (text: string, aspectRatio: AspectRatio) => {
  const len = text.length;
  const base =
    aspectRatio === "1:1" ? 0.74 : aspectRatio === "9:16" ? 1.1 : 1.0;
  if (len < 60) return Math.round(56 * base);
  if (len < 110) return Math.round(46 * base);
  if (len < 160) return Math.round(38 * base);
  return Math.round(32 * base);
};

// Height of the SVG canvas for the keyword. textLength=width-margin
// stretches the glyphs to fit horizontally.
const keywordSvgHeight = (word: string, height: number) => {
  const len = Math.max(1, word.length);
  const scale = height / 1350;
  if (len <= 4) return Math.round(280 * scale);
  if (len <= 6) return Math.round(240 * scale);
  if (len <= 8) return Math.round(210 * scale);
  if (len <= 10) return Math.round(180 * scale);
  if (len <= 12) return Math.round(160 * scale);
  return Math.round(140 * scale);
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

const splitOnKeyword = (quote: string, keyword: string) => {
  if (!keyword) return { before: quote, hit: "", after: "" };
  const idx = quote.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return { before: quote, hit: "", after: "" };
  return {
    before: quote.slice(0, idx).trim(),
    hit: quote.slice(idx, idx + keyword.length),
    after: quote.slice(idx + keyword.length).trim(),
  };
};

export const BoldQuoteCard: React.FC<BoldQuoteCardProps> = ({
  quote,
  keyword,
  signoff,
  subtitle,
  aspectRatio,
  logoSrc,
  brandPrimary,
  brandAccent,
  brandAccentDeep,
  brandRed,
  url,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const layout = layoutForAspect(aspectRatio as AspectRatio, height);

  const opacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });
  const keywordScale = spring({
    frame,
    fps,
    from: 0.85,
    to: 1,
    durationInFrames: 30,
  });

  const { before, hit, after } = splitOnKeyword(quote, keyword);
  const restSize = restFontSize(
    `${before} ${after}`,
    aspectRatio as AspectRatio,
  );
  const logo = resolveSrc(logoSrc);

  const focusWord =
    (hit || before.split(" ").slice(-1)[0] || quote.split(" ")[0])
      .replace(/[.,!?;:"']/g, "")
      .toUpperCase();

  const svgH = keywordSvgHeight(focusWord, height);
  const svgW = Math.round(width * 0.92);
  const textLen = Math.round(svgW * 0.96);

  // Positioning: place "before" text above keyword, "after" below.
  const beforeTop = Math.round(height * 0.32);
  const afterBottom = Math.round(height * 0.28);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(180deg, ${brandPrimary} 0%, #18181B 100%)`,
        fontFamily: "Georgia, serif",
      }}
    >
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 50%, rgba(255,225,122,0.05) 0%, transparent 70%)",
        }}
      />

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: Math.round(height * 0.006) + 4,
          background: `linear-gradient(90deg, ${brandRed} 0%, ${brandAccent} 50%, ${brandRed} 100%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: Math.round(height * 0.006) + 4,
          background: `linear-gradient(90deg, ${brandRed} 0%, ${brandAccent} 50%, ${brandRed} 100%)`,
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
          opacity,
        }}
      >
        {logo && (
          <Img
            src={logo}
            style={{
              height: Math.round(layout.logoHeight * 0.85),
              width: "auto",
              maxWidth: width * 0.6,
              objectFit: "contain",
            }}
          />
        )}
      </div>

      {/* before text */}
      {before && (
        <div
          style={{
            position: "absolute",
            top: beforeTop,
            left: 80,
            right: 80,
            textAlign: "center",
            fontSize: restSize,
            fontWeight: 400,
            color: "#E5E5E5",
            opacity: opacity * 0.85,
            lineHeight: 1.3,
            fontStyle: "italic",
          }}
        >
          {before}
        </div>
      )}

      {/* THE keyword (SVG with textLength = bulletproof fit) */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          opacity,
          transform: `scale(${keywordScale})`,
        }}
      >
        <svg
          width={svgW}
          height={svgH}
          viewBox={`0 0 ${svgW} ${svgH}`}
          style={{
            filter: "drop-shadow(0 8px 32px rgba(0,0,0,0.6))",
            overflow: "visible",
          }}
        >
          <defs>
            <linearGradient id="kwgrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="#FFF1B8" />
              <stop offset="25%" stopColor={brandAccent} />
              <stop offset="65%" stopColor={brandAccentDeep} />
              <stop offset="100%" stopColor="#A07417" />
            </linearGradient>
          </defs>
          <text
            x={svgW / 2}
            y={svgH * 0.78}
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontWeight={900}
            fontStyle="italic"
            fontSize={svgH * 0.95}
            textLength={textLen}
            lengthAdjust="spacingAndGlyphs"
            fill="url(#kwgrad)"
          >
            {focusWord}
          </text>
        </svg>
      </AbsoluteFill>

      {/* after text */}
      {after && (
        <div
          style={{
            position: "absolute",
            bottom: afterBottom,
            left: 80,
            right: 80,
            textAlign: "center",
            fontSize: restSize,
            fontWeight: 400,
            color: "#E5E5E5",
            opacity: opacity * 0.85,
            lineHeight: 1.3,
            fontStyle: "italic",
          }}
        >
          {after}
        </div>
      )}

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
            fontSize: Math.round(layout.signoffSize * 0.78),
            fontStyle: "italic",
            color: brandAccent,
            fontFamily: "Georgia, serif",
            fontWeight: 700,
          }}
        >
          {signoff}
        </div>
        <div
          style={{
            fontSize: Math.round(layout.subtitleSize * 0.78),
            color: "#A0A0A0",
            marginTop: 6,
            letterSpacing: "0.3em",
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
          fontSize: Math.round(layout.urlSize * 0.85),
          color: `${brandAccent}70`,
          letterSpacing: "0.4em",
        }}
      >
        {url}
      </div>
    </AbsoluteFill>
  );
};
