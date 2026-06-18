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
  // When set, the payoff block reads as a quote backed by a real authority
  // (e.g. "Alex Hormozi") — shown as «"quote" — Name».
  authorName: z.string().default(""),
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
  handle, avatarSrc, hook, lines, payoff, authorName, seriesLabel, dayNumber, url,
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

  // Fill the canvas per ratio. Every ratio is 1080 wide (so `scale` is the
  // same), but 9:16 is much taller — without this it leaves big empty gaps.
  // Taller canvases get MORE steps, bigger type, and spread-out spacing.
  const ratio = height / width;
  const tall = ratio > 1.5;        // 9:16
  const portrait = ratio > 1.12;   // 4:5 (and 9:16)
  const vf = tall ? 1.24 : portrait ? 1.08 : 1; // vertical-fill type multiplier
  const maxTips = tall ? 5 : portrait ? 4 : 3;

  // The QUOTE leads and is the hero — the biggest type on the card. It scales
  // with length (floor 38 still beats the hook) and grows on taller canvases.
  const quoteSize = Math.round(
    (payoff.length > 165 ? 38 : payoff.length > 125 ? 44 : payoff.length > 92 ? 50
      : payoff.length > 62 ? 58 : payoff.length > 38 ? 66 : 74) * scale * vf,
  );
  // Hook is just a small supporting bridge under the quote — always smaller.
  const hookSize = Math.round((hook.length > 48 ? 30 : 34) * scale * vf);
  const items = (lines || []).filter((l) => l && l.trim()).slice(0, maxTips);
  const tipSize = Math.round(28 * scale * vf);
  const numSize = Math.round(tipSize * 0.82);
  const gap = Math.round(30 * scale * vf);       // between quote & advice blocks
  const tipPad = Math.round(10 * scale * vf);    // vertical padding per step
  const qPadV = Math.round((tall ? 40 : 28) * scale); // quote block vertical padding

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
        {/* Header: just avatar + name — no extra furniture, keep it clean */}
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(14 * scale) }}>
          {avatar && (
            <div style={{ width: Math.round(64 * scale), height: Math.round(64 * scale), borderRadius: "50%", overflow: "hidden", border: `2px solid ${brandGold}`, boxShadow: `0 0 0 4px ${goldTint}` }}>
              <Img src={avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(25 * scale), color: ink, lineHeight: 1.1 }}>Jurie</span>
            <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(19 * scale), color: muted }}>{handle}</span>
          </div>
        </div>

        {/* Body — the QUOTE leads (the focus, read first, biggest), then Jurie's
            advice supports it below. On tall canvases the two blocks spread to
            fill the height instead of clustering in the middle. */}
        <div style={{
          flex: 1, minHeight: 0,
          display: "flex", flexDirection: "column",
          justifyContent: tall ? "space-evenly" : "center",
          gap, paddingTop: Math.round(16 * scale), paddingBottom: tall ? Math.round(6 * scale) : 0,
        }}>
          {/* QUOTE — THE HERO: read first, biggest type on the card. */}
          {payoff && (
            <div style={{
              background: goldTint, borderRadius: Math.round(20 * scale),
              borderLeft: `${Math.round(8 * scale)}px solid ${brandGold}`,
              padding: `${qPadV}px ${Math.round(36 * scale)}px ${qPadV + Math.round(6 * scale)}px`,
            }}>
              <div style={{ fontFamily: FRAUNCES, fontWeight: 900, fontSize: Math.round((tall ? 138 : 116) * scale), lineHeight: 0.6, color: brandGold, marginBottom: Math.round(2 * scale) }}>“</div>
              <div style={{ fontFamily: FRAUNCES, fontStyle: "italic", fontWeight: 600, fontSize: quoteSize, color: ink, lineHeight: 1.18, letterSpacing: "-0.01em" }}>
                {payoff}
              </div>
              {authorName && (
                <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(26 * scale), letterSpacing: "0.1em", textTransform: "uppercase", color: brandGold, marginTop: Math.round(20 * scale) }}>
                  — {authorName}
                </div>
              )}
            </div>
          )}

          {/* Jurie's take — the supporting advice (relatable hook + 3 quick steps). */}
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: Math.round(12 * scale), marginBottom: Math.round(14 * scale) }}>
              <div style={{ width: Math.round(26 * scale), height: Math.round(3 * scale), background: brandGold, borderRadius: 3 }} />
              <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(15 * scale), letterSpacing: "0.18em", textTransform: "uppercase", color: brandGold }}>Jurie&apos;s take</span>
            </div>
            {/* Hook (last word gold) — small bridge line */}
            <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: hookSize, color: ink, letterSpacing: "-0.01em", lineHeight: 1.12 }}>
              {hookWords.map((w, i) => (
                <span key={i} style={i === hookAccentIdx ? { color: brandGold } : undefined}>{w}{i < hookWords.length - 1 ? " " : ""}</span>
              ))}
            </div>
            {/* Numbered tips with hairline separators */}
            <div style={{ marginTop: Math.round(16 * scale * vf) }}>
              {items.map((l, i) => (
                <div key={i} style={{
                  display: "flex", gap: Math.round(16 * scale), alignItems: "baseline",
                  padding: `${tipPad}px 0`,
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
        </div>

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
