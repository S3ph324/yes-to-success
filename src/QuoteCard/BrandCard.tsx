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

// ─────────────────────────────────────────────────────────────────────────
// Brand Card — "brand-a-photo": take ONE eyeglasses photo (the real upload, a
// cleaned-up version, or an AI re-shoot — decided upstream by the render
// script) and composite Tranzzie branding (a tagline + optional logo) onto it,
// in one of four switchable layouts. Deliberately light and flexible — the
// image can be the actual photo, unlike the TikTok Shop cards.
// ─────────────────────────────────────────────────────────────────────────

export const BRAND_LAYOUTS = ["minimal", "banner", "editorial", "badge"] as const;
export type BrandLayout = (typeof BRAND_LAYOUTS)[number];

export const brandCardSchema = z.object({
  photoSrc: z.string().default(""),
  tagline: z.string().default(""),
  productName: z.string().default(""),
  logoSrc: z.string().default(""),
  showLogo: z.boolean().default(true),
  layout: z.enum(BRAND_LAYOUTS).default("minimal"),
  brandGold: z.string().default("#F4B400"),
  brandName: z.string().default("Tranzzie Eyeglasses"),
  establishedTag: z.string().default("SINCE 2019"),
  aspectRatio: aspectRatioSchema,
});

export type BrandCardProps = z.infer<typeof brandCardSchema>;

