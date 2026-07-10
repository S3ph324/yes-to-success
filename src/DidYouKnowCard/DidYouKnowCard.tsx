import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Loop,
  OffthreadVideo,
  continueRender,
  delayRender,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import {
  TechsplainsWordmark,
  chunkPhase,
  differenceCardSchema,
  displayWord,
} from "../DifferenceCard/DifferenceCard";

// ─────────────────────────────────────────────────────────────────────────────
// Techsplains "did you know" vertical video — deliberately the OPPOSITE look
// of the bright DifferenceCard: full-bleed stock footage (or a slow-zooming
// photo) under a dark cinematic overlay, a stamped DID YOU KNOW? banner, and
// big white word-pop captions. Same props/phases contract as DifferenceCard,
// so the pipeline just routes variant "didyouknow" here at render time.
// ─────────────────────────────────────────────────────────────────────────────

export const didYouKnowCardSchema = differenceCardSchema;
type Props = z.infer<typeof didYouKnowCardSchema>;

export const calcMetaDidYouKnowCard = ({ props }: { props: Props }) => ({
  durationInFrames: Math.max(60, Math.ceil((props.durationSec + 0.6) * 30)),
  fps: 30,
  width: 1080,
  height: 1920,
});

const POSE: Record<string, string> = {
  hook: "characters/techsplains/pose-point.png",
  introA: "characters/techsplains/pose-point.png",
  defA: "characters/techsplains/pose-think.png",
  outro: "characters/techsplains/pose-base.png",
};

export const DidYouKnowCard: React.FC<Props> = ({
  segments,
  phases,
  audioSrc,
  handle,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;

  const [fontHandle] = useState(() => delayRender("load-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace(
        "Luckiest Guy",
        `url(${staticFile("fonts/LuckiestGuy-Regular.ttf")}) format("truetype")`,
      ),
      new FontFace(
        "Montserrat",
        `url(${staticFile("fonts/Montserrat.ttf")}) format("truetype")`,
        { weight: "100 900" },
      ),
    ];
    Promise.all(faces.map((f) => f.load()))
      .then((loaded) => {
        loaded.forEach((f) => document.fonts.add(f));
        continueRender(fontHandle);
      })
      .catch(() => continueRender(fontHandle));
  }, [fontHandle]);

  // Active phase (visuals persist through gaps) — same rule as DifferenceCard.
  let phaseIdx = 0;
  for (let i = 0; i < phases.length; i++) if (t >= phases[i].start - 0.01) phaseIdx = i;
  const phase = phases[phaseIdx];

  const seg = segments[0];

  // Caption chunk currently on screen.
  const chunks = chunkPhase(phase);
  const chunk = chunks.find((c) => t >= c.s - 0.04 && t <= c.e + 0.22);
  const chunkPop = chunk
    ? spring({ frame: Math.max(0, (t - chunk.s) * fps), fps, config: { damping: 12, mass: 0.5 } })
    : 0;

  const bannerPop = spring({ frame, fps, config: { damping: 11, mass: 0.6 } });
  const posePop = spring({
    frame: Math.max(0, (t - phase.start) * fps),
    fps,
    config: { damping: 13, mass: 0.7 },
  });
  const bob = Math.sin(frame / 14) * 6;

  // Full-bleed background: stock clip when we have one, else a photo with a
  // slow Ken Burns push-in (start slightly zoomed so edges never show).
  const kenBurns = 1.06 + Math.min(0.16, t * 0.008);
  const media = seg?.aVideo ? (
    <Loop
      durationInFrames={Math.max(fps, Math.round((seg.aVideoDurationSec || 8) * fps))}
      layout="none"
    >
      <OffthreadVideo
        muted
        src={staticFile(seg.aVideo)}
        style={{ width, height, objectFit: "cover" }}
      />
    </Loop>
  ) : seg?.aImg ? (
    <Img
      src={staticFile(seg.aImg)}
      style={{
        width,
        height,
        objectFit: "cover",
        transform: `scale(${kenBurns})`,
      }}
    />
  ) : null;

  // The fact (introA) reads in white; hook/why/outro take the brand yellow.
  const captionColor = phase.kind === "introA" ? "#FFFFFF" : accent;

  return (
    <AbsoluteFill style={{ background: "#0B0B0D" }}>
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      {media}

      {/* Cinematic overlay so type always reads over the footage */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(5,5,8,0.72) 0%, rgba(5,5,8,0.18) 34%, rgba(5,5,8,0.28) 62%, rgba(5,5,8,0.82) 100%)",
        }}
      />

      <TechsplainsWordmark y={54} size={52} />

      {/* Stamped banner — the variant's signature */}
      <div
        style={{
          position: "absolute",
          top: 150,
          width: "100%",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            background: accent,
            color: "#111",
            fontFamily: "'Luckiest Guy','Montserrat',sans-serif",
            fontSize: 64,
            lineHeight: 1,
            padding: "26px 44px 18px",
            borderRadius: 18,
            border: "6px solid #111",
            boxShadow: "10px 12px 0 rgba(0,0,0,0.45)",
            transform: `rotate(-2.5deg) scale(${0.7 + 0.3 * bannerPop})`,
          }}
        >
          DID YOU KNOW?
        </div>
      </div>

      {/* Word-pop captions — big, centered, over the footage */}
      <div
        style={{
          position: "absolute",
          top: 640,
          left: 60,
          width: width - 120,
          height: 640,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {chunk ? (
          <div
            style={{
              fontFamily: "'Luckiest Guy','Montserrat',sans-serif",
              fontSize: 104,
              lineHeight: 1.06,
              textAlign: "center",
              color: captionColor,
              WebkitTextStroke: "11px #111",
              paintOrder: "stroke fill",
              transform: `scale(${0.82 + 0.18 * chunkPop})`,
              filter: "drop-shadow(0 8px 0 rgba(0,0,0,0.45))",
            }}
          >
            {chunk.words.map((w) => displayWord(w.w)).join(" ")}
          </div>
        ) : null}
      </div>

      {/* Handle */}
      <div
        style={{
          position: "absolute",
          bottom: 64,
          width: "100%",
          textAlign: "center",
          fontFamily: "'Montserrat',sans-serif",
          fontWeight: 700,
          fontSize: 36,
          color: "rgba(255,255,255,0.85)",
        }}
      >
        {handle}
      </div>

      {/* Mascot — small corner cameo instead of the big center-stage pose */}
      <div
        style={{
          position: "absolute",
          right: 34,
          bottom: 118,
        }}
      >
        <Img
          src={staticFile(POSE[phase.kind] || POSE.outro)}
          style={{
            height: 300,
            transform: `scale(${0.9 + 0.1 * posePop}) translateY(${bob}px) rotate(3deg)`,
            transformOrigin: "center bottom",
            filter: "drop-shadow(0 10px 24px rgba(0,0,0,0.5))",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
