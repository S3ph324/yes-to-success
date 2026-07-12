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

// ─────────────────────────────────────────────────────────────────────────────
// Techsplains "what's the difference" vertical video (1080×1920 @ 30fps).
// Two labeled comparison images up top, yellow word-pop captions synced to the
// TTS voiceover, and the headphone doodle mascot switching poses with the
// script phases. All timing data is precomputed by generate-diff-audio.mjs —
// the component only reads phase/word times, it never guesses.
// ─────────────────────────────────────────────────────────────────────────────

const wordSchema = z.object({ w: z.string(), s: z.number(), e: z.number() });
const phaseSchema = z.object({
  key: z.string(),
  seg: z.number(),
  kind: z.enum(["hook", "introA", "introB", "question", "defA", "defB", "outro"]),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  words: z.array(wordSchema),
});
const segmentSchema = z.object({
  aLabel: z.string(),
  bLabel: z.string(),
  aImg: z.string().optional(),
  bImg: z.string().optional(),
  // "Did you know" slots can carry a stock video CLIP instead of a still.
  aVideo: z.string().optional(),
  aVideoDurationSec: z.number().optional(),
});

export const differenceCardSchema = z.object({
  segments: z.array(segmentSchema),
  phases: z.array(phaseSchema),
  audioSrc: z.string(),
  durationSec: z.number(),
  handle: z.string(),
  accent: z.string(),
  poses: z.record(z.string(), z.string()).optional(),
  logo: z.string().optional(),
  // Background theme for the Tranzzie card: ember (default dark), aurora
  // (cool moving color mesh), grid (moving tech grid), light (clean white),
  // or rotate (cycle the dark family per segment). Ignored by other templates.
  bgStyle: z.string().optional(),
});

type Props = z.infer<typeof differenceCardSchema>;
type Phase = z.infer<typeof phaseSchema>;

export const calcMetaDifferenceCard = ({ props }: { props: Props }) => ({
  durationInFrames: Math.max(60, Math.ceil((props.durationSec + 0.6) * 30)),
  fps: 30,
  width: 1080,
  height: 1920,
});

// Mascot pose per phase kind.
const POSE: Record<Phase["kind"], string> = {
  hook: "characters/techsplains/pose-point.png",
  introA: "characters/techsplains/pose-point.png",
  introB: "characters/techsplains/pose-point.png",
  question: "characters/techsplains/pose-confused.png",
  defA: "characters/techsplains/pose-think.png",
  defB: "characters/techsplains/pose-point.png",
  outro: "characters/techsplains/pose-base.png",
};

// Brand wordmark — same lockup as the Facebook cover (Luckiest Guy, yellow
// fill, black stroke). Shared by DifferenceCard and DidYouKnowCard.
export const TechsplainsWordmark: React.FC<{ y?: number; size?: number }> = ({
  y = 44,
  size = 58,
}) => (
  <div
    style={{
      position: "absolute",
      top: y,
      width: "100%",
      textAlign: "center",
      fontFamily: "'Luckiest Guy','Montserrat',sans-serif",
      fontSize: size,
      letterSpacing: 3,
      color: "#FFDD00",
      WebkitTextStroke: "7px #111",
      paintOrder: "stroke fill",
      filter: "drop-shadow(0 4px 0 rgba(0,0,0,0.18))",
    }}
  >
    TECHSPLAINS
  </div>
);

// Reference-style caption case: lowercase everything except acronyms (USB-C).
export const displayWord = (w: string) =>
  /[A-Z]{2}/.test(w) ? w : w.toLowerCase();

// Group a phase's words into caption chunks. Intros/question read as one
// short phrase; definitions pop in small groups like the reference channel;
// hook/outro wrap at four so longer lines stay readable. A chunk never
// crosses a sentence boundary — "videos more? follow techsplains" reads
// broken; ending the chunk at ?/!/. keeps every caption a coherent phrase.
export const chunkPhase = (p: Phase) => {
  const max =
    p.kind === "defA" || p.kind === "defB" ? 3
    : p.kind === "hook" || p.kind === "outro" ? 4
    : 6;
  const chunks: { words: typeof p.words; s: number; e: number }[] = [];
  let cur: typeof p.words = [];
  const flush = () => {
    if (cur.length) {
      chunks.push({ words: cur, s: cur[0].s, e: cur[cur.length - 1].e });
      cur = [];
    }
  };
  for (const w of p.words) {
    cur.push(w);
    if (cur.length >= max || /[.!?]$/.test(w.w)) flush();
  }
  flush();
  return chunks;
};

