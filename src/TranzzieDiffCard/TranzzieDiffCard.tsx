import { useEffect, useState } from "react";
import {
  AbsoluteFill, Audio, Img, Loop, OffthreadVideo,
  continueRender, delayRender, spring, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import { z } from "zod";
import { chunkPhase, differenceCardSchema } from "../DifferenceCard/DifferenceCard";
import { pickTheme, GOLD } from "./backgrounds";

export const tranzzieDiffCardSchema = differenceCardSchema;
type Props = z.infer<typeof tranzzieDiffCardSchema>;
type Phase = Props["phases"][number];

export const calcMetaTranzzieDiffCard = ({ props }: { props: Props }) => ({
  durationInFrames: Math.max(60, Math.ceil((props.durationSec + 0.6) * 30)),
  fps: 30, width: 1080, height: 1920,
});

// Poses are transparent cutouts (green-keyed) — no background box, so no mask.
// A soft drop shadow (theme-aware) grounds the host on the card.
const Presenter: React.FC<{ src?: string; pop: number; bob: number; shadow: string }> = ({ src, pop, bob, shadow }) =>
  src ? (
    <div style={{ position: "absolute", bottom: 0, width: "100%", display: "flex", justifyContent: "center" }}>
      <Img
        src={staticFile(src)}
        style={{
          height: 940,
          transform: `scale(${0.93 + 0.07 * pop}) translateY(${bob}px)`,
          transformOrigin: "center bottom",
          filter: shadow,
        }}
      />
    </div>
  ) : null;

// Brand logo, top-centered. Optional — only brands that set a logo path show it.
const Logo: React.FC<{ src?: string; top?: number; height?: number }> = ({ src, top = 44, height = 128 }) =>
  src ? (
    <div style={{ position: "absolute", top, width: "100%", display: "flex", justifyContent: "center", zIndex: 6 }}>
      <Img src={staticFile(src)} style={{ height, objectFit: "contain" }} />
    </div>
  ) : null;

export const TranzzieDiffCard: React.FC<Props> = ({ segments, phases, audioSrc, handle, poses, logo, bgStyle }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;

  const [fontHandle] = useState(() => delayRender("load-fonts-tranzzie"));
  useEffect(() => {
    const face = new FontFace("Montserrat", `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`, { weight: "100 900" });
    face.load().then((f) => { document.fonts.add(f); continueRender(fontHandle); }).catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  let phaseIdx = 0;
  for (let i = 0; i < phases.length; i++) if (t >= phases[i].start - 0.01) phaseIdx = i;
  const phase: Phase = phases[phaseIdx];
  const segIdx = phase.seg >= 0 ? phase.seg : segments.length - 1;
  const seg = segments[segIdx];
  // Background theme (dark/aurora/grid/light/rotate) + matching ink palette.
  const { Bg, ink } = pickTheme(bgStyle, segIdx);

  const startOf = (kind: string, s: number) => phases.find((p) => p.seg === s && p.kind === kind)?.start ?? 0;
  const aStart = startOf("introA", segIdx), bStart = startOf("introB", segIdx);
  const aVisible = t >= aStart - 0.02, bVisible = t >= bStart - 0.02;
  const popIn = (since: number) => spring({ frame: Math.max(0, (t - since) * fps), fps, config: { damping: 14, mass: 0.6 } });

  const single = !seg.bLabel;
  const imgSize = single ? 680 : 512;
  const imgY = 214;
  const slotX = (side: "a" | "b") => (single ? (width - imgSize) / 2 : side === "a" ? 24 : width - 24 - imgSize);

  const slot = (side: "a" | "b") => {
    if (side === "b" && single) return null;
    const visible = side === "a" ? aVisible : bVisible;
    if (!visible) return null;
    const src = side === "a" ? seg.aImg : seg.bImg;
    const label = side === "a" ? seg.aLabel : seg.bLabel;
    const pop = popIn(side === "a" ? aStart : bStart);
    // Emphasise whichever side the narration is currently about; dim the other,
    // so it's always clear which option the voice is explaining.
    const meActive = side === "a" ? phase.kind === "introA" || phase.kind === "defA" : phase.kind === "introB" || phase.kind === "defB";
    const otherActive = side === "a" ? phase.kind === "introB" || phase.kind === "defB" : phase.kind === "introA" || phase.kind === "defA";
    const dim = otherActive ? 0.38 : 1;
    const emph = meActive ? 1.05 : 1;
    return (
      <div style={{ position: "absolute", left: slotX(side), top: imgY, width: imgSize, transform: `scale(${pop * emph})`, transformOrigin: "center top", opacity: dim, zIndex: meActive ? 2 : 1 }}>
        <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 800, fontSize: label.length > 14 ? 46 : 58, lineHeight: 1.12, color: meActive ? ink.labelActive : ink.labelIdle, textAlign: "center", height: 120, marginBottom: 14, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div>{label}</div>
        </div>
        <div style={{ width: imgSize, height: imgSize, borderRadius: 30, overflow: "hidden", boxShadow: meActive ? ink.cardShadowActive : ink.cardShadowIdle, border: meActive ? "none" : `2px solid ${ink.cardBorder}` }}>
          {side === "a" && seg.aVideo ? (
            <Loop durationInFrames={Math.max(fps, Math.round((seg.aVideoDurationSec || 8) * fps))} layout="none">
              <OffthreadVideo muted src={staticFile(seg.aVideo)} style={{ width: imgSize, height: imgSize, objectFit: "cover" }} />
            </Loop>
          ) : src ? (
            <Img src={staticFile(src)} style={{ width: imgSize, height: imgSize, objectFit: "cover" }} />
          ) : (
            <div style={{ width: imgSize, height: imgSize, background: "#222" }} />
          )}
        </div>
      </div>
    );
  };

  const chunks = chunkPhase(phase);
  const chunk = chunks.find((c) => t >= c.s - 0.04 && t <= c.e + 0.22);
  const chunkPop = chunk ? spring({ frame: Math.max(0, (t - chunk.s) * fps), fps, config: { damping: 12, mass: 0.5 } }) : 0;

  const posePop = spring({ frame: Math.max(0, (t - phase.start) * fps), fps, config: { damping: 13, mass: 0.7 } });
  const bob = Math.sin(frame / 14) * 8;
  const poseSrc = poses?.[phase.kind];

  return (
    <AbsoluteFill style={{ background: ink.base }}>
      <Bg frame={frame} />
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      <Logo src={logo} top={40} height={132} />

      {slot("a")}
      {slot("b")}

      <div style={{ position: "absolute", top: 866, left: 50, width: width - 100, height: 200, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3 }}>
        {chunk ? (
          <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 98, lineHeight: 1.04, textAlign: "center", color: ink.caption, WebkitTextStroke: `5px ${ink.captionStroke}`, paintOrder: "stroke fill", transform: `scale(${0.82 + 0.18 * chunkPop})` }}>
            {chunk.words.map((w) => w.w).join(" ")}
          </div>
        ) : null}
      </div>

      <Presenter src={poseSrc} pop={posePop} bob={bob} shadow={ink.presenterShadow} />

      <div style={{ position: "absolute", bottom: 28, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 34, color: ink.handle, opacity: 0.9, zIndex: 4 }}>
        {handle}
      </div>
    </AbsoluteFill>
  );
};

export const tranzzieDidYouKnowCardSchema = differenceCardSchema;
export const calcMetaTranzzieDidYouKnowCard = calcMetaTranzzieDiffCard;

export const TranzzieDidYouKnowCard: React.FC<Props> = ({ segments, phases, audioSrc, handle, poses, logo }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  const [fontHandle] = useState(() => delayRender("load-fonts-tz-dyk"));
  useEffect(() => {
    const face = new FontFace("Montserrat", `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`, { weight: "100 900" });
    face.load().then((f) => { document.fonts.add(f); continueRender(fontHandle); }).catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  let phaseIdx = 0;
  for (let i = 0; i < phases.length; i++) if (t >= phases[i].start - 0.01) phaseIdx = i;
  const phase: Phase = phases[phaseIdx];
  const seg = segments[0];
  const bgSrc = seg?.aVideo || seg?.aImg;

  const chunks = chunkPhase(phase);
  const chunk = chunks.find((c) => t >= c.s - 0.04 && t <= c.e + 0.22);
  const chunkPop = chunk ? spring({ frame: Math.max(0, (t - chunk.s) * fps), fps, config: { damping: 12, mass: 0.5 } }) : 0;
  const kb = 1 + Math.min(0.14, Math.max(0, t) * 0.008);
  const posePop = spring({ frame: Math.max(0, (t - phase.start) * fps), fps, config: { damping: 13, mass: 0.7 } });
  const poseSrc = poses?.[phase.kind];

  return (
    <AbsoluteFill style={{ background: "#0A0A0A" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}
      {bgSrc ? (
        seg.aVideo ? (
          <Loop durationInFrames={Math.max(fps, Math.round((seg.aVideoDurationSec || 8) * fps))} layout="none">
            <OffthreadVideo muted src={staticFile(seg.aVideo)} style={{ width, height, objectFit: "cover" }} />
          </Loop>
        ) : (
          <Img src={staticFile(bgSrc)} style={{ width, height, objectFit: "cover", transform: `scale(${kb})` }} />
        )
      ) : null}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(8,8,16,0.35) 0%, rgba(8,8,16,0.15) 45%, rgba(8,8,16,0.85) 100%)" }} />

      <Logo src={logo} top={36} height={116} />

      <div style={{ position: "absolute", top: 176, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 72, letterSpacing: 2, color: GOLD, WebkitTextStroke: "6px #111", paintOrder: "stroke fill" }}>
        ALAM MO BA?
      </div>

      <div style={{ position: "absolute", top: 760, left: 60, width: width - 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {chunk ? (
          <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 96, lineHeight: 1.06, textAlign: "center", color: "#fff", WebkitTextStroke: "4px rgba(0,0,0,0.6)", paintOrder: "stroke fill", transform: `scale(${0.82 + 0.18 * chunkPop})` }}>
            {chunk.words.map((w) => w.w).join(" ")}
          </div>
        ) : null}
      </div>

      {poseSrc ? (
        <div style={{ position: "absolute", bottom: 0, right: 10, display: "flex", justifyContent: "flex-end" }}>
          <Img src={staticFile(poseSrc)} style={{ height: 740, transform: `scale(${0.94 + 0.06 * posePop})`, transformOrigin: "right bottom", filter: "drop-shadow(0 12px 30px rgba(0,0,0,0.6))" }} />
        </div>
      ) : null}

      <div style={{ position: "absolute", bottom: 28, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 34, color: GOLD, opacity: 0.9 }}>
        {handle}
      </div>
    </AbsoluteFill>
  );
};
