import { Fragment, useEffect, useState } from "react";
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
// Shop Listing Card — TikTok-Shop product carousel cards, styled after real
// top-selling eyewear listings (MetroSunnies / LUSEEN references): bright and
// clean, the product as the hero, a dotted icon spec strip, leader-line
// callouts, a script product name, a colour-name card, and a rounded-panel
// "Lens Features" infographic. The seller's REAL photo is composited as-is —
// no AI redraw. Copy is brand-safe (features, never cures/guarantees).
//   hero    — product on white + brand + dotted icon spec strip
//   studio  — lifestyle photo + leader-line callout (scrim keeps text legible)
//   detail  — dark dramatic close-up, framed, + leader-line material label
//   variant — white card + script product name + big colour name
//   specs   — rounded-panel "Lens Features" infographic
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
  establishedTag: z.string().default("SINCE 2019"),
  pills: z.array(z.string()).default(["Premium Build", "Fashion Forward", "Everyday Comfort"]),
  logoSrc: z.string().default(""),
  logoDarkSrc: z.string().default(""),
  brandGold: z.string().default("#F4B400"),
  brandRed: z.string().default("#E11522"),
  aspectRatio: aspectRatioSchema,
});

export type ShopListingCardProps = z.infer<typeof shopListingCardSchema>;

export const calcMetaShopListingCard = ({ props }: { props: ShopListingCardProps }) => {
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
const SCRIPT = "'Sacramento','Snell Roundhand',cursive";

const useShopFonts = () => {
  const [handle] = useState(() => delayRender("load-shop-fonts"));
  useEffect(() => {
    const faces = [
      new FontFace("Archivo", `url(${staticFile("fonts/Archivo.ttf")}) format("truetype")`, { weight: "100 900", stretch: "62% 125%" }),
      new FontFace("Sacramento", `url(${staticFile("fonts/Sacramento.ttf")}) format("truetype")`),
    ];
    Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l))))
      .then(() => continueRender(handle))
      .catch(() => continueRender(handle));
  }, [handle]);
};

