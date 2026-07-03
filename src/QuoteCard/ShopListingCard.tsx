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
// Shop Listing Card — TikTok-Shop product carousel cards. ONE consistent look
// across all cards: the AI-generated product scene fills the frame (full-bleed,
// no borders), a dark vignette scrim sits under the text for contrast, and the
// type is white with GOLD (Tranzzie brand) accents and a large gold crest logo.
//   hero    — product + brand + dotted icon spec strip (dark)
//   front   — clean front-on product on PLAIN WHITE + feature-icon strip
//   studio  — lifestyle scene + leader-line callout
//   detail  — dark macro + material label
//   variant — product + script name + colour name
//   specs   — dark gold-accented "Lens Features" list
// Copy is brand-safe (features, never cures/guarantees).
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
  cardType: z.enum(["hero", "front", "studio", "detail", "variant", "specs", "model", "group"]).default("hero"),
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

export const SPECS: Record<SpecId, SpecDef> = {
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

// Tranzzie laurel-glasses brand mark (fallback when no logo file is present).
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
  brandName, establishedTag, pills, logoSrc, logoDarkSrc, brandGold,
}) => {
  useShopFonts();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const scale = width / 1080;
  const inset = Math.round(width * 0.06);
  const fade = interpolate(frame, [0, 16], [0, 1], { extrapolateRight: "clamp" });

  const photo = resolveSrc(photoSrc);
  const logoWhite = resolveSrc(logoSrc);   // gold crest + WHITE text — for dark
  const logoDark = resolveSrc(logoDarkSrc);
  const gold = brandGold;
  const DARK = "#141210";
  const chosen = (specs || []).map((id) => SPECS[id]).filter(Boolean);
  const tShadow = "0 2px 12px rgba(0,0,0,0.7)";

  const logoEl = (size: number) => {
    const src = logoWhite || logoDark;
    if (!src) return <BrandMark size={Math.round(size * 1.5)} color={gold} />;
    return <Img src={src} style={{ height: size, width: "auto", objectFit: "contain", filter: "drop-shadow(0 2px 14px rgba(0,0,0,0.65))" }} />;
  };
  const logoSize = Math.round(86 * scale);

  const cover = () =>
    photo ? (
      <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    ) : (
      <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.45)", fontFamily: ARCHIVO, fontSize: Math.round(22 * scale) }}>product photo</AbsoluteFill>
    );

  // Vignette under top + bottom text zones so white type always reads.
  const scrim = (
    <AbsoluteFill style={{ pointerEvents: "none", background: "linear-gradient(180deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.12) 19%, transparent 38%, transparent 55%, rgba(0,0,0,0.30) 75%, rgba(0,0,0,0.80) 100%)" }} />
  );

  // ── HERO — product + brand + dotted icon spec strip ───────────────────────
  if (cardType === "hero") {
    const strip = chosen.slice(0, 4);
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {scrim}
        <div style={{ position: "absolute", top: inset, left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          {logoEl(logoSize)}
          {productName && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(40 * scale), color: "#fff", lineHeight: 1, letterSpacing: "0.01em", textShadow: tShadow }}>{productName}</div>
              <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), letterSpacing: "0.34em", color: gold, marginTop: Math.round(7 * scale) }}>EYEGLASSES</div>
            </div>
          )}
        </div>
        {strip.length > 0 && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.05), left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            {strip.map((s, i) => (
              <Fragment key={s.id}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: Math.round(9 * scale), width: Math.round(168 * scale) }}>
                  <div style={{ width: Math.round(42 * scale), height: Math.round(42 * scale) }}>{s.icon("#fff")}</div>
                  <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), color: "#fff", textAlign: "center", lineHeight: 1.18, textShadow: tShadow }}>{s.chip}</div>
                </div>
                {i < strip.length - 1 && <div style={{ flex: 1, borderTop: `2px dotted ${gold}`, opacity: 0.85, marginTop: Math.round(20 * scale) }} />}
              </Fragment>
            ))}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── FRONT — clean front-on product on PLAIN WHITE + feature-icon strip.
  //    The marketplace "main listing" hero (LUSEEN / MetroSunnies style):
  //    product fully visible up top, icon row below, dark ink on white. ───────
  if (cardType === "front") {
    const ink = "#16130d";
    const frontLogo = logoDark || logoWhite;
    const strip = chosen.slice(0, 4);
    return (
      <AbsoluteFill style={{ background: "#ffffff", overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {/* Product sits in the upper-middle, FULLY visible (contain, never
            cropped); the lower band stays clean white for the icon strip. */}
        <div style={{ position: "absolute", top: Math.round(height * 0.135), left: 0, right: 0, height: Math.round(height * 0.56) }}>
          {photo ? (
            <Img src={photo} style={{ width: "100%", height: "100%", objectFit: "contain", objectPosition: "center" }} />
          ) : (
            <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#c4c0b8", fontFamily: ARCHIVO, fontSize: Math.round(22 * scale) }}>product photo</AbsoluteFill>
          )}
        </div>
        {/* Top row — dark logo + product name (dark ink on white). */}
        <div style={{ position: "absolute", top: inset, left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          {frontLogo ? (
            <Img src={frontLogo} style={{ height: logoSize, width: "auto", objectFit: "contain" }} />
          ) : (
            <BrandMark size={Math.round(logoSize * 1.5)} color={ink} />
          )}
          {productName && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(40 * scale), color: ink, lineHeight: 1, letterSpacing: "0.01em" }}>{productName}</div>
              <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), letterSpacing: "0.34em", color: gold, marginTop: Math.round(7 * scale) }}>EYEGLASSES</div>
            </div>
          )}
        </div>
        {/* Bottom — feature-icon strip in outlined chips, dark ink on white. */}
        {strip.length > 0 && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.055), left: inset, right: inset, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            {strip.map((s, i) => (
              <Fragment key={s.id}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: Math.round(10 * scale), width: Math.round(168 * scale) }}>
                  <div style={{ width: Math.round(60 * scale), height: Math.round(60 * scale), borderRadius: Math.round(13 * scale), border: `2px solid ${ink}`, display: "flex", alignItems: "center", justifyContent: "center", padding: Math.round(12 * scale) }}>{s.icon(ink)}</div>
                  <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), color: ink, textAlign: "center", lineHeight: 1.18 }}>{s.chip}</div>
                </div>
                {i < strip.length - 1 && <div style={{ flex: 1, borderTop: `2px dotted ${gold}`, opacity: 0.9, marginTop: Math.round(29 * scale) }} />}
              </Fragment>
            ))}
          </div>
        )}
      </AbsoluteFill>
    );
  }

  // ── STUDIO (lifestyle) — full scene + leader-line callout ─────────────────
  if (cardType === "studio") {
    const label = (materialLabel || pills?.[0] || "Premium Build").toUpperCase();
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {scrim}
        <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(logoSize)}</div>
        <div style={{ position: "absolute", left: inset, bottom: Math.round(height * 0.09) }}>
          <div style={{ width: Math.round(3 * scale), height: Math.round(72 * scale), background: gold, marginBottom: Math.round(14 * scale) }} />
          <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(30 * scale), color: "#fff", letterSpacing: "0.06em", lineHeight: 1.08, maxWidth: Math.round(width * 0.6), textShadow: tShadow }}>{label}</div>
        </div>
      </AbsoluteFill>
    );
  }

  // ── DETAIL — dark macro + material label ──────────────────────────────────
  if (cardType === "detail") {
    const matLabel = (materialLabel || "Premium Build").toUpperCase();
    const matSize = matLabel.length > 22 ? 22 : matLabel.length > 14 ? 26 : 30;
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {scrim}
        <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(logoSize)}</div>
        <div style={{ position: "absolute", top: inset, left: inset, right: inset, textAlign: "right" }}>
          <div style={{ fontFamily: ARCHIVO, fontWeight: 800, fontSize: Math.round(matSize * scale), letterSpacing: "0.12em", color: "#fff", lineHeight: 1.15, textShadow: tShadow }}>{matLabel}</div>
          <div style={{ width: Math.round(64 * scale), height: Math.round(3 * scale), background: gold, marginTop: Math.round(10 * scale), marginLeft: "auto" }} />
        </div>
        {featureLine && (
          <div style={{ position: "absolute", bottom: inset, left: inset, right: Math.round(width * 0.2), fontFamily: ARCHIVO, fontWeight: 400, fontSize: Math.round(22 * scale), color: "rgba(255,255,255,0.92)", lineHeight: 1.3, textShadow: tShadow }}>{featureLine}</div>
        )}
      </AbsoluteFill>
    );
  }

  // ── MODEL — worn by a model; text stays bottom-anchored, never on the face ─
  if (cardType === "model") {
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {scrim}
        <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(logoSize)}</div>
        <div style={{ position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.055) }}>
          {productName && (
            <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(56 * scale), color: "#fff", textTransform: "uppercase", lineHeight: 1.0, letterSpacing: "0.01em", textShadow: tShadow }}>{productName}</div>
          )}
          {colorLabel && (
            <div style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(20 * scale), letterSpacing: "0.28em", color: gold, textTransform: "uppercase", marginTop: Math.round(10 * scale), textShadow: tShadow }}>{colorLabel}</div>
          )}
        </div>
      </AbsoluteFill>
    );
  }

  // ── GROUP — multiple colorways in one shot ─────────────────────────────────
  if (cardType === "group") {
    const names = colorLabel.split(" · ").map((s) => s.trim()).filter(Boolean);
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {scrim}
        <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(logoSize)}</div>
        {names.length > 1 && (
          <div style={{ position: "absolute", top: inset, right: inset, textAlign: "right", fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), letterSpacing: "0.3em", color: gold, textShadow: tShadow }}>
            {names.length} COLORWAYS
          </div>
        )}
        <div style={{ position: "absolute", left: inset, right: inset, bottom: Math.round(height * 0.055) }}>
          {productName && (
            <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(52 * scale), color: "#fff", textTransform: "uppercase", lineHeight: 1.0, textShadow: tShadow }}>{productName}</div>
          )}
          {names.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: Math.round(10 * scale), marginTop: Math.round(14 * scale) }}>
              {names.map((n) => (
                <span key={n} style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(17 * scale), letterSpacing: "0.12em", color: "#fff", textTransform: "uppercase", border: `2px solid ${gold}`, borderRadius: 999, padding: `${Math.round(7 * scale)}px ${Math.round(16 * scale)}px`, textShadow: tShadow }}>{n}</span>
              ))}
            </div>
          )}
        </div>
      </AbsoluteFill>
    );
  }

  // ── VARIANT — product + script name + colour name ─────────────────────────
  if (cardType === "variant") {
    const colSize = colorLabel.length > 16 ? 38 : colorLabel.length > 10 ? 48 : 60;
    return (
      <AbsoluteFill style={{ background: DARK, overflow: "hidden", opacity: fade, fontFamily: ARCHIVO }}>
        {cover()}
        {scrim}
        <div style={{ position: "absolute", top: inset, left: inset }}>{logoEl(Math.round(72 * scale))}</div>
        {productName && (
          <div style={{ position: "absolute", top: Math.round(height * 0.035), right: inset, fontFamily: SCRIPT, fontSize: Math.round(124 * scale), color: gold, lineHeight: 0.9, textShadow: tShadow }}>{productName}</div>
        )}
        {colorLabel && (
          <div style={{ position: "absolute", bottom: Math.round(height * 0.06), left: inset, right: inset, textAlign: "right", fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(colSize * scale), letterSpacing: "0.02em", color: "#fff", textTransform: "uppercase", lineHeight: 1.02, textShadow: tShadow }}>{colorLabel}</div>
        )}
      </AbsoluteFill>
    );
  }

  // ── SPECS — dark gold-accented "Lens Features" list ───────────────────────
  const rows = (chosen.length ? chosen : [SPECS.anti_rad, SPECS.uv400, SPECS.photochromic]).slice(0, 4);
  const circle = Math.round(88 * scale);
  return (
    <AbsoluteFill style={{ background: `linear-gradient(160deg, #1c1813 0%, ${DARK} 100%)`, overflow: "hidden", opacity: fade, padding: inset, fontFamily: ARCHIVO }}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: Math.round(20 * scale) }}>
          <div>
            <div style={{ fontFamily: SCRIPT, fontSize: Math.round(50 * scale), color: gold, lineHeight: 0.7, marginLeft: Math.round(8 * scale) }}>our</div>
            <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontStretch: "125%", fontSize: Math.round(64 * scale), color: "#fff", letterSpacing: "-0.01em", textTransform: "uppercase", lineHeight: 0.92 }}>Lens Features</div>
          </div>
          {logoEl(logoSize)}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-evenly" }}>
          {rows.map((s, i) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: Math.round(24 * scale), padding: `${Math.round(10 * scale)}px 0`, borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.12)" }}>
              <div style={{ width: circle, height: circle, flexShrink: 0, borderRadius: "50%", background: gold, display: "flex", alignItems: "center", justifyContent: "center", padding: Math.round(22 * scale) }}>{s.icon(DARK)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: ARCHIVO, fontWeight: 900, fontSize: Math.round(32 * scale), color: "#fff", textTransform: "uppercase", letterSpacing: "0.01em" }}>{s.label}</div>
                <div style={{ fontFamily: ARCHIVO, fontWeight: 400, fontSize: Math.round(19 * scale), color: "rgba(255,255,255,0.72)", marginTop: Math.round(4 * scale), lineHeight: 1.3 }}>{s.line}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: Math.round(16 * scale), paddingTop: Math.round(16 * scale), borderTop: "1px solid rgba(255,255,255,0.14)" }}>
          <span style={{ fontFamily: ARCHIVO, fontWeight: 700, fontSize: Math.round(15 * scale), letterSpacing: "0.2em", color: "rgba(255,255,255,0.85)", textTransform: "uppercase" }}>{brandName}</span>
          {establishedTag ? (
            <span style={{ fontFamily: ARCHIVO, fontWeight: 500, fontSize: Math.round(13 * scale), letterSpacing: "0.3em", color: gold }}>• {establishedTag} •</span>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
