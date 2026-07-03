import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Img,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { AspectRatio, aspectRatioSchema, aspectToDimensions } from "./aspect";
import { SPECS, SPEC_IDS } from "./ShopListingCard";

// ─────────────────────────────────────────────────────────────────────────
// Feature / Infographic card — the "lens technology" ad (Essilor Stellest /
// Eyezen style). The AI supplies ONLY a clean angled lens photo with negative
// space; everything technical is drawn here programmatically: a glowing focus
// point on the lens with concentric dotted rings + a tech-grid patch, leader
// lines to spec callouts (driven by the user's spec checkboxes), and a big
// brand-safe claim line. The AI never draws text or graphics.
// ─────────────────────────────────────────────────────────────────────────

export const featureInfographicCardSchema = z.object({
  photoSrc: z.string().default(""),
  specs: z.array(z.enum(SPEC_IDS)).default([]),
  productName: z.string().default(""),
  claimLine: z.string().default(""), // empty → derived from the first spec
  brandName: z.string().default("Tranzzie Eyeglasses"),
  logoSrc: z.string().default(""),
  brandGold: z.string().default("#F4B400"),
  // Where the lens sits in the AI image (fractions of width/height). The
  // feature prompt asks for an off-centre lens; upper-centre is the default.
  focusX: z.number().min(0).max(1).default(0.46),
  focusY: z.number().min(0).max(1).default(0.4),
  aspectRatio: aspectRatioSchema,
});

export type FeatureInfographicCardProps = z.infer<typeof featureInfographicCardSchema>;

export const calcMetaFeatureInfographicCard = ({ props }: { props: FeatureInfographicCardProps }) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 60 };
};

const ARCHIVO = "'Archivo','Helvetica Neue',Arial,sans-serif";