const stroke = (c: string, w = 2) => ({ fill: "none", stroke: c, strokeWidth: w, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

type SpecDef = { id: SpecId; label: string; chip: string; line: string; icon: (c: string) => React.ReactNode };

const SPECS: Record<SpecId, SpecDef> = {
  anti_rad: {
    id: "anti_rad", label: "Anti-Radiation", chip: "Blocks Blue Light",
    line: "Filters blue light from screens for easier all-day wear.",
    icon: (c) => (<svg viewBox="0 0 48 48" width="100%" height="100%"><rect x="8" y="10" width="32" height="22" rx="2" {...stroke(c)} /><path d="M18 38h12M24 32v6" {...stroke(c)} /><path d="M16 21h4l2-4 3 8 2-4h5" {...stroke(c)} /></svg>),
  },
  uv400: {
    id: "uv400", label: "UV400", chip: "100% UV Protection",
    line: "Blocks 100% of UVA and UVB rays outdoors.",
    icon: (c) => (<svg viewBox="0 0 48 48" width="100%" height="100%"><circle cx="24" cy="24" r="8" {...stroke(c)} /><path d="M24 6v5M24 37v5M6 24h5M37 24h5M11 11l3.5 3.5M33.5 33.5L37 37M37 11l-3.5 3.5M14.5 33.5L11 37" {...stroke(c)} /></svg>),
  },
  photochromic: {
    id: "photochromic", label: "Photochromic", chip: "Adapts to Light",
    line: "Clear indoors, darkens automatically in sunlight.",
    icon: (c) => (<svg viewBox="0 0 48 48" width="100%" height="100%"><circle cx="24" cy="24" r="11" {...stroke(c)} /><path d="M24 13a11 11 0 000 22z" fill={c} stroke="none" /><path d="M24 4v4M24 40v4M4 24h4M40 24h4" {...stroke(c)} /></svg>),
  },
  polarized: {
    id: "polarized", label: "Polarized", chip: "Glare-Free Clarity",
    line: "Cuts harsh reflected glare for clearer vision.",
    icon: (c) => (<svg viewBox="0 0 48 48" width="100%" height="100%"><path d="M10 16h28M10 24h28M10 32h28" {...stroke(c, 2.4)} /><path d="M16 10l16 28" {...stroke(c, 2.4)} /></svg>),
  },
  anti_glare: {
    id: "anti_glare", label: "Anti-Glare", chip: "AR Coating",
    line: "Anti-reflective coating for cleaner night and screen views.",
    icon: (c) => (<svg viewBox="0 0 48 48" width="100%" height="100%"><circle cx="24" cy="24" r="9" {...stroke(c)} /><path d="M24 8v6M24 34v6M8 24h6M34 24h6M13 13l4 4M31 31l4 4" {...stroke(c)} /></svg>),
  },
  anti_scratch: {
    id: "anti_scratch", label: "Anti-Scratch", chip: "Durable Coating",
    line: "Hardened coating that resists everyday scratches.",
    icon: (c) => (<svg viewBox="0 0 48 48" width="100%" height="100%"><path d="M24 6l14 5v11c0 9-6 15-14 18-8-3-14-9-14-18V11z" {...stroke(c)} /><path d="M18 23l4 4 8-9" {...stroke(c, 2.4)} /></svg>),
  },
};

// Tranzzie laurel-glasses brand mark (drawn so it tints to any colour).
const BrandMark: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg viewBox="0 0 120 60" width={size} height={size * 0.5} style={{ display: "block" }}>
    <path d="M18 30c-8-2-12-8-12-8s5-1 9 2M18 38c-8 0-13-4-13-4s5-3 10-2M22 22c-7-4-9-11-9-11s5 1 8 5" {...stroke(color, 2)} />
    <path d="M102 30c8-2 12-8 12-8s-5-1-9 2M102 38c8 0 13-4 13-4s-5-3-10-2M98 22c7-4 9-11 9-11s-5 1-8 5" {...stroke(color, 2)} />
    <path d="M30 28c0-6 6-9 12-9s12 3 12 11-5 12-12 12-12-6-12-14z" {...stroke(color, 3)} />
    <path d="M66 30c0-8 5-11 12-11s12 3 12 9-6 14-12 14-12-6-12-12z" {...stroke(color, 3)} />
    <path d="M54 26h12" {...stroke(color, 3)} />
  </svg>
);

export const ShopListingCard: React.FC<ShopListingCardProps> = ({
  photoSrc, cardType, specs, productName, colorLabel, materialLabel, featureLine,
  brandName, establishedTag, pills, logoSrc, logoDarkSrc, brandGold, brandRed,
}) => {
  useShopFonts();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(width * 0.07);
  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });

  const photo = resolveSrc(photoSrc);
  const logoWhite = resolveSrc(logoSrc);
  const logoDark = resolveSrc(logoDarkSrc);
  const ink = "#17151c";
  const sub = "#6f6b74";
  const chosen = (specs || []).map((id) => SPECS[id]).filter(Boolean);

  // Brand logo: dark-lettering on light surfaces, white on dark; drawn mark when
  // no logo file is present.
  const brandLogo = (size: number, onDark = false) => {
    const src = onDark ? (logoWhite || logoDark) : (logoDark || logoWhite);
    if (!src) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(10 * scale) }}>
          <BrandMark size={Math.round(size * 1.5)} color={onDark ? "#fff" : brandRed} />
          <span style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(size * 0.42), letterSpacing: "0.04em", color: onDark ? "#fff" : ink }}>
            {brandName.split(" ")[0]}
          </span>
        </div>
      );
    }
    const fallback = onDark ? !logoWhite : !logoDark;
    const filter = onDark
      ? "drop-shadow(0 2px 10px rgba(0,0,0,0.5))"
      : fallback ? "drop-shadow(0 0 1px rgba(0,0,0,0.7)) drop-shadow(0 1px 2px rgba(0,0,0,0.4))" : "none";
    return <Img src={src} style={{ height: size, width: "auto", objectFit: "contain", filter }} />;
  };

  const placeholder = (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: sub, fontFamily: ARCHIVO, fontSize: Math.round(22 * scale) }}>
      product photo
    </div>
  );
  const productContain = (st?: React.CSSProperties) =>
    photo ? <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "contain", ...st }} /> : placeholder;

  // ── HERO — product on white + brand + dotted icon spec strip ──────────────
  if (cardType === "hero") {
    const strip = chosen.slice(0, 4);
    const iconC = "#2c2a33";
    return (
      <AbsoluteFill style={{ background: "linear-gradient(180deg,#ffffff 0%,#f5f1ea 100%)", overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {/* faint screen/laptop motif behind the product (blue-light context) */}
        <svg viewBox="0 0 100 100" width="74%" height="74%" style={{ position: "absolute", top: "8%", left: "50%", transform: "translateX(-50%)", opacity: 0.05 }}>
          <rect x="24" y="22" width="52" height="38" rx="3" {...stroke(brandRed, 1.3)} />
          <rect x="32" y="30" width="36" height="24" rx="2" {...stroke(brandRed, 1)} />
          <path d="M16 70h68l-6 9H22z" {...stroke(brandRed, 1.3)} />
        </svg>
        <div style={{ position: "absolute", top: inset, left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          {brandLogo(Math.round(56 * scale))}
          {productName && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(34 * scale), letterSpacing: "0.01em", color: ink, lineHeight: 1 }}>{productName}</div>
              <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(13 * scale), letterSpacing: "0.3em", color: brandRed, marginTop: Math.round(5 * scale) }}>EYEGLASSES</div>
            </div>
          )}
        </div>
        <div style={{ position: "absolute", top: "17%", left: inset, right: inset, bottom: "29%" }}>{productContain()}</div>
        {strip.length > 0 && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.07), left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            {strip.map((s, i) => (
              <Fragment key={s.id}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: Math.round(10 * scale), width: Math.round(168 * scale) }}>
                  <div style={{ width: Math.round(42 * scale), height: Math.round(42 * scale) }}>{s.icon(iconC)}</div>
                  <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), color: ink, textAlign: "center", lineHeight: 1.18 }}>{s.chip}</div>
                </div>
                {i < strip.length - 1 && (
                  <div style={{ flex: 1, borderTop: `2px dotted ${brandRed}`, opacity: 0.55, marginTop: Math.round(20 * scale) }} />
                )}
              </Fragment>
            ))}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── STUDIO — lifestyle photo + leader-line callout ────────────────────────
  if (cardType === "studio") {
    const label = (materialLabel || pills?.[0] || "Premium Build").toUpperCase();
    return (
      <AbsoluteFill style={{ background: "#eceae6", overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        <AbsoluteFill>
          {photo ? <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : placeholder}
        </AbsoluteFill>
        {/* legibility scrims (top for the logo, bottom for the callout) */}
        <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.28) 0%, transparent 22%, transparent 58%, rgba(0,0,0,0.45) 100%)" }} />
        <div style={{ position: "absolute", top: inset, left: inset }}>{brandLogo(Math.round(46 * scale), true)}</div>
        <div style={{ position: "absolute", left: inset, bottom: Math.round(height * 0.1) }}>
          <div style={{ width: Math.round(2.5 * scale), height: Math.round(72 * scale), background: "#fff", marginBottom: Math.round(14 * scale), boxShadow: "0 0 8px rgba(0,0,0,0.5)" }} />
          <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(28 * scale), color: "#fff", letterSpacing: "0.06em", lineHeight: 1.08, maxWidth: Math.round(width * 0.6), textShadow: "0 2px 10px rgba(0,0,0,0.6)" }}>{label}</div>
        </div>
      </AbsoluteFill>
    );
  }

  // ── DETAIL — dark dramatic close-up, framed, + leader-line material label ──
  if (cardType === "detail") {
    const matLabel = (materialLabel || "Premium Build").toUpperCase();
    const matSize = matLabel.length > 22 ? 20 : matLabel.length > 14 ? 24 : 28;
    return (
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 38%, #2b2b31 0%, #08080a 100%)", overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        <div style={{ position: "absolute", top: "14%", bottom: "16%", left: "9%", right: "9%", borderRadius: Math.round(22 * scale), overflow: "hidden", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0 30px 70px rgba(0,0,0,0.55)" }}>
          {photo ? <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : placeholder}
          <AbsoluteFill style={{ boxShadow: "inset 0 0 70px rgba(0,0,0,0.4)", pointerEvents: "none" }} />
        </div>
        <div style={{ position: "absolute", top: inset, left: inset, right: inset, textAlign: "right" }}>
          <div style={{ display: "inline-block" }}>
            <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(matSize * scale), letterSpacing: "0.12em", color: "#fff", lineHeight: 1.15 }}>{matLabel}</div>
            <div style={{ width: Math.round(64 * scale), height: 2, background: brandRed, marginTop: Math.round(10 * scale), marginLeft: "auto" }} />
          </div>
        </div>
        {featureLine && (
          <div style={{ position: "absolute", bottom: inset, left: inset, right: Math.round(width * 0.24), fontFamily: ARCHIVO, fontWeight: 400, fontSize: Math.round(21 * scale), color: "rgba(255,255,255,0.82)", lineHeight: 1.3 }}>{featureLine}</div>
        )}
        <div style={{ position: "absolute", bottom: inset, right: inset }}>{brandLogo(Math.round(42 * scale), true)}</div>
      </AbsoluteFill>
    );
  }

  // ── VARIANT — white card + script product name + big colour name ──────────
  if (cardType === "variant") {
    const colSize = colorLabel.length > 16 ? 36 : colorLabel.length > 10 ? 46 : 58;
    return (
      <AbsoluteFill style={{ background: "linear-gradient(160deg,#fbf8f3 0%,#efe9df 100%)", overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {productName && (
          <div style={{ position: "absolute", top: Math.round(height * 0.04), left: inset, fontFamily: SCRIPT, fontSize: Math.round(132 * scale), color: brandRed, lineHeight: 0.9 }}>{productName}</div>
        )}
        <div style={{ position: "absolute", top: "23%", bottom: "16%", left: "9%", right: "9%" }}>
          {productContain({ filter: "drop-shadow(0 22px 42px rgba(0,0,0,0.16))" })}
        </div>
        {colorLabel && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.07), left: inset, right: inset, textAlign: "right", fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(colSize * scale), letterSpacing: "0.02em", color: brandRed, textTransform: "uppercase", lineHeight: 1.02 }}>{colorLabel}</div>
        )}
        <div style={{ position: "absolute", bottom: inset, left: inset }}>{brandLogo(Math.round(40 * scale))}</div>
      </AbsoluteFill>
    );
  }

  // ── SPECS — rounded-panel "Lens Features" infographic ─────────────────────
  const panels = (chosen.length ? chosen : [SPECS.anti_rad, SPECS.uv400, SPECS.photochromic]).slice(0, 4);
  const circle = Math.round(100 * scale);
  return (
    <AbsoluteFill style={{ background: "#fcf9f4", overflow: "hidden", opacity: fade, padding: inset, fontFamily: ARCHIVO }}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* header: script kicker + bold red title + logo */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: Math.round(22 * scale) }}>
          <div>
            <div style={{ fontFamily: SCRIPT, fontSize: Math.round(52 * scale), color: ink, lineHeight: 0.7, marginLeft: Math.round(8 * scale) }}>our</div>
            <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(66 * scale), color: brandRed, letterSpacing: "-0.01em", textTransform: "uppercase", lineHeight: 0.92 }}>Lens Features</div>
          </div>
          {brandLogo(Math.round(52 * scale))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-evenly", gap: Math.round(16 * scale) }}>
          {panels.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: Math.round(20 * scale), background: brandRed, borderRadius: Math.round(24 * scale), padding: `${Math.round(22 * scale)}px ${Math.round(26 * scale)}px`, boxShadow: "0 12px 26px rgba(225,21,34,0.20)" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontSize: Math.round(31 * scale), color: "#fff", textTransform: "uppercase", letterSpacing: "0.01em", lineHeight: 1.05 }}>{s.label}</div>
                <div style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(19 * scale), color: "rgba(255,255,255,0.92)", marginTop: Math.round(5 * scale), lineHeight: 1.3 }}>{s.line}</div>
              </div>
              <div style={{ width: circle, height: circle, flexShrink: 0, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: Math.round(26 * scale) }}>{s.icon(brandRed)}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: Math.round(18 * scale) }}>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), letterSpacing: "0.2em", color: ink, textTransform: "uppercase" }}>{brandName}</span>
          {establishedTag ? (
            <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(13 * scale), letterSpacing: "0.3em", color: brandRed }}>• {establishedTag} •</span>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
