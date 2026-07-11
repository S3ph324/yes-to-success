import { useEffect, useState } from "react";
import {
  AbsoluteFill, Audio, Img, Loop, OffthreadVideo,
  continueRender, delayRender, spring, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import { z } from "zod";
import { chunkPhase, differenceCardSchema } from "../DifferenceCard/DifferenceCard";

export const tranzzieDiffCardSchema = differenceCardSchema;
type Props = z.infer<typeof tranzzieDiffCardSchema>;
type Phase = Props["phases"][number];

export const calcMetaTranzzieDiffCard = ({ props }: { props: Props }) => ({
  durationInFrames: Math.max(60, Math.ceil((props.durationSec + 0.6) * 30)),
  fps: 30, width: 1080, height: 1920,
});

const GOLD = "#F5C13B", GOLD_LIGHT = "#FFE27A", GOLD_DEEP = "#C7902A";

const Presenter: React.FC<{ src?: string; pop: number; bob: number }> = ({ src, pop, bob }) =>
  src ? (
    <div style={{ position: "absolute", bottom: 0, width: "100%", display: "flex", justifyContent: "center" }}>
      <Img
        src={staticFile(src)}
        style={{
          height: 760,
          transform: `scale(${0.92 + 0.08 * pop}) translateY(${bob}px)`,
          transformOrigin: "center bottom",
          WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 22%)",
          maskImage: "linear-gradient(to bottom, transparent 0%, black 22%)",
        }}
      />
    </div>
  ) : null;

// Brand logo, top-centered. Optional — only brands that set a logo path show it.
const Logo: React.FC<{ src?: string; top?: number; height?: number }> = ({ src, top = 56, height = 72 }) =>
  src ? (
    <div style={{ position: "absolute", top, width: "100%", display: "flex", justifyContent: "center", zIndex: 6 }}>
      <Img src={staticFile(src)} style={{ height, objectFit: "contain" }} />
    </div>
  ) : null;

export const TranzzieDiffCard: React.FC<Props> = ({ segments, phases, audioSrc, handle, poses, logo }) => {
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

  const startOf = (kind: string, s: number) => phases.find((p) => p.seg === s && p.kind === kind)?.start ?? 0;
  const aStart = startOf("introA", segIdx), bStart = startOf("introB", segIdx);
  const aVisible = t >= aStart - 0.02, bVisible = t >= bStart - 0.02;
  const popIn = (since: number) => spring({ frame: Math.max(0, (t - since) * fps), fps, config: { damping: 14, mass: 0.6 } });

  const single = !seg.bLabel;
  const imgSize = single ? 620 : 470;
  const imgY = 210;
  const slotX = (side: "a" | "b") => (single ? (width - imgSize) / 2 : side === "a" ? 45 : width - 45 - imgSize);

  const slot = (side: "a" | "b") => {
    if (side === "b" && single) return null;
    const visible = side === "a" ? aVisible : bVisible;
    if (!visible) return null;
    const src = side === "a" ? seg.aImg : seg.bImg;
    const label = side === "a" ? seg.aLabel : seg.bLabel;
    const pop = popIn(side === "a" ? aStart : bStart);
    return (
      <div style={{ position: "absolute", left: slotX(side), top: imgY, width: imgSize, transform: `scale(${pop})`, transformOrigin: "center top" }}>
        <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 800, fontSize: label.length > 12 ? 44 : 54, lineHeight: 1.15, color: "#fff", textAlign: "center", height: 140, marginBottom: 18, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div>{label}</div>
        </div>
        <div style={{ width: imgSize, height: imgSize, borderRadius: 28, overflow: "hidden", boxShadow: "0 10px 34px rgba(0,0,0,0.5)", border: `2px solid ${GOLD_DEEP}` }}>
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
    <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 30%, #17140C 0%, #0A0A0A 60%, #080810 100%)" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      <Logo src={logo} top={52} height={64} />

      {slot("a")}
      {slot("b")}

      <div style={{ position: "absolute", top: 880, left: 60, width: width - 120, height: 250, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3 }}>
        {chunk ? (
          <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 92, lineHeight: 1.05, textAlign: "center", color: GOLD_LIGHT, WebkitTextStroke: "4px rgba(0,0,0,0.6)", paintOrder: "stroke fill", transform: `scale(${0.82 + 0.18 * chunkPop})` }}>
            {chunk.words.map((w) => w.w).join(" ")}
          </div>
        ) : null}
      </div>

      <Presenter src={poseSrc} pop={posePop} bob={bob} />

      <div style={{ position: "absolute", bottom: 28, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 34, color: GOLD, opacity: 0.85, zIndex: 4 }}>
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

      <Logo src={logo} top={52} height={64} />

      <div style={{ position: "absolute", top: 156, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 900, fontSize: 66, letterSpacing: 2, color: GOLD, WebkitTextStroke: "6px #111", paintOrder: "stroke fill" }}>
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
        <div style={{ position: "absolute", bottom: 0, right: 20, display: "flex", justifyContent: "flex-end" }}>
          <Img src={staticFile(poseSrc)} style={{ height: 560, transform: `scale(${0.94 + 0.06 * posePop})`, transformOrigin: "right bottom", WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 24%)", maskImage: "linear-gradient(to bottom, transparent 0%, black 24%)" }} />
        </div>
      ) : null}

      <div style={{ position: "absolute", bottom: 28, width: "100%", textAlign: "center", fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 34, color: GOLD, opacity: 0.9 }}>
        {handle}
      </div>
    </AbsoluteFill>
  );
};
