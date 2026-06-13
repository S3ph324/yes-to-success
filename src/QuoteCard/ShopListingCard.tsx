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
// Shop Listing Card — TikTok-Shop-style product carousel cards.
//
// The user's REAL product photo is placed as-is and Tranzzie brand graphics
// are composited over it (deterministic — no AI redraw of the frame). One
// composition, five card types matching the reference carousels:
//   hero    — product large, brand wordmark, spec-icon strip across the bottom
//   studio  — product on a white card, black letterbox, wordmark + feature pills
//   detail  — product on a dark dramatic field with a material/finish label
//   variant — product on a clean field with a big colour-name label
//   specs   — a spec-feature breakdown (icon + name + brand-safe line per row)
//
// Copy is brand-safe: no competitor trademarks, and specs are stated as
// FEATURES (e.g. "blue-light filtering"), never as cures or guarantees.
// ─────────────────────────────────────────────────────────────────────────

export const SPEC_IDS = [
  "anti_rad",
  "uv400",
  "photochromic",
  "polarized",
  "anti_glare",
  "anti_scratch",
] as const;
export type SpecId = (typeof SPEC_IDS)[number];

export const shopListingCardSchema = z.object({
  photoSrc: z.string().default(""),
  cardType: z.enum(["hero", "studio", "detail", "variant", "specs"]).default("hero"),
  specs: z.array(z.enum(SPEC_IDS)).default([]),
  productName: z.string().default(""),
  colorLabel: z.string().default(""),
  materialLabel: z.string().default(""),
  featureLine: z.string().default(""),
  brandName: z.string().default("Tranzzie Eyeglasses"),
  // White-lettering logo — used on DARK surfaces.
  logoSrc: z.string().default(""),
  // Dark-lettering logo — used on LIGHT surfaces so the wordmark stays crisp.
  // Falls back to logoSrc + a dark edge-outline when not provided.
  logoDarkSrc: z.string().default(""),
  // Tranzzie brand colours (config/brand-presets.json → preset_tranzzie).
  brandGold: z.string().default("#F4B400"),
  brandRed: z.string().default("#E11522"),
  aspectRatio: aspectRatioSchema,
});

export type ShopListingCardProps = z.infer<typeof shopListingCardSchema>;

export const calcMetaShopListingCard = ({
  props,
}: {
  props: ShopListingCardProps;
}) => {
  const { width, height } = aspectToDimensions(props.aspectRatio as AspectRatio);
  return { width, height, fps: 30, durationInFrames: 60 };
};

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

const ARCHIVO = "'Archivo','Helvetica Neue',Arial,sans-serif";
const FRAUNCES = "'Fraunces',Georgia,serif";

const useShopFonts = () => {
  const [handle] = useState(() => delayRender("load-shop-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" }),
      new FontFace("Fraunces", `url(${staticFile("fonts/Fraunces.ttf")}) format("truetype")`, { weight: "100 900" }),
    ];
    Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l))))
      .then(() => continueRender(handle))
      .catch(() => continueRender(handle));
  }, [handle]);
};

// ── Spec definitions ───────────────────────────────────────────────────────
// label = short chip text; line = one brand-safe descriptive sentence (feature,
// never a cure/guarantee). icon = inline SVG drawn in `accent`.
type SpecDef = { id: SpecId; label: string; chip: string; line: string; icon: (c: string) => React.ReactNode };