export const calcMetaBrandCard = ({ props }: { props: BrandCardProps }) => {
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

const useBrandFonts = () => {
  const [handle] = useState(() => delayRender("load-brand-fonts"));
  useEffect(() => {
    const f = new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" });
    f.load()
      .then((l) => { document.fonts.add(l); continueRender(handle); })
      .catch(() => continueRender(handle));
  }, [handle]);
};

// Tranzzie laurel-glasses mark (fallback when there is no logo file).
const BrandMark: React.FC<{ size: number; color: string }> = ({ size, color }) => {
  const s = (w = 2) => ({ fill: "none", stroke: color, strokeWidth: w, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });
  return (
    <svg viewBox="0 0 120 60" width={size} height={size * 0.5} style={{ display: "block" }}>
      <path d="M18 30c-8-2-12-8-12-8s5-1 9 2M18 38c-8 0-13-4-13-4s5-3 10-2M22 22c-7-4-9-11-9-11s5 1 8 5" {...s(2)} />
      <path d="M102 30c8-2 12-8 12-8s-5-1-9 2M102 38c8 0 13-4 13-4s-5-3-10-2M98 22c7-4 9-11 9-11s-5 1-8 5" {...s(2)} />
      <path d="M30 28c0-6 6-9 12-9s12 3 12 11-5 12-12 12-12-6-12-14z" {...s(3)} />
      <path d="M66 30c0-8 5-11 12-11s12 3 12 9-6 14-12 14-12-6-12-12z" {...s(3)} />
      <path d="M54 26h12" {...s(3)} />
    </svg>
  );
};

export const BrandCard: React.FC<BrandCardProps> = ({
  photoSrc, tagline, productName, logoSrc, showLogo, layout, brandGold, brandName, establishedTag,
}) => {
  useBrandFonts();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(width * 0.06);
  const gold = brandGold;
  const DARK = "#141210";
  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });
  const rise = interpolate(frame, [4, 22], [Math.round(24 * scale), 0], { extrapolateRight: "clamp" });
  const tShadow = "0 2px 14px rgba(0,0,0,0.6)";

  const photo = resolveSrc(photoSrc);
  const logo = resolveSrc(logoSrc);
  const tagSize = tagline.length > 80 ? 34 : tagline.length > 48 ? 40 : 48;

  const logoEl = (size: number, tone: "light" | "dark") => {
    if (!showLogo) return null;
    if (logo) return <Img src={logo} style={{ height: size, width: "auto", objectFit: "contain", filter: tone === "light" ? "drop-shadow(0 2px 12px rgba(0,0,0,0.5))" : "none" }} />;
    return <BrandMark size={Math.round(size * 1.5)} color={tone === "light" ? "#fff" : DARK} />;
  };

  const cover = (fit: "cover" | "contain" = "cover") =>
    photo ? (
      <Img src={photo} style={{ width: "100%", height: "100%", objectFit: fit }} />
    ) : (
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.4)", fontFamily: ARCHIVO, fontSize: Math.round(22 * scale) }}>eyeglasses photo</AbsoluteFill>
    );

  const scrim = (
    <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.10) 20%, transparent 42%, transparent 52%, rgba(0,0,0,0.35) 74%, rgba(0,0,0,0.82) 100%)" }} />
  );

  const nameEl = productName ? (
    <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(17 * scale), letterSpacing: "0.3em", color: gold, textTransform: "uppercase", marginBottom: Math.round(10 * scale) }}>{productName}</div>
  ) : null;

  const establishedEl = establishedTag ? (
    <div style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(12 * scale), letterSpacing: "0.3em", color: gold, marginTop: Math.round(12 * scale), textTransform: "uppercase" }}>• {establishedTag} •</div>
  ) : null;

  // ── MINIMAL — full-bleed photo, logo top-left, tagline bottom-left ─────────
  if (layout === "minimal") {
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}{scrim}
        {showLogo && <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(Math.round(84 * scale), "light")}</div>}
        <div style={{ position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.06), transform: `translateY(${rise}px)` }}>
          {nameEl}
          {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(tagSize * scale), color: "#fff", lineHeight: 1.12, letterSpacing: "0.005em", maxWidth: Math.round(width * 0.82), textShadow: tShadow }}>{tagline}</div>}
          <div style={{ width: Math.round(70 * scale), height: Math.round(4 * scale), background: gold, marginTop: Math.round(16 * scale) }} />
        </div>
      </AbsoluteFill>
    );
  }

  // ── BANNER — photo on top, solid brand band across the bottom ──────────────
  if (layout === "banner") {
    const bandH = Math.round(height * 0.26);
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: height - bandH }}>{cover()}</div>
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: bandH, background: DARK, borderTop: `${Math.round(4 * scale)}px solid ${gold}`, display: "flex", alignItems: "center", gap: Math.round(22 * scale), padding: `0 ${inset}px` }}>
          {showLogo && logoEl(Math.round(78 * scale), "light")}
          <div style={{ flex: 1, transform: `translateY(${rise}px)` }}>
            {nameEl}
            {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round((tagSize - 4) * scale), color: "#fff", lineHeight: 1.1 }}>{tagline}</div>}
          </div>
          {establishedTag && <div style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(12 * scale), letterSpacing: "0.28em", color: gold, whiteSpace: "nowrap", textTransform: "uppercase" }}>{establishedTag}</div>}
        </div>
      </AbsoluteFill>
    );
  }

  // ── EDITORIAL — split: photo one side, solid panel with big tagline ────────
  if (layout === "editorial") {
    const panelW = Math.round(width * 0.42);
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: width - panelW }}>{cover()}</div>
        <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: panelW, background: `linear-gradient(160deg, #1c1813 0%, ${DARK} 100%)`, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: inset }}>
          <div>{showLogo && logoEl(Math.round(80 * scale), "light")}</div>
          <div style={{ transform: `translateY(${rise}px)` }}>
            {nameEl}
            {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round((tagSize + 2) * scale), color: "#fff", lineHeight: 1.1 }}>{tagline}</div>}
            <div style={{ width: Math.round(60 * scale), height: Math.round(4 * scale), background: gold, marginTop: Math.round(16 * scale) }} />
          </div>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(13 * scale), letterSpacing: "0.22em", color: "rgba(255,255,255,0.8)", textTransform: "uppercase" }}>{brandName}{establishedTag ? ` · ${establishedTag}` : ""}</div>
        </div>
      </AbsoluteFill>
    );
  }

  // ── BADGE — full-bleed photo + floating rounded card (logo + tagline) ──────
  return (
    <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
      {cover()}
      <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.35) 100%)" }} />
      <div style={{ position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.06), transform: `translateY(${rise}px)` }}>
        <div style={{ background: "rgba(20,18,16,0.78)", backdropFilter: "blur(6px)", border: `1px solid rgba(255,255,255,0.14)`, borderRadius: Math.round(18 * scale), padding: `${Math.round(22 * scale)}px ${Math.round(26 * scale)}px`, display: "flex", alignItems: "center", gap: Math.round(20 * scale) }}>
          {showLogo && <div style={{ flexShrink: 0 }}>{logoEl(Math.round(72 * scale), "light")}</div>}
          <div>
            {nameEl}
            {tagline && <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round((tagSize - 6) * scale), color: "#fff", lineHeight: 1.12 }}>{tagline}</div>}
            {establishedEl}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