export const DifferenceCard: React.FC<Props> = ({
  segments,
  phases,
  audioSrc,
  handle,
  accent,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
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

  // Active phase: the last one that has started (visuals persist through gaps).
  let phaseIdx = 0;
  for (let i = 0; i < phases.length; i++) if (t >= phases[i].start - 0.01) phaseIdx = i;
  const phase = phases[phaseIdx];

  // Active segment: outro keeps the last segment's images on screen.
  const segIdx = phase.seg >= 0 ? phase.seg : segments.length - 1;
  const seg = segments[segIdx];

  // When did each side's image appear in the CURRENT segment?
  const startOf = (kind: string, s: number) =>
    phases.find((p) => p.seg === s && p.kind === kind)?.start ?? 0;
  const aStart = startOf("introA", segIdx);
  const bStart = startOf("introB", segIdx);
  const aVisible = t >= aStart - 0.02;
  const bVisible = t >= bStart - 0.02;
  const popIn = (sinceSec: number) =>
    spring({ frame: Math.max(0, (t - sinceSec) * fps), fps, config: { damping: 14, mass: 0.6 } });

  // Definition emphasis: active side pops slightly, the other dims.
  const aActive = phase.kind === "defA" || phase.kind === "introA";
  const bActive = phase.kind === "defB" || phase.kind === "introB";

  // Caption chunk currently on screen.
  const chunks = chunkPhase(phase);
  const chunk = chunks.find((c) => t >= c.s - 0.04 && t <= c.e + 0.22);
  const chunkPop = chunk
    ? spring({ frame: Math.max(0, (t - chunk.s) * fps), fps, config: { damping: 12, mass: 0.5 } })
    : 0;

  // Mascot: pose swap pops, plus a gentle idle bob.
  const posePop = spring({
    frame: Math.max(0, (t - phase.start) * fps),
    fps,
    config: { damping: 13, mass: 0.7 },
  });
  const bob = Math.sin(frame / 14) * 8;

  // "Did you know" segments have no B side — one bigger, centered image.
  const single = !seg.bLabel;
  const imgSize = single ? 620 : 470;
  const imgY = 210; // slot top: 140px label zone + 18px gap, image at ~368
  const slotX = (side: "a" | "b") =>
    single ? (width - imgSize) / 2 : side === "a" ? 45 : width - 45 - imgSize;

  const slot = (side: "a" | "b") => {
    if (side === "b" && single) return null;
    const visible = side === "a" ? aVisible : bVisible;
    if (!visible) return null;
    const src = side === "a" ? seg.aImg : seg.bImg;
    const label = side === "a" ? seg.aLabel : seg.bLabel;
    const active = side === "a" ? aActive : bActive;
    const otherActive = side === "a" ? bActive : aActive;
    const pop = popIn(side === "a" ? aStart : bStart);
    return (
      <div
        style={{
          position: "absolute",
          left: slotX(side),
          top: imgY,
          width: imgSize,
          transform: `scale(${pop * (active ? 1.04 : 1)})`,
          opacity: pop * (otherActive ? 0.7 : 1),
          transformOrigin: "center top",
        }}
      >
        {/* Fixed-height label zone: a two-line label ("Virtual Background")
            must not push its image lower than the other slot's image. */}
        <div
          style={{
            fontFamily: "'Montserrat','Helvetica Neue',sans-serif",
            fontWeight: 800,
            fontSize: label.length > 12 ? 44 : 54,
            lineHeight: 1.15,
            color: "#111",
            textAlign: "center",
            height: 140,
            marginBottom: 18,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
          }}
        >
          <div>{label}</div>
        </div>
        {side === "a" && seg.aVideo ? (
          // Moving visual (DYK): loop the stock clip for as long as the slot
          // is on screen, cropped to the same rounded square as a still.
          <div
            style={{
              width: imgSize,
              height: imgSize,
              borderRadius: 28,
              overflow: "hidden",
              boxShadow: "0 10px 34px rgba(0,0,0,0.16)",
            }}
          >
            <Loop
              durationInFrames={Math.max(
                fps,
                Math.round((seg.aVideoDurationSec || 8) * fps),
              )}
              layout="none"
            >
              <OffthreadVideo
                muted
                src={staticFile(seg.aVideo)}
                style={{ width: imgSize, height: imgSize, objectFit: "cover" }}
              />
            </Loop>
          </div>
        ) : src ? (
          <div
            style={{
              width: imgSize,
              height: imgSize,
              borderRadius: 28,
              overflow: "hidden",
              boxShadow: "0 10px 34px rgba(0,0,0,0.16)",
            }}
          >
            <Img
              src={staticFile(src)}
              style={{
                width: imgSize,
                height: imgSize,
                objectFit: "cover",
                // Single-image (DYK) stills get a slow Ken Burns push-in so
                // the frame never sits fully static; pairs stay locked.
                transform: single
                  ? `scale(${1 + Math.min(0.14, Math.max(0, t - aStart) * 0.01)})`
                  : undefined,
              }}
            />
          </div>
        ) : (
          <div
            style={{
              width: imgSize,
              height: imgSize,
              borderRadius: 28,
              background: "#DDD9D4",
            }}
          />
        )}
      </div>
    );
  };

  return (
    <AbsoluteFill
      style={{ background: "linear-gradient(180deg,#F7F6F4 0%,#E9E7E3 100%)" }}
    >
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}

      <TechsplainsWordmark />

      {slot("a")}
      {slot("b")}

      {/* Watermark — back above the mascot (user preferred the original spot) */}
      <div
        style={{
          position: "absolute",
          top: 1160,
          width: "100%",
          textAlign: "center",
          fontFamily: "'Montserrat',sans-serif",
          fontWeight: 700,
          fontSize: 38,
          color: "#9B968F",
          opacity: 0.8,
        }}
      >
        {handle}
      </div>

      {/* Caption — between the images (~838 bottom) and watermark (1160) */}
      <div
        style={{
          position: "absolute",
          top: 880,
          left: 60,
          width: width - 120,
          height: 260,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {chunk ? (
          <div
            style={{
              fontFamily: "'Luckiest Guy','Montserrat',sans-serif",
              fontSize: 92,
              lineHeight: 1.05,
              textAlign: "center",
              color: accent,
              WebkitTextStroke: "10px #111",
              paintOrder: "stroke fill",
              transform: `scale(${0.82 + 0.18 * chunkPop})`,
              filter: "drop-shadow(0 6px 0 rgba(0,0,0,0.18))",
            }}
          >
            {chunk.words.map((w) => displayWord(w.w)).join(" ")}
          </div>
        ) : null}
      </div>

      {/* Mascot */}
      <div
        style={{
          position: "absolute",
          bottom: -6 + bob * -0.5,
          width: "100%",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <Img
          src={staticFile(POSE[phase.kind])}
          style={{
            height: 700,
            transform: `scale(${0.9 + 0.1 * posePop}) translateY(${bob}px)`,
            transformOrigin: "center bottom",
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
