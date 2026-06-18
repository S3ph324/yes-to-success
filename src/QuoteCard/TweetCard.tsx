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

const EngIcon: React.FC<{ d: string; color: string; size: number }> = ({ d, color, size }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden><path fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d={d} /></svg>
);

export const TweetCard: React.FC<TweetCardProps> = ({
  displayName, handle, avatarSrc, verified, body, timestamp,
  replies, reposts, likes, cardTheme, backdrop, brandGold, brandRed,
}) => {
  useTweetFonts();
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const scale = width / 1080;

  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const lift = spring({ frame, fps, from: 30, to: 0, durationInFrames: 30 });

  const dark = cardTheme === "dark";
  const cardBg = dark ? "#000000" : "#ffffff";
  const ink = dark ? "#e7e9ea" : "#0f1419";
  const sub = dark ? "#71767b" : "#536471";
  const line = dark ? "#2f3336" : "#eff3f4";
  const avatar = resolveSrc(avatarSrc);

  // Outer backdrop — muted, deep tones so the batch has subtle variety without
  // bright/vibrant colour. Light variants are soft neutrals.
  const BACKDROPS: Record<string, string> = {
    // soft light neutrals
    clean: "linear-gradient(160deg, #eef1f4 0%, #e2e6ea 100%)",
    mist: "linear-gradient(155deg, #e9edf2 0%, #d7dde5 100%)",
    blush: "linear-gradient(155deg, #efe7e9 0%, #ddd2d6 100%)",
    // muted, deep darks (subtle hue, never bright)
    ink: "radial-gradient(ellipse at 50% 26%, #191b22 0%, #090a0d 100%)",
    slate: "linear-gradient(155deg, #283042 0%, #13161f 100%)",
    plum: "linear-gradient(155deg, #2f2632 0%, #161219 100%)",
    bronze: "linear-gradient(155deg, #2f2820 0%, #161310 100%)",
    // legacy aliases → muted equivalents (older entries keep working)
    dark: "radial-gradient(ellipse at 50% 26%, #191b22 0%, #090a0d 100%)",
    indigo: "linear-gradient(155deg, #283042 0%, #13161f 100%)",
    rose: "linear-gradient(155deg, #2f2632 0%, #161219 100%)",
    gold: "linear-gradient(155deg, #2f2820 0%, #161310 100%)",
  };
  const lightBg = backdrop === "clean" || backdrop === "mist" || backdrop === "blush";
  const bg = BACKDROPS[backdrop] || BACKDROPS.ink;
  const sheen = lightBg
    ? "radial-gradient(ellipse at 50% 30%, rgba(255,255,255,0.55) 0%, transparent 60%)"
    : "radial-gradient(ellipse at 50% 38%, rgba(255,255,255,0.05) 0%, transparent 62%)";

  const bodySize = Math.round((body.length > 180 ? 38 : body.length > 110 ? 44 : 52) * scale);
  const pad = Math.round(46 * scale);
  const cardW = Math.round(width * 0.84);

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <AbsoluteFill style={{ background: sheen }} />
      <div style={{
        width: cardW, background: cardBg, borderRadius: Math.round(28 * scale),
        padding: pad,
        boxShadow: lightBg ? "0 24px 60px rgba(15,20,25,0.16), 0 0 0 1px rgba(15,20,25,0.05)" : "0 30px 80px rgba(0,0,0,0.34)",
        opacity: fade, transform: `translateY(${lift}px)`,
      }}>
        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(14 * scale) }}>
          <div style={{ width: Math.round(64 * scale), height: Math.round(64 * scale), borderRadius: "50%", overflow: "hidden", background: avatar ? (dark ? "#16181c" : "#f0f0f0") : brandGold, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {avatar
              ? <Img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span style={{ fontFamily: SYS, fontWeight: 800, fontSize: Math.round(30 * scale), color: "#0f1419" }}>{(displayName || "?").trim().charAt(0).toUpperCase()}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: Math.round(6 * scale) }}>
              <span style={{ fontFamily: SYS, fontWeight: 800, fontSize: Math.round(28 * scale), color: ink }}>{displayName}</span>
              {verified && <Verified size={Math.round(26 * scale)} color="#1d9bf0" />}
            </div>
            <span style={{ fontFamily: SYS, fontWeight: 400, fontSize: Math.round(22 * scale), color: sub }}>{handle}</span>
          </div>
          {/* X logo top-right */}
          <svg viewBox="0 0 24 24" width={Math.round(30 * scale)} height={Math.round(30 * scale)} aria-hidden>
            <path fill={ink} d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </div>

        {/* Body */}
        <div style={{
          fontFamily: SYS, fontWeight: 400, fontSize: bodySize, color: ink,
          lineHeight: 1.35, marginTop: Math.round(28 * scale), whiteSpace: "pre-wrap",
        }}>{body}</div>

        {/* Timestamp */}
        <div style={{ fontFamily: SYS, fontWeight: 400, fontSize: Math.round(20 * scale), color: sub, marginTop: Math.round(26 * scale) }}>
          {timestamp || "9:41 AM · Jun 17, 2026"}
        </div>

        {/* Divider + engagement — icons only; counts left blank (like a fresh
            post) unless explicitly provided. */}
        <div style={{ borderTop: `1px solid ${line}`, marginTop: Math.round(22 * scale), paddingTop: Math.round(20 * scale), display: "flex", gap: Math.round(48 * scale) }}>
          {[
            { d: "M3 5h18v12H8l-5 4z", v: replies },
            { d: "M4 8h13l-3-3M20 16H7l3 3", v: reposts },
            { d: "M12 21s-7.5-4.6-9.5-9C1 8 3 5 6 5c2 0 3 1.5 3 1.5S10 5 12 5s3 1.5 3 1.5S16 5 18 5c3 0 5 3 3.5 7-2 4.4-9.5 9-9.5 9z", v: likes },
          ].map((m, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: Math.round(9 * scale) }}>
              <EngIcon d={m.d} color={sub} size={Math.round(24 * scale)} />
              {m.v ? <span style={{ fontFamily: SYS, fontWeight: 500, fontSize: Math.round(20 * scale), color: sub }}>{m.v}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
