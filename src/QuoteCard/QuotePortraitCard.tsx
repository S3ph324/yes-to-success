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
// Quote Portrait Card — a full-bleed BLACK-AND-WHITE portrait of Jurie with a
// centred serif quote near the bottom, one word marker-highlighted in gold,
// and Jurie's signature/handle below. Inspired by the B&W motivational-quote
// format, but always Jurie: Jurie's photo, Jurie's voice, no attribution to
// anyone else.
// ─────────────────────────────────────────────────────────────────────────

export const quotePortraitCardSchema = z.object({
  bgSrc: z.string().default(""),
  body: z.string().default(""),
  // One word from the body to highlight with a gold marker swipe.
  accent: z.string().default(""),
  handle: z.string().default("@learnwithjurie"),
  logoSrc: z.string().default(""),
  brandGold: z.string().default("#F5C13B"),
  aspectRatio: aspectRatioSchema,
});

export type QuotePortraitCardProps = z.infer<typeof quotePortraitCardSchema>;

export const calcMetaQuotePortraitCard = ({ props }: { props: QuotePortraitCardProps }) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 90 };
};

const resolveSrc = (src: string) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try { return staticFile(src); } catch { return null; }
};

const FRAUNCES = "'Fraunces',Georgia,serif";
const ARCHIVO = "'Archivo','Helvetica Neue',Arial,sans-serif";

const usePortraitFonts = () => {
  const [h] = useState(() => delayRender("load-portrait-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace("Fraunces", `url(${staticFile("fonts/Fraunces.ttf")}) format("truetype")`, { weight: "100 900" }),
      new FontFace("Fraunces", `url(${staticFile("fonts/Fraunces-Italic.ttf")}) format("truetype")`, { weight: "100 900", style: "italic" }),
      new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" }),
    ];
    Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l))))
      .then(() => continueRender(h)).catch(() => continueRender(h));
  }, [h]);
};

const norm = (s: string) => s.replace(/[.,!?;:"'""]/g, "").toLowerCase();

/** Render a run of words; bold optional; the accent word gets a gold marker
 *  swipe under it (like a highlighter). */
const Run: React.FC<{ text: string; bold: boolean; accent: string; gold: string }> = ({
  text, bold, accent, gold,
}) => {
  const acc = norm(accent || "");
  return (
    <>
      {text.split(/(\s+)/).map((tok, i) => {
        if (/^\s+$/.test(tok)) return tok;
        const isAccent = acc && norm(tok) === acc;
        return (
          <span
            key={i}
            style={{
              fontWeight: bold ? 700 : 400,
              ...(isAccent
                ? { background: `linear-gradient(180deg, transparent 78%, ${gold} 78%, ${gold} 92%, transparent 92%)`, padding: "0 0.04em" }
                : {}),
            }}
          >
            {tok}
          </span>
        );
      })}
    </>
  );
};

export const QuotePortraitCard: React.FC<QuotePortraitCardProps> = ({
  bgSrc, body, accent, handle, logoSrc, brandGold,
}) => {
  usePortraitFonts();
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = width / 1080;

  const fade = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });
  const lift = spring({ frame, fps, from: 28, to: 0, durationInFrames: 32 });
  const bgScale = interpolate(frame, [0, 90], [1.06, 1.0], { extrapolateRight: "clamp" });

  const bg = resolveSrc(bgSrc);
  const logo = resolveSrc(logoSrc);
  const inset = Math.round(width * 0.08);

  // Bold the first sentence (up to the first period), the rest regular — the
  // GaryVee structure (lead line bold, the elaboration lighter).
  const text = (body || "").trim();
  const dot = text.indexOf(".");
  const head = dot >= 0 ? text.slice(0, dot + 1) : "";
  const tail = dot >= 0 ? text.slice(dot + 1).trim() : text;

  // Auto-size the quote so it fits the lower third without overflowing.
  const contentW = width - inset * 2;
  const cpl = Math.max(10, Math.floor(contentW / (44 * scale * 0.5)));
  const estLines = Math.max(1, Math.ceil(text.length / cpl));
  const quoteSize = Math.round((estLines > 6 ? 38 : estLines > 4 ? 46 : 56) * scale);

  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      {/* Full-bleed black & white portrait */}
      {bg ? (
        <AbsoluteFill style={{ transform: `scale(${bgScale})` }}>
          <Img
            src={bg}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "grayscale(1) contrast(1.06) brightness(0.96)" }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 30%, #2a2a2a 0%, #000 100%)" }} />
      )}
      {/* Bottom darkening so the white serif reads on any photo */}
      <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 38%, rgba(0,0,0,0.55) 62%, rgba(0,0,0,0.9) 100%)" }} />

      {/* Centred quote + signature, anchored toward the bottom */}
      <div style={{
        position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.06),
        textAlign: "center", opacity: fade, transform: `translateY(${lift}px)`,
      }}>
        <div style={{ fontFamily: FRAUNCES, fontSize: quoteSize, color: "#fff", lineHeight: 1.28, letterSpacing: "-0.005em", textShadow: "0 2px 20px rgba(0,0,0,0.6)" }}>
          {head && <Run text={head} bold accent={accent} gold={brandGold} />}
          {head && " "}
          <Run text={tail} bold={false} accent={accent} gold={brandGold} />
        </div>
        {/* Signature row */}
        <div style={{ marginTop: Math.round(28 * scale), display: "flex", flexDirection: "column", alignItems: "center", gap: Math.round(8 * scale) }}>
          {logo
            ? <Img src={logo} style={{ height: Math.round(46 * scale), width: "auto", objectFit: "contain", filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))" }} />
            : null}
          <span style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: Math.round(20 * scale), letterSpacing: "0.16em", textTransform: "uppercase", color: brandGold }}>{handle}</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
