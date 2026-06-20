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
// Tweet Card — an X/Twitter post "screenshot" of a piece of advice, centred
// on a brand-coloured backdrop. The screenshot-of-advice format that performs
// well on FB/IG. Light (default) or dark ("X dark mode") card.
// ─────────────────────────────────────────────────────────────────────────

export const tweetCardSchema = z.object({
  displayName: z.string().default("Jurie"),
  handle: z.string().default("@learnwithjurie"),
  avatarSrc: z.string().default(""),
  verified: z.boolean().default(true),
  body: z.string().default(""),
  timestamp: z.string().default(""),
  replies: z.string().default(""),
  reposts: z.string().default(""),
  likes: z.string().default(""),
  cardTheme: z.enum(["light", "dark"]).default("light"),
  // Outer backdrop behind the tweet card — muted, deep tones (never bright).
  // Legacy keys (dark/indigo/rose/gold) are aliased to muted equivalents.
  backdrop: z
    .enum(["clean", "mist", "blush", "ink", "slate", "plum", "bronze", "dark", "indigo", "rose", "gold"])
    .default("ink"),
  brandGold: z.string().default("#F5C13B"),
  brandRed: z.string().default("#E11522"),
  aspectRatio: aspectRatioSchema,
});

export type TweetCardProps = z.infer<typeof tweetCardSchema>;

export const calcMetaTweetCard = ({ props }: { props: TweetCardProps }) => {
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

const useTweetFonts = () => {
  const [h] = useState(() => delayRender("load-tweet-fonts"));
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


export const TweetCard: React.FC<TweetCardProps> = ({
  displayName, handle, avatarSrc, verified, body, cardTheme, brandGold,
}) => {
  useTweetFonts();
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const scale = width / 1080;

  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const lift = spring({ frame, fps, from: 30, to: 0, durationInFrames: 30 });

  const dark = cardTheme === "dark";
  const bg = dark ? "#000000" : "#ffffff";
  const ink = dark ? "#e7e9ea" : "#0f1419";
  const sub = dark ? "#71767b" : "#536471";
  const avatar = resolveSrc(avatarSrc);

  // Clean tweet-screenshot look: the tweet fills the frame on a plain
  // background — no outer backdrop, no timestamp, no engagement row, no X logo.
  const len = (body || "").length;
  const bodySize = Math.round((len > 240 ? 42 : len > 165 ? 50 : len > 95 ? 58 : 66) * scale);
  const pad = Math.round(width * 0.08);
  const avSize = Math.round(78 * scale);

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      <div style={{
        position: "absolute", left: pad, right: pad, top: pad, bottom: pad,
        display: "flex", flexDirection: "column", justifyContent: "center",
        opacity: fade, transform: `translateY(${lift}px)`,
      }}>
        {/* Header: avatar + name + handle */}
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(15 * scale), marginBottom: Math.round(30 * scale) }}>
          <div style={{ width: avSize, height: avSize, borderRadius: "50%", overflow: "hidden", background: avatar ? (dark ? "#16181c" : "#f0f0f0") : brandGold, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {avatar
              ? <Img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span style={{ fontFamily: SYS, fontWeight: 800, fontSize: Math.round(34 * scale), color: "#0f1419" }}>{(displayName || "?").trim().charAt(0).toUpperCase()}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: Math.round(7 * scale) }}>
              <span style={{ fontFamily: SYS, fontWeight: 800, fontSize: Math.round(31 * scale), color: ink, lineHeight: 1.12 }}>{displayName}</span>
              {verified && <Verified size={Math.round(29 * scale)} color="#1d9bf0" />}
            </div>
            <span style={{ fontFamily: SYS, fontWeight: 400, fontSize: Math.round(24 * scale), color: sub, lineHeight: 1.12 }}>{handle}</span>
          </div>
        </div>

        {/* Body — the tweet text, large, fills the frame */}
        <div style={{ fontFamily: SYS, fontWeight: 400, fontSize: bodySize, color: ink, lineHeight: 1.32, whiteSpace: "pre-wrap", letterSpacing: "-0.005em" }}>{body}</div>
      </div>
    </AbsoluteFill>
  );
};