const resolveSrc = (src: string) => {
  if (!src) return null;
  if (/^https?:\/\//.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return `file://${src}`;
  try {
    return staticFile(src);
  } catch {
    return null;
  }
};

const useFonts = () => {
  const [handle] = useState(() => delayRender("load-infographic-fonts"));
  useEffect(() => {
    const f = new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" });
    f.load()
      .then((l) => { document.fonts.add(l); continueRender(handle); })
      .catch(() => continueRender(handle));
  }, [handle]);
};

export const FeatureInfographicCard: React.FC<FeatureInfographicCardProps> = ({
  photoSrc, specs, productName, claimLine, brandName, logoSrc, brandGold, focusX, focusY,
}) => {
  useFonts();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(width * 0.06);
  const gold = brandGold;

  const photo = resolveSrc(photoSrc);
  const logo = resolveSrc(logoSrc);
  const chosen = (specs || []).map((id) => SPECS[id]).filter(Boolean).slice(0, 3);
  const claim = (claimLine || "").trim() || (chosen[0] ? chosen[0].line : "Engineered for all-day visual comfort.");

  // Animation: everything settles by frame ~40 (the renderer captures frame 40).
  const fade = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp" });
  const ringGrow = interpolate(frame, [4, 34], [0.65, 1], { extrapolateRight: "clamp" });
  const lineDraw = interpolate(frame, [12, 38], [0, 1], { extrapolateRight: "clamp" });
  const labelFade = interpolate(frame, [20, 40], [0, 1], { extrapolateRight: "clamp" });

  const cx = focusX * width;
  const cy = focusY * height;
  const R = 210 * scale; // outer ring radius
  const rings = [0.45, 0.72, 1].map((f) => R * f * ringGrow);

  // Callouts stack on the side with more room.
  const dir = focusX <= 0.5 ? 1 : -1; // 1 → labels on the right
  const labelW = Math.round(300 * scale);
  const rowH = Math.round(150 * scale);
  const labelX = dir > 0 ? Math.min(cx + R + 80 * scale, width - inset - labelW) : Math.max(cx - R - 80 * scale - labelW, inset);
  const angles = [-0.55, 0, 0.55]; // radians offset around the horizontal
  const callouts = chosen.map((s, i) => {
    const a = angles[i] ?? 0;
    const mx = cx + Math.cos(a) * R * dir;
    const my = cy + Math.sin(a) * R;
    const ly = cy + (i - (chosen.length - 1) / 2) * rowH;
    const lxEdge = dir > 0 ? labelX : labelX + labelW;
    return { s, mx, my, ly, lxEdge };
  });

  const tShadow = "0 2px 12px rgba(0,0,0,0.6)";
  const dot = Math.round(9 * scale);

  return (
    <AbsoluteFill style={{ background: "#101013", overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
      {photo ? (
        <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontSize: Math.round(22 * scale) }}>lens photo</AbsoluteFill>
      )}
      {/* Bottom scrim so the claim always reads. */}
      <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, rgba(0,0,0,0.30) 0%, transparent 22%, transparent 58%, rgba(0,0,0,0.72) 100%)" }} />

      {/* ── Programmatic tech overlay (SVG) ── */}
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <defs>
          <radialGradient id="fg-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#dff1ff" stopOpacity="0.55" />
            <stop offset="45%" stopColor="#9fd4ff" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#9fd4ff" stopOpacity="0" />
          </radialGradient>
          <pattern id="fg-grid" width={34 * scale} height={34 * scale} patternUnits="userSpaceOnUse">
            <path d={`M ${34 * scale} 0 L 0 0 0 ${34 * scale}`} fill="none" stroke="#cfe9ff" strokeWidth={1.2 * scale} opacity="0.5" />
          </pattern>
          <clipPath id="fg-gridclip">
            <circle cx={cx} cy={cy} r={rings[1]} />
          </clipPath>
        </defs>

        {/* soft glow + tech grid clipped around the focus point */}
        <circle cx={cx} cy={cy} r={R * 1.25} fill="url(#fg-glow)" />
        <rect x={cx - rings[1]} y={cy - rings[1]} width={rings[1] * 2} height={rings[1] * 2} fill="url(#fg-grid)" clipPath="url(#fg-gridclip)" opacity={0.5 * lineDraw} />

        {/* concentric dotted rings */}
        {rings.map((r, i) => (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={i === rings.length - 1 ? gold : "#e8f4ff"} strokeWidth={(i === rings.length - 1 ? 3 : 2.2) * scale} strokeLinecap="round" strokeDasharray={`0.1 ${(i === 0 ? 11 : 14) * scale}`} opacity={0.9 - i * 0.15} />
        ))}
        <circle cx={cx} cy={cy} r={5.5 * scale} fill="#ffffff" />
        <circle cx={cx} cy={cy} r={11 * scale} fill="none" stroke="#ffffff" strokeWidth={2 * scale} opacity={0.9} />

        {/* leader lines: focus ring → elbow → label edge */}
        {callouts.map(({ mx, my, ly, lxEdge }, i) => {
          const midX = mx + (lxEdge - mx) * 0.55;
          const p = `M ${mx} ${my} L ${midX} ${ly} L ${lxEdge} ${ly}`;
          const len = Math.abs(lxEdge - mx) + Math.abs(ly - my);
          return (
            <g key={i} opacity={labelFade}>
              <path d={p} fill="none" stroke="#ffffff" strokeWidth={2.4 * scale} strokeDasharray={len} strokeDashoffset={len * (1 - lineDraw)} opacity={0.92} />
              <circle cx={mx} cy={my} r={dot / 2} fill={gold} />
            </g>
          );
        })}
      </svg>

      {/* spec callout labels (HTML so fonts/wrapping behave) */}
      {callouts.map(({ s, ly, lxEdge }) => (
        <div key={s.id} style={{ position: "absolute", left: dir > 0 ? lxEdge + 14 * scale : undefined, right: dir > 0 ? undefined : width - lxEdge + 14 * scale, top: ly - 44 * scale, width: labelW, opacity: labelFade, display: "flex", alignItems: "center", gap: Math.round(14 * scale), flexDirection: dir > 0 ? "row" : "row-reverse", textAlign: dir > 0 ? "left" : "right" }}>
          <div style={{ width: Math.round(58 * scale), height: Math.round(58 * scale), flexShrink: 0, borderRadius: "50%", border: `2.5px solid ${gold}`, background: "rgba(10,10,14,0.55)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: Math.round(12 * scale) }}>{s.icon("#ffffff")}</div>
          <div>
            <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(24 * scale), color: "#fff", lineHeight: 1.1, textShadow: tShadow }}>{s.label}</div>
            <div style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: Math.round(15 * scale), letterSpacing: "0.08em", color: gold, textTransform: "uppercase", marginTop: Math.round(3 * scale), textShadow: tShadow }}>{s.chip}</div>
          </div>
        </div>
      ))}

      {/* logo top-right */}
      <div style={{ position: "absolute", top: inset, right: inset }}>
        {logo ? <Img src={logo} style={{ height: Math.round(80 * scale), width: "auto", objectFit: "contain", filter: "drop-shadow(0 2px 14px rgba(0,0,0,0.65))" }} /> : null}
      </div>

      {/* claim block bottom-left */}
      <div style={{ position: "absolute", left: inset, right: Math.round(width * 0.22), bottom: Math.round(height * 0.055), opacity: labelFade }}>
        {productName && (
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(17 * scale), letterSpacing: "0.3em", color: gold, textTransform: "uppercase", marginBottom: Math.round(12 * scale), textShadow: tShadow }}>{productName}</div>
        )}
        <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(40 * scale), color: "#fff", lineHeight: 1.14, letterSpacing: "0.005em", textShadow: tShadow }}>{claim}</div>
        <div style={{ width: Math.round(70 * scale), height: Math.round(4 * scale), background: gold, marginTop: Math.round(16 * scale) }} />
        <div style={{ fontFamily: ARCHIVO, fontWeight: 600, fontSize: Math.round(13 * scale), letterSpacing: "0.24em", color: "rgba(255,255,255,0.8)", textTransform: "uppercase", marginTop: Math.round(12 * scale) }}>{brandName}</div>
      </div>
    </AbsoluteFill>
  );
};
