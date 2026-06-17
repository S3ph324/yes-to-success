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

  // Hook scales down as it gets longer so it always fits ~two lines.
  const hookSize = Math.round((hook.length > 46 ? 56 : hook.length > 28 ? 66 : 78) * scale);
  const items = (lines || []).filter((l) => l && l.trim()).slice(0, 6);
  // Tips shrink a touch when there are many, so the card stays balanced.
  const tipSize = Math.round((items.length >= 5 ? 28 : 32) * scale);
  const numSize = Math.round(tipSize * 0.78);

  // Hook with the last word in gold — a small accent that adds pop.
  const hookWords = hook.trim().split(/\s+/);
  const hookAccentIdx = hookWords.length > 2 ? hookWords.length - 1 : -1;

  const goldTint = isDark ? "rgba(245,193,59,0.09)" : "rgba(245,193,59,0.14)";
  const seriesTag = (seriesLabel || "Working Smart").toUpperCase();

  return (
    <AbsoluteFill style={{ background: bg, overflow: "hidden" }}>
      {/* depth: top-right gold glow + (dark) bottom vignette */}
      <AbsoluteFill style={{ background: isDark
        ? "radial-gradient(ellipse at 88% 6%, rgba(245,193,59,0.16) 0%, transparent 44%)"
        : "radial-gradient(ellipse at 88% 6%, rgba(245,193,59,0.22) 0%, transparent 44%)" }} />
      {isDark && <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 58%, rgba(0,0,0,0.4) 100%)" }} />}

      <div style={{
        position: "absolute", left: inset, right: inset, top: inset, bottom: inset,
        display: "flex", flexDirection: "column",
        opacity: fade, transform: `translateY(${lift}px)`,
      }}>
        {/* Header: avatar + name/handle (left) · series tag (right) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: Math.round(14 * scale) }}>
            {avatar && (
              <div style={{ width: Math.round(60 * scale), height: Math.round(60 * scale), borderRadius: "50%", overflow: "hidden", border: `2px solid ${brandGold}`, boxShadow: `0 0 0 4px ${goldTint}` }}>
                <Img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(24 * scale), color: ink, lineHeight: 1.1 }}>Jurie</span>
              <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(19 * scale), color: muted }}>{handle}</span>
            </div>
          </div>
          <div style={{
            fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(14 * scale),
            letterSpacing: "0.18em", color: brandGold, textTransform: "uppercase",
            border: `1.5px solid ${brandGold}`, borderRadius: 999,
            padding: `${Math.round(7 * scale)}px ${Math.round(16 * scale)}px`,
          }}>{seriesTag}</div>
        </div>

        {/* Middle — vertically centred so few-tip cards stay balanced */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", paddingTop: Math.round(20 * scale), paddingBottom: Math.round(20 * scale) }}>
          {/* gold kicker bar */}
          <div style={{ width: Math.round(56 * scale), height: Math.round(5 * scale), background: brandGold, borderRadius: 3, marginBottom: Math.round(24 * scale) }} />
          {/* Hook (last word gold) */}
          <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: hookSize, color: ink, letterSpacing: "-0.02em", lineHeight: 1.06 }}>
            {hookWords.map((w, i) => (
              <span key={i} style={i === hookAccentIdx ? { color: brandGold } : undefined}>{w}{i < hookWords.length - 1 ? " " : ""}</span>
            ))}
          </div>
          {/* Numbered tips with hairline separators */}
          <div style={{ marginTop: Math.round(36 * scale) }}>
            {items.map((l, i) => (
              <div key={i} style={{
                display: "flex", gap: Math.round(20 * scale), alignItems: "baseline",
                padding: `${Math.round(15 * scale)}px 0`,
                borderTop: i === 0 ? "none" : `1px solid ${hairline}`,
              }}>
                <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: numSize, color: brandGold, lineHeight: 1, flexShrink: 0, fontVariantNumeric: "tabular-nums", minWidth: Math.round(numSize * 1.6) }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: tipSize, color: lineCol, lineHeight: 1.3 }}>{l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Payoff — gold left bar + tinted block */}
        {payoff && (
          <div style={{
            display: "flex", gap: Math.round(18 * scale), alignItems: "stretch",
            background: goldTint, borderRadius: Math.round(14 * scale),
            padding: `${Math.round(20 * scale)}px ${Math.round(22 * scale)}px`,
            marginBottom: Math.round(24 * scale),
          }}>
            <div style={{ width: Math.round(5 * scale), background: brandGold, borderRadius: 3, flexShrink: 0 }} />
            <div style={{ fontFamily: FRAUNCES, fontStyle: "italic", fontWeight: 500, fontSize: Math.round(36 * scale), color: ink, lineHeight: 1.22 }}>{payoff}</div>
          </div>
        )}

        {/* Footer: series · day (left) · url (right) */}
        <div style={{ paddingTop: Math.round(16 * scale), borderTop: `1px solid ${hairline}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(16 * scale), letterSpacing: "0.16em", textTransform: "uppercase", color: ink }}>
            {seriesTag}{dayNumber > 0 ? `  ·  Day ${dayNumber}` : ""}
          </span>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: Math.round(16 * scale), letterSpacing: "0.04em", color: brandGold }}>{url}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