const stroke = (c: string, w = 2) => ({ fill: "none", stroke: c, strokeWidth: w, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

const SPECS: Record<SpecId, SpecDef> = {
  anti_rad: {
    id: "anti_rad",
    label: "Anti-Radiation",
    chip: "Blue Light Filter",
    line: "Filters blue light from screens for easier all-day wear.",
    icon: (c) => (
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <rect x="8" y="10" width="32" height="22" rx="2" {...stroke(c)} />
        <path d="M18 38h12M24 32v6" {...stroke(c)} />
        <path d="M16 21h4l2-4 3 8 2-4h5" {...stroke(c)} />
      </svg>
    ),
  },
  uv400: {
    id: "uv400",
    label: "UV400",
    chip: "100% UV Protection",
    line: "Blocks 100% of UVA and UVB rays outdoors.",
    icon: (c) => (
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <circle cx="24" cy="24" r="8" {...stroke(c)} />
        <path d="M24 6v5M24 37v5M6 24h5M37 24h5M11 11l3.5 3.5M33.5 33.5L37 37M37 11l-3.5 3.5M14.5 33.5L11 37" {...stroke(c)} />
      </svg>
    ),
  },
  photochromic: {
    id: "photochromic",
    label: "Photochromic",
    chip: "Adapts to Light",
    line: "Clear indoors, darkens automatically in sunlight.",
    icon: (c) => (
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <circle cx="24" cy="24" r="11" {...stroke(c)} />
        <path d="M24 13a11 11 0 000 22z" fill={c} stroke="none" />
        <path d="M24 4v4M24 40v4M4 24h4M40 24h4" {...stroke(c)} />
      </svg>
    ),
  },
  polarized: {
    id: "polarized",
    label: "Polarized",
    chip: "Glare-Free Clarity",
    line: "Cuts harsh reflected glare for clearer vision.",
    icon: (c) => (
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <path d="M10 16h28M10 24h28M10 32h28" {...stroke(c, 2.4)} />
        <path d="M16 10l16 28" {...stroke(c, 2.4)} />
      </svg>
    ),
  },
  anti_glare: {
    id: "anti_glare",
    label: "Anti-Glare",
    chip: "AR Coating",
    line: "Anti-reflective coating for cleaner night and screen views.",
    icon: (c) => (
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <circle cx="24" cy="24" r="9" {...stroke(c)} />
        <path d="M24 8v6M24 34v6M8 24h6M34 24h6M13 13l4 4M31 31l4 4" {...stroke(c)} />
      </svg>
    ),
  },
  anti_scratch: {
    id: "anti_scratch",
    label: "Anti-Scratch",
    chip: "Durable Coating",
    line: "Hardened coating that resists everyday scratches.",
    icon: (c) => (
      <svg viewBox="0 0 48 48" width="100%" height="100%">
        <path d="M24 6l14 5v11c0 9-6 15-14 18-8-3-14-9-14-18V11z" {...stroke(c)} />
        <path d="M18 23l4 4 8-9" {...stroke(c, 2.4)} />
      </svg>
    ),
  },
};

// ── Tranzzie laurel-glasses brand mark (drawn so it tints to any colour) ─────
const BrandMark: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 120 60" width={size} height={size * 0.5} style={{ display: "block" }}>
    {/* laurel left + right */}
    <path d="M18 30c-8-2-12-8-12-8s5-1 9 2M18 38c-8 0-13-4-13-4s5-3 10-2M22 22c-7-4-9-11-9-11s5 1 8 5" {...stroke(color, 2)} />
    <path d="M102 30c8-2 12-8 12-8s-5-1-9 2M102 38c8 0 13-4 13-4s-5-3-10-2M98 22c7-4 9-11 9-11s-5 1-8 5" {...stroke(color, 2)} />
    {/* twin lenses */}
    <path d="M30 28c0-6 6-9 12-9s12 3 12 11-5 12-12 12-12-6-12-14z" {...stroke(color, 3)} />
    <path d="M66 30c0-8 5-11 12-11s12 3 12 9-6 14-12 14-12-6-12-12z" {...stroke(color, 3)} />
    <path d="M54 26h12" {...stroke(color, 3)} />
  </svg>
);

// Wordmark lockup: mark + brand name + "SINCE 2019".
const Wordmark: React.FC<{ name: string; gold: string; color: string; scale: number; center?: boolean }> = ({
  name, gold, color, scale, center,
}) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: center ? "center" : "flex-start", gap: Math.round(6 * scale) }}>
    <BrandMark size={Math.round(86 * scale)} color={gold} />
    <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(20 * scale), letterSpacing: "0.22em", color, textTransform: "uppercase" }}>
      {name}
    </div>
    <div style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(11 * scale), letterSpacing: "0.42em", color: gold }}>
      • SINCE 2019 •
    </div>
  </div>
);

// A single spec node in the hero strip: icon-in-circle + tiny caps label.
const SpecNode: React.FC<{ spec: SpecDef; gold: string; ink: string; scale: number }> = ({ spec, gold, ink, scale }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: Math.round(7 * scale), width: Math.round(150 * scale) }}>
    <div style={{
      width: Math.round(56 * scale), height: Math.round(56 * scale), borderRadius: "50%",
      border: `1.5px solid ${gold}`, padding: Math.round(13 * scale),
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(255,255,255,0.7)",
    }}>
      {spec.icon(gold)}
    </div>
    <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(13 * scale), letterSpacing: "0.04em", color: ink, textAlign: "center", lineHeight: 1.2 }}>
      {spec.chip}
    </div>
  </div>
);

