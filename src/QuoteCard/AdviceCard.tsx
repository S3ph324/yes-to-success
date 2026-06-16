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
// Advice Card — the "daily builder" dark text-card format (studied from
// Patrick Kyei) adapted to Jurie's empathetic Taglish mentor voice.
//
//   @handle (+ avatar)              ← top
//   HOOK                            ← biggest line, the relatable pain/idea
//   - advice point                 ← 3–6 short lines
//   - advice point
//   One-line payoff / reframe.      ← gold, the "so what"
//   Series — Day N        url       ← footer: dated streak + brand URL
//
// No photo background needed — the card IS the design. Dark by default;
// `theme:"light"` flips to a cream variant.
// ─────────────────────────────────────────────────────────────────────────

export const adviceCardSchema = z.object({
  handle: z.string().default("@learnwithjurie"),
  avatarSrc: z.string().default(""),
  hook: z.string().default(""),
  lines: z.array(z.string()).default([]),
  payoff: z.string().default(""),
  seriesLabel: z.string().default(""),
  dayNumber: z.number().int().min(0).default(0),
  url: z.string().default("learnwithjurie.it.com"),
  theme: z.enum(["dark", "light"]).default("dark"),
  brandGold: z.string().default("#F5C13B"),
  brandRed: z.string().default("#E11522"),
  aspectRatio: aspectRatioSchema,
});

export type AdviceCardProps = z.infer<typeof adviceCardSchema>;

export const calcMetaAdviceCard = ({ props }: { props: AdviceCardProps }) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 90 };
};

const resolveSrc = (src: string) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try { return staticFile(src); } catch { return null; }
};

const ARCHIVO = "'Archivo','Helvetica Neue',Arial,sans-serif";
const FRAUNCES = "'Fraunces',Georgia,serif";

const useAdviceFonts = () => {
  const [handle] = useState(() => delayRender("load-advice-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" }),
      new FontFace("Fraunces", `url(${staticFile("fonts/Fraunces.ttf")}) format("truetype")`, { weight: "100 900" }),
    ];
    Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l))))
      .then(() => continueRender(handle)).catch(() => continueRender(handle));
  }, [handle]);
};

export const AdviceCard: React.FC<AdviceCardProps> = ({
  handle, avatarSrc, hook, lines, payoff, seriesLabel, dayNumber, url,
  theme, brandGold, brandRed,
}) => {
  useAdviceFonts();
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(Math.min(width, height) * 0.075);

  const fade = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const lift = spring({ frame, fps, from: 26, to: 0, durationInFrames: 32 });

  const isDark = theme === "dark";
  const bg = isDark ? "#0c0b10" : "#f6f4ef";
  const ink = isDark ? "#FFFFFF" : "#1b1822";
  const muted = isDark ? "rgba(255,255,255,0.62)" : "rgba(27,24,34,0.6)";
  const lineCol = isDark ? "rgba(255,255,255,0.9)" : "rgba(27,24,34,0.88)";
  const hairline = isDark ? "rgba(255,255,255,0.14)" : "rgba(27,24,34,0.14)";
  const avatar = resolveSrc(avatarSrc);

  // Hook scales down as it gets longer so it always fits two lines max.
  const hookSize = Math.round((hook.length > 46 ? 58 : hook.length > 28 ? 70 : 82) * scale);
  const lineSize = Math.round(34 * scale);
  const items = (lines || []).filter((l) => l && l.trim()).slice(0, 6);

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      {/* faint corner glow for depth */}
      <AbsoluteFill style={{ background: isDark
        ? "radial-gradient(ellipse at 80% 0%, rgba(245,193,59,0.10) 0%, transparent 45%)"
        : "radial-gradient(ellipse at 80% 0%, rgba(245,193,59,0.18) 0%, transparent 45%)" }} />

      <div style={{
        position: "absolute", left: inset, right: inset, top: inset, bottom: inset,
        display: "flex", flexDirection: "column",
        opacity: fade, transform: `translateY(${lift}px)`,
      }}>
        {/* Header: avatar + handle */}
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(14 * scale) }}>
          {avatar && (
            <div style={{ width: Math.round(58 * scale), height: Math.round(58 * scale), borderRadius: "50%", overflow: "hidden", border: `2px solid ${brandGold}` }}>
              <Img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          )}
          <span style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: Math.round(24 * scale), letterSpacing: "0.01em", color: muted }}>{handle}</span>
        </div>

        {/* Hook */}
        <div style={{
          fontFamily: ARCHIVO, fontWeight: 800, fontSize: hookSize, color: ink,
          letterSpacing: "-0.02em", lineHeight: 1.05,
          marginTop: Math.round(40 * scale),
        }}>{hook}</div>

        {/* Advice lines */}
        <div style={{ marginTop: Math.round(34 * scale), display: "flex", flexDirection: "column", gap: Math.round(18 * scale) }}>
          {items.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: Math.round(14 * scale), alignItems: "flex-start" }}>
              <div style={{ width: Math.round(9 * scale), height: Math.round(9 * scale), borderRadius: 2, background: brandGold, marginTop: Math.round(lineSize * 0.42), flexShrink: 0 }} />
              <span style={{ fontFamily: ARCHIVO, fontWeight: 400, fontSize: lineSize, color: lineCol, lineHeight: 1.35 }}>{l}</span>
            </div>
          ))}
        </div>

        {/* Payoff — pushed toward the bottom, gold accent */}
        {payoff && (
          <div style={{
            marginTop: "auto", paddingTop: Math.round(36 * scale),
            fontFamily: FRAUNCES, fontStyle: "italic", fontWeight: 500,
            fontSize: Math.round(38 * scale), color: brandGold, lineHeight: 1.2,
          }}>{payoff}</div>
        )}

        {/* Footer: series — day N · url */}
        <div style={{
          marginTop: Math.round((payoff ? 30 : 36) * scale), paddingTop: Math.round(18 * scale),
          borderTop: `1px solid ${hairline}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(17 * scale), letterSpacing: "0.16em", textTransform: "uppercase", color: ink }}>
            {seriesLabel || "Working Smart"}{dayNumber > 0 ? `  ·  Day ${dayNumber}` : ""}
          </span>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(16 * scale), letterSpacing: "0.04em", color: brandGold }}>{url}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
