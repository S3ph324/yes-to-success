import React from "react";
import { AbsoluteFill } from "remotion";

// Background themes for the Tranzzie difference card. Each theme pairs an
// animated <Bg> (motion derives ONLY from `frame`, per Remotion rules) with an
// `ink` palette so text/cards stay legible whether the background is dark or
// white. Pick one per video via the `bgStyle` prop, or "rotate" to cycle the
// dark family per segment for in-video variety.

export const GOLD = "#F5C13B";
export const GOLD_LIGHT = "#FFE27A";
export const GOLD_DEEP = "#C7902A";

export type Ink = {
  base: string; // AbsoluteFill fallback colour behind the animated layer
  caption: string;
  captionStroke: string;
  labelActive: string;
  labelIdle: string;
  ring: string; // active card ring colour
  cardBorder: string; // idle card border
  cardShadowActive: string;
  cardShadowIdle: string;
  handle: string;
  presenterShadow: string;
};

// Shared ink for the dark themes (ember / aurora / grid).
const DARK_INK: Ink = {
  base: "#0a0a0a",
  caption: GOLD_LIGHT,
  captionStroke: "rgba(0,0,0,0.65)",
  labelActive: GOLD_LIGHT,
  labelIdle: "#ffffff",
  ring: GOLD,
  cardBorder: GOLD_DEEP,
  cardShadowActive: `0 0 0 5px ${GOLD}, 0 16px 42px rgba(0,0,0,0.55)`,
  cardShadowIdle: "0 12px 34px rgba(0,0,0,0.5)",
  handle: GOLD,
  presenterShadow: "drop-shadow(0 12px 30px rgba(0,0,0,0.6))",
};

// Ink for the clean white theme — dark caption with a white halo so it stays
// readable over pale blobs; deep-gold accents; a lighter presenter shadow.
const LIGHT_INK: Ink = {
  base: "#F4EEE3",
  caption: "#1A1408",
  captionStroke: "rgba(255,255,255,0.9)",
  labelActive: "#0F0B03",
  labelIdle: "#8a8578",
  ring: GOLD,
  cardBorder: "#D8C48F",
  cardShadowActive: `0 0 0 5px ${GOLD}, 0 18px 40px rgba(60,45,10,0.22)`,
  cardShadowIdle: "0 12px 30px rgba(60,45,10,0.16)",
  handle: "#B07C1E",
  presenterShadow: "drop-shadow(0 14px 26px rgba(40,30,10,0.28))",
};

// A big soft blurred colour blob positioned in % of the frame.
const Blob: React.FC<{ x: number; y: number; size: number; color: string; blur: number }> = ({
  x, y, size, color, blur,
}) => (
  <div
    style={{
      position: "absolute", left: `${x}%`, top: `${y}%`, width: size, height: size,
      transform: "translate(-50%,-50%)", borderRadius: "50%",
      background: `radial-gradient(circle, ${color} 0%, transparent 65%)`, filter: `blur(${blur}px)`,
    }}
  />
);

// Dark base with two drifting brand glows (gold + teal) that breathe.
const EmberBg: React.FC<{ frame: number }> = ({ frame }) => {
  const g1x = 50 + Math.sin(frame / 90) * 16, g1y = 24 + Math.cos(frame / 110) * 9;
  const g2x = 32 + Math.cos(frame / 70) * 18, g2y = 80 + Math.sin(frame / 95) * 7;
  const pulse = 0.92 + 0.08 * Math.sin(frame / 42);
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 22%, #1b1710 0%, #0b0b0b 58%, #070710 100%)" }}>
      <div style={{ position: "absolute", left: `${g1x}%`, top: `${g1y}%`, width: 980, height: 980, transform: `translate(-50%,-50%) scale(${pulse})`, borderRadius: "50%", background: "radial-gradient(circle, rgba(245,193,59,0.17) 0%, rgba(245,193,59,0) 62%)", filter: "blur(34px)" }} />
      <div style={{ position: "absolute", left: `${g2x}%`, top: `${g2y}%`, width: 820, height: 820, transform: `translate(-50%,-50%) scale(${1.9 - pulse})`, borderRadius: "50%", background: "radial-gradient(circle, rgba(70,150,180,0.14) 0%, rgba(70,150,180,0) 62%)", filter: "blur(38px)" }} />
    </AbsoluteFill>
  );
};

