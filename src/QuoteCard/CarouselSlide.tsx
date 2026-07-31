import { useEffect, useState } from "react";
import { AbsoluteFill, Img, continueRender, delayRender, staticFile } from "remotion";
import { z } from "zod";
import { AspectRatio, aspectRatioSchema, aspectToDimensions } from "./aspect";

// ─────────────────────────────────────────────────────────────────────────
// Carousel teaching / CTA slide.
//
// These used to be generated per-slide by an image model, which caused two
// problems this component exists to remove:
//
//  1. TEXT ACCURACY. Image models garbled Tagalog — "blankong" for blangkong,
//     and four different manglings of nagsisimula across six renders. Here the
//     copy is real text in a real font, so it is exactly what was approved.
//  2. CONSISTENCY. Every generated slide reinvented its own background, so a
//     six-slide set never quite matched. A template cannot drift.
//
// It is also free and instant instead of ~2 credits and ~40s per slide.
//
// The background is either a plate generated ONCE and reused across every
// slide and every batch (bgSrc), or a native CSS aurora when no plate is set.
// Either way it is identical on every slide by construction.
// ─────────────────────────────────────────────────────────────────────────

export const carouselSlideSchema = z.object({
  kind: z.enum(["teaching", "cta"]).default("teaching"),
  /** Teaching: "01". CTA: unused. */
  numeral: z.string().default(""),
  /** CTA only: small gold line above the headline. */
  kicker: z.string().default(""),
  headline: z.string().default(""),
  body: z.string().default(""),
  slideIndex: z.number().default(2),
  slideTotal: z.number().default(6),
  /** Optional pre-generated background plate, relative to public/. */
  bgSrc: z.string().default(""),
  brandGold: z.string().default("#F4B400"),
  aspectRatio: aspectRatioSchema,
});

export type CarouselSlideProps = z.infer<typeof carouselSlideSchema>;

export const calcMetaCarouselSlide = ({ props }: { props: CarouselSlideProps }) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 1 };
};

const ARCHIVO = "'Archivo','Helvetica Neue',Arial,sans-serif";

const useSlideFont = () => {
  const [handle] = useState(() => delayRender("load-carousel-font"));
  useEffect(() => {
    new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, {
      weight: "100 900",
      stretch: "62% 125%",
    })
      .load()
      .then((f) => { document.fonts.add(f); continueRender(handle); })
      .catch(() => continueRender(handle));
  }, [handle]);
};

const resolveSrc = (src: string) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try { return staticFile(src); } catch { return null; }
};

export const CarouselSlide: React.FC<CarouselSlideProps> = ({
  kind, numeral, kicker, headline, body, slideIndex, slideTotal, bgSrc, brandGold, aspectRatio,
}) => {
  useSlideFont();
  const { width } = aspectToDimensions(aspectRatio as AspectRatio);
  const s = width / 1080; // scale everything off the 1080-wide reference
  const gold = brandGold;
  const plate = resolveSrc(bgSrc);

  // Body length varies a lot between slides; step the size so a long paragraph
  // stays inside the panel without the layout having to reflow.
  const bodyLen = (body || "").length;
  const bodySize = bodyLen > 165 ? 30 : bodyLen > 120 ? 33 : 36;

  const panelPad = Math.round(64 * s);

  return (
    <AbsoluteFill style={{ background: "#0A0A0C", fontFamily: ARCHIVO, overflow: "hidden" }}>
      {/* Background — one plate reused everywhere, or a native aurora. */}
      {plate ? (
        <Img src={plate} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <AbsoluteFill
          style={{
            background:
              "radial-gradient(95% 65% at 12% 8%, rgba(96,132,255,0.55) 0%, rgba(10,10,12,0) 60%)," +
              "radial-gradient(85% 60% at 92% 22%, rgba(0,224,178,0.40) 0%, rgba(10,10,12,0) 60%)," +
              "radial-gradient(100% 70% at 78% 96%, rgba(178,96,255,0.45) 0%, rgba(10,10,12,0) 62%)," +
              "radial-gradient(80% 55% at 30% 78%, rgba(255,150,90,0.20) 0%, rgba(10,10,12,0) 58%)," +
              "linear-gradient(155deg, #191922 0%, #0C0C10 55%, #08080A 100%)",
          }}
        />
      )}
      {/* Keeps text contrast stable even if a plate is bright in places. */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(8,8,10,0.30) 0%, rgba(8,8,10,0.55) 100%)" }} />

      {/* Frosted panel */}
      <AbsoluteFill style={{ padding: Math.round(70 * s), display: "flex", alignItems: "stretch", justifyContent: "center" }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            borderRadius: Math.round(40 * s),
            padding: panelPad,
            background: "rgba(24,24,28,0.58)",
            border: `${Math.max(1, Math.round(1.5 * s))}px solid rgba(255,255,255,0.13)`,
            boxShadow: `0 ${Math.round(30 * s)}px ${Math.round(80 * s)}px rgba(0,0,0,0.55)`,
            backdropFilter: `blur(${Math.round(28 * s)}px)`,
            WebkitBackdropFilter: `blur(${Math.round(28 * s)}px)`,
          }}
        >
          {/* Window chrome — the cue that reads as "Apple UI" */}
          <div style={{ display: "flex", gap: Math.round(11 * s), marginBottom: Math.round(52 * s) }}>
            {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
              <div key={c} style={{ width: Math.round(15 * s), height: Math.round(15 * s), borderRadius: "50%", background: c }} />
            ))}
          </div>

          {/* Content group is centred so a short body does not leave a void
              under it, which the top-aligned version did. */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          {kind === "cta" && kicker ? (
            <div
              style={{
                fontSize: Math.round(23 * s), fontWeight: 700, letterSpacing: "0.22em",
                textTransform: "uppercase", color: gold, marginBottom: Math.round(22 * s),
              }}
            >
              {kicker}
            </div>
          ) : null}

          {kind === "teaching" && numeral ? (
            <div
              style={{
                fontSize: Math.round(112 * s), fontWeight: 800, lineHeight: 0.9,
                color: gold, letterSpacing: "-0.02em", marginBottom: Math.round(20 * s),
              }}
            >
              {numeral}
            </div>
          ) : null}

          <div
            style={{
              fontSize: Math.round(56 * s), fontWeight: 800, lineHeight: 1.08,
              letterSpacing: "-0.015em", color: "#FFFFFF", textTransform: "uppercase",
            }}
          >
            {headline}
          </div>

          <div
            style={{
              height: Math.max(1, Math.round(1.5 * s)),
              background: "rgba(255,255,255,0.16)",
              margin: `${Math.round(34 * s)}px 0`,
            }}
          />

          <div
            style={{
              fontSize: Math.round(bodySize * s), fontWeight: 400, lineHeight: 1.5,
              color: "rgba(255,255,255,0.80)", whiteSpace: "pre-wrap",
            }}
          >
            {body}
          </div>

          </div>

          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              fontSize: Math.round(22 * s), color: "rgba(255,255,255,0.42)", fontWeight: 600,
            }}
          >
            <span style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>Jurie</span>
            <span>{slideIndex}/{slideTotal}</span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
