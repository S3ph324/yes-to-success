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
import { AspectRatio, aspectRatioSchema, aspectToDimensions } from "./aspect";

// ─────────────────────────────────────────────────────────────────────────
// Photo Tweet Card — a full-bleed PORTRAIT of Jurie with a floating white
// "tweet" card sitting near the bottom (avatar, name + verified, handle, and
// the Taglish line). Inspired by the coach-photo + tweet-overlay format, but
// it is always Jurie: Jurie's photo, Jurie's name, Jurie's voice. The body is
// Jurie's OWN line — never a quote of anyone else.
// ─────────────────────────────────────────────────────────────────────────

export const photoTweetCardSchema = z.object({
  bgSrc: z.string().default(""),
  displayName: z.string().default("Jurie Cata Villarde"),
  handle: z.string().default("@learnwithjurie"),
  avatarSrc: z.string().default(""),
  verified: z.boolean().default(true),
  body: z.string().default(""),
  // One word/phrase from the body to accent in brand red (the "punch").
  accent: z.string().default(""),
  brandGold: z.string().default("#F5C13B"),
  brandRed: z.string().default("#E11522"),
  aspectRatio: aspectRatioSchema,
});

export type PhotoTweetCardProps = z.infer<typeof photoTweetCardSchema>;

export const calcMetaPhotoTweetCard = ({ props }: { props: PhotoTweetCardProps }) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 90 };
};

const resolveSrc = (src: string) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try { return staticFile(src); } catch { return null; }
};

const SYS = "'Archivo','Helvetica Neue',Arial,sans-serif";

const usePhotoTweetFonts = () => {
  const [h] = useState(() => delayRender("load-phototweet-fonts"));
  useEffect(() => {
    new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" })
      .load().then((l) => { document.fonts.add(l); continueRender(h); }).catch(() => continueRender(h));
  }, [h]);
};

const Verified: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
    <path fill={color} d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.68.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91c-1.31.66-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.66 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z" />
  </svg>
);

/** Render the body with one accent phrase coloured + bold (brand red). Falls
 *  back to plain text if the accent isn't found. Case-insensitive match. */
const Body: React.FC<{ text: string; accent: string; size: number; ink: string; red: string }> = ({
  text, accent, size, ink, red,
}) => {
  const base: React.CSSProperties = {
    fontFamily: SYS, fontWeight: 500, fontSize: size, color: ink,
    lineHeight: 1.24, letterSpacing: "-0.01em",
  };
  const a = accent.trim();
  const idx = a ? text.toLowerCase().indexOf(a.toLowerCase()) : -1;
  if (idx < 0) return <div style={base}>{text}</div>;
  return (
    <div style={base}>
      {text.slice(0, idx)}
      <span style={{ color: red, fontWeight: 800 }}>{text.slice(idx, idx + a.length)}</span>
      {text.slice(idx + a.length)}
    </div>
  );
};

export const PhotoTweetCard: React.FC<PhotoTweetCardProps> = ({
  bgSrc, displayName, handle, avatarSrc, verified, body, accent, brandRed,
}) => {
  usePhotoTweetFonts();
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = width / 1080;

  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const lift = spring({ frame, fps, from: 36, to: 0, durationInFrames: 32 });
  const bgScale = interpolate(frame, [0, 90], [1.06, 1.0], { extrapolateRight: "clamp" });

  const bg = resolveSrc(bgSrc);
  const avatar = resolveSrc(avatarSrc);
  const inset = Math.round(width * 0.05);

  // Card body auto-sizes: long lines shrink so the card never overflows.
  const cardW = width - inset * 2;
  const bodyW = cardW - Math.round(width * 0.07 * 2);
  const cpl = Math.max(8, Math.floor(bodyW / (28 * scale * 0.54)));
  const estBodyLines = Math.max(1, Math.ceil((body || "").length / cpl));
  const bodySize = Math.round((estBodyLines > 4 ? 30 : estBodyLines > 3 ? 34 : 40) * scale);
  const avSize = Math.round(78 * scale);

  return (
    <AbsoluteFill style={{ background: "#0c0b10", overflow: "hidden" }}>
      {/* Full-bleed portrait */}
      {bg ? (
        <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
          <Img src={bg} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 30%, #2a2a32 0%, #0a0a0e 100%)" }} />
      )}
      {/* Grounding gradient so the floating card reads against any photo */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.45) 100%)" }} />

      {/* Floating tweet card near the bottom */}
      <div style={{
        position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.05),
        background: "#ffffff", borderRadius: Math.round(34 * scale),
        padding: `${Math.round(34 * scale)}px ${Math.round(38 * scale)}px`,
        boxShadow: "0 24px 70px rgba(0,0,0,0.45), 0 4px 14px rgba(0,0,0,0.25)",
        opacity: fade, transform: `translateY(${lift}px)`,
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(15 * scale), marginBottom: Math.round(22 * scale) }}>
          <div style={{ width: avSize, height: avSize, borderRadius: "50%", overflow: "hidden", background: "#e9eef2", flexShrink: 0 }}>
            {avatar && <Img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: Math.round(8 * scale) }}>
              <span style={{ fontFamily: SYS, fontWeight: 800, fontSize: Math.round(34 * scale), color: "#0f1419", lineHeight: 1.1 }}>{displayName}</span>
              {verified && <Verified size={Math.round(30 * scale)} color="#1d9bf0" />}
            </div>
            <span style={{ fontFamily: SYS, fontWeight: 400, fontSize: Math.round(26 * scale), color: "#536471", lineHeight: 1.1 }}>{handle}</span>
          </div>
        </div>
        {/* Body */}
        <Body text={body} accent={accent} size={bodySize} ink="#0f1419" red={brandRed} />
      </div>
    </AbsoluteFill>
  );
};