// Cool moving colour mesh — four large hued blobs orbiting over a deep indigo
// base. Reads as a designed, lively "aurora" gradient.
const AuroraBg: React.FC<{ frame: number }> = ({ frame }) => {
  const a = frame / 60;
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 10%, #141026 0%, #0a0a14 60%, #05050c 100%)" }}>
      <Blob x={28 + Math.sin(a) * 14} y={26 + Math.cos(a * 0.8) * 10} size={900} color="rgba(120,90,255,0.30)" blur={50} />
      <Blob x={74 + Math.cos(a * 0.9) * 12} y={30 + Math.sin(a * 1.1) * 9} size={820} color="rgba(60,185,195,0.28)" blur={55} />
      <Blob x={50 + Math.sin(a * 1.3) * 18} y={82 + Math.cos(a) * 8} size={1000} color="rgba(245,193,59,0.22)" blur={60} />
      <Blob x={80 + Math.cos(a * 0.7) * 10} y={72 + Math.sin(a * 0.9) * 10} size={700} color="rgba(230,70,140,0.18)" blur={55} />
    </AbsoluteFill>
  );
};

// Modern tech look — a perspective-masked grid that scrolls upward, plus a soft
// top glow that sways. Clearly a "moving" background.
const GridBg: React.FC<{ frame: number }> = ({ frame }) => {
  const shift = (frame * 0.8) % 60;
  const glowY = 20 + Math.sin(frame / 80) * 6;
  const fade = "linear-gradient(180deg, transparent 0%, #000 28%, #000 72%, transparent 100%)";
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 20%, #0d1b2a 0%, #081019 55%, #04070c 100%)" }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(80,160,200,0.13) 1px, transparent 1px), linear-gradient(90deg, rgba(80,160,200,0.13) 1px, transparent 1px)", backgroundSize: "60px 60px", backgroundPosition: `0px ${-shift}px`, maskImage: fade, WebkitMaskImage: fade }} />
      <div style={{ position: "absolute", left: "50%", top: `${glowY}%`, width: 940, height: 940, transform: "translate(-50%,-50%)", borderRadius: "50%", background: "radial-gradient(circle, rgba(70,165,205,0.20) 0%, transparent 60%)", filter: "blur(42px)" }} />
    </AbsoluteFill>
  );
};

// Clean warm-white with slow drifting pastel blobs and a gentle vignette.
const LightBg: React.FC<{ frame: number }> = ({ frame }) => {
  const a = frame / 70;
  return (
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 18%, #FBF7EF 0%, #F1E9DA 70%, #E8DEC9 100%)" }}>
      <Blob x={26 + Math.sin(a) * 12} y={24 + Math.cos(a * 0.9) * 8} size={820} color="rgba(245,193,59,0.30)" blur={60} />
      <Blob x={76 + Math.cos(a * 0.8) * 12} y={34 + Math.sin(a) * 8} size={760} color="rgba(120,180,210,0.26)" blur={60} />
      <Blob x={60 + Math.sin(a * 1.2) * 14} y={84 + Math.cos(a) * 7} size={900} color="rgba(250,205,140,0.30)" blur={65} />
      <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 340px rgba(120,95,40,0.16)" }} />
    </AbsoluteFill>
  );
};

type Theme = { Bg: React.FC<{ frame: number }>; ink: Ink };

export const THEMES: Record<string, Theme> = {
  ember: { Bg: EmberBg, ink: DARK_INK },
  aurora: { Bg: AuroraBg, ink: DARK_INK },
  grid: { Bg: GridBg, ink: DARK_INK },
  light: { Bg: LightBg, ink: LIGHT_INK },
};

// "rotate" cycles the dark family per segment so ONE video shows several
// backgrounds without ever flipping the text colour mid-video.
const DARK_ROTATION = ["ember", "aurora", "grid"];

export function pickTheme(bgStyle: string | undefined, segIdx: number): Theme {
  let id = bgStyle || "ember";
  if (id === "rotate") id = DARK_ROTATION[Math.abs(segIdx) % DARK_ROTATION.length];
  return THEMES[id] || THEMES.ember;
}