export const ShopListingCard: React.FC<ShopListingCardProps> = ({
  photoSrc, cardType, specs, productName, colorLabel, materialLabel, featureLine,
  brandName, logoSrc, logoDarkSrc, brandGold, brandRed,
}) => {
  useShopFonts();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(Math.min(width, height) * 0.06);
  const fade = interpolate(frame, [0, 18], [0, 1], { extrapolateRight: "clamp" });

  const photo = resolveSrc(photoSrc);
  const logoWhite = resolveSrc(logoSrc);
  const logoDark = resolveSrc(logoDarkSrc);
  const ink = "#1b1822";
  const muted = "rgba(27,24,34,0.6)";
  const chosen = (specs || []).map((id) => SPECS[id]).filter(Boolean);

  const logoGlowDark = "drop-shadow(0 3px 14px rgba(0,0,0,0.5))";
  // Fallback edge-outline for when only the white logo exists and it must sit
  // on a light card — gives the white lettering a dark stroke so it reads.
  const logoEdgeLight =
    "drop-shadow(0 0 1px rgba(0,0,0,0.75)) drop-shadow(0 0 2px rgba(0,0,0,0.55)) drop-shadow(0 1px 3px rgba(0,0,0,0.4))";
  // Pick the right logo for the surface: dark-lettering logo on light cards,
  // white logo on dark cards. Falls back gracefully when one variant is absent.
  const brandLogo = (size: number, opts?: { onDark?: boolean; center?: boolean }) => {
    const onDark = !!opts?.onDark;
    const src = onDark ? (logoWhite || logoDark) : (logoDark || logoWhite);
    if (!src) {
      return <Wordmark name={brandName} gold={brandGold} color={onDark ? "#fff" : ink} scale={scale} center={opts?.center} />;
    }
    const usingFallback = onDark ? !logoWhite : !logoDark; // had to borrow the other variant
    const filter = onDark
      ? logoGlowDark
      : usingFallback ? logoEdgeLight : "none"; // dark logo on light needs no outline
    return <Img src={src} style={{ height: size, width: "auto", objectFit: "contain", filter }} />;
  };

  const productImg = (style: React.CSSProperties) =>
    photo ? (
      <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "contain", ...style }} />
    ) : (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: muted, fontFamily: ARCHIVO }}>
        product photo
      </div>
    );

  // ── HERO — product large + spec-icon strip across the bottom ──────────────
  if (cardType === "hero") {
    return (
      <AbsoluteFill style={{ background: "linear-gradient(170deg, #ffffff 0%, #f3eee4 100%)", overflow: "hidden", opacity: fade }}>
        {/* faint brand watermark — dark logo reads on the light field; the
            white logo would be invisible, so fall back to the drawn gold mark. */}
        <div style={{ position: "absolute", top: "30%", left: "50%", transform: "translate(-50%,-50%)", opacity: 0.06 }}>
          {logoDark ? (
            <Img src={logoDark} style={{ width: Math.round(720 * scale), height: "auto", objectFit: "contain" }} />
          ) : (
            <BrandMark size={Math.round(640 * scale)} color={brandGold} />
          )}
        </div>
        <div style={{ position: "absolute", top: inset, left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          {brandLogo(Math.round(64 * scale))}
          {productName && (
            <div style={{ fontFamily: FRAUNCES, fontStyle: "italic", fontSize: Math.round(30 * scale), color: brandGold }}>{productName}</div>
          )}
        </div>
        <div style={{ position: "absolute", top: "14%", left: inset, right: inset, bottom: "26%" }}>
          {productImg({})}
        </div>
        {/* spec strip */}
        {chosen.length > 0 && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.06), left: 0, right: 0, display: "flex", justifyContent: "center", alignItems: "flex-start", gap: Math.round(4 * scale) }}>
            {chosen.slice(0, 4).map((s, i) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center" }}>
                <SpecNode spec={s} gold={brandGold} ink={ink} scale={scale} />
                {i < Math.min(chosen.length, 4) - 1 && (
                  <div style={{ width: Math.round(22 * scale), height: 1.5, background: brandGold, opacity: 0.5, margin: `0 ${Math.round(-6 * scale)}px`, marginBottom: Math.round(26 * scale) }} />
                )}
              </div>
            ))}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── STUDIO — white card, black letterbox, wordmark + feature pills ────────
  if (cardType === "studio") {
    const pills = ["Free 15-Day Returns", "Premium Build", "Fashion Forward"];
    return (
      <AbsoluteFill style={{ background: "#0c0b0e", overflow: "hidden", opacity: fade }}>
        <div style={{ position: "absolute", top: "11%", left: 0, right: 0, bottom: "16%" }}>
          <div style={{ position: "absolute", inset: 0, background: "#fbf9f5" }} />
          <div style={{ position: "absolute", top: Math.round(40 * scale), left: 0, right: 0, display: "flex", justifyContent: "center" }}>
            {brandLogo(Math.round(54 * scale), { center: true })}
          </div>
          <div style={{ position: "absolute", top: "20%", left: inset, right: inset, bottom: "8%" }}>
            {productImg({})}
          </div>
        </div>
        {/* bottom black band: brand name + feature pills */}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "16%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: `0 ${inset}px` }}>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(22 * scale), letterSpacing: "0.16em", color: "#fff", textTransform: "uppercase" }}>
            {brandName.split(" ")[0]}
          </div>
          <div style={{ display: "flex", gap: Math.round(18 * scale) }}>
            {pills.map((p) => (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: Math.round(6 * scale) }}>
                <div style={{ width: Math.round(7 * scale), height: Math.round(7 * scale), borderRadius: "50%", background: brandGold }} />
                <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(14 * scale), color: "rgba(255,255,255,0.82)" }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    );
  }

  // ── DETAIL — dark dramatic field + material/finish label ──────────────────
  if (cardType === "detail") {
    return (
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 40%, #2a2a30 0%, #0a0a0c 100%)", overflow: "hidden", opacity: fade }}>
        <AbsoluteFill style={{ top: "8%", bottom: "8%", left: "4%", right: "4%" }}>
          {productImg({ filter: "drop-shadow(0 20px 50px rgba(0,0,0,0.6))" })}
        </AbsoluteFill>
        {/* label line top-right */}
        <div style={{ position: "absolute", top: inset, right: inset, textAlign: "right" }}>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(26 * scale), letterSpacing: "0.14em", color: "#fff", textTransform: "uppercase", lineHeight: 1.2 }}>
            {materialLabel || "Premium Build"}
          </div>
          <div style={{ width: Math.round(70 * scale), height: 2, background: brandGold, marginTop: Math.round(10 * scale), marginLeft: "auto" }} />
        </div>
        {featureLine && (
          <div style={{ position: "absolute", bottom: inset, left: inset, right: inset, fontFamily: FRAUNCES, fontStyle: "italic", fontSize: Math.round(24 * scale), color: "rgba(255,255,255,0.85)" }}>
            {featureLine}
          </div>
        )}
        <div style={{ position: "absolute", bottom: inset, right: inset }}>{brandLogo(Math.round(46 * scale), { onDark: true })}</div>
      </AbsoluteFill>
    );
  }

  // ── VARIANT — clean field + big colour-name label ─────────────────────────
  if (cardType === "variant") {
    return (
      <AbsoluteFill style={{ background: "linear-gradient(160deg,#f7f4ee 0%,#efe9dd 100%)", overflow: "hidden", opacity: fade }}>
        {productName && (
          <div style={{ position: "absolute", top: inset, left: inset, right: inset, fontFamily: FRAUNCES, fontStyle: "italic", fontWeight: 500, fontSize: Math.round(46 * scale), color: brandRed }}>
            {productName}
          </div>
        )}
        <AbsoluteFill style={{ top: "16%", bottom: "16%", left: "6%", right: "6%" }}>
          {productImg({ filter: "drop-shadow(0 22px 44px rgba(0,0,0,0.18))" })}
        </AbsoluteFill>
        {colorLabel && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.08), right: inset, fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(54 * scale), letterSpacing: "0.04em", color: brandRed, textTransform: "uppercase" }}>
            {colorLabel}
          </div>
        )}
        <div style={{ position: "absolute", bottom: inset, left: inset }}>{brandLogo(Math.round(48 * scale))}</div>
      </AbsoluteFill>
    );
  }

  // ── SPECS — feature breakdown (icon + name + brand-safe line per row) ──────
  return (
    <AbsoluteFill style={{ background: "#fbf9f5", overflow: "hidden", opacity: fade, padding: inset }}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2px solid ${ink}`, paddingBottom: Math.round(16 * scale) }}>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(42 * scale), letterSpacing: "0.02em", color: ink, textTransform: "uppercase" }}>
            Lens Features
          </div>
          {brandLogo(Math.round(56 * scale))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: Math.round(20 * scale) }}>
          {(chosen.length ? chosen : [SPECS.anti_rad, SPECS.uv400]).map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: Math.round(22 * scale) }}>
              <div style={{ width: Math.round(72 * scale), height: Math.round(72 * scale), flexShrink: 0, borderRadius: Math.round(16 * scale), background: "#fff", border: `1.5px solid ${brandGold}`, padding: Math.round(17 * scale) }}>
                {s.icon(brandGold)}
              </div>
              <div>
                <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(27 * scale), letterSpacing: "0.02em", color: ink }}>{s.label}</div>
                <div style={{ fontFamily: ARCHIVO, fontWeight: 400, fontSize: Math.round(18 * scale), color: muted, marginTop: Math.round(3 * scale), lineHeight: 1.35 }}>{s.line}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `1px solid rgba(27,24,34,0.15)`, paddingTop: Math.round(16 * scale) }}>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(16 * scale), letterSpacing: "0.2em", color: ink, textTransform: "uppercase" }}>{brandName}</span>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(13 * scale), letterSpacing: "0.3em", color: brandGold }}>• SINCE 2019 •</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
