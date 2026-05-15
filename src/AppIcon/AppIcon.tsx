import { AbsoluteFill, Img, staticFile } from "remotion";
import { z } from "zod";

export const appIconSchema = z.object({
  logoSrc: z.string().default("yes-to-success-logo.png"),
  brandPrimary: z.string().default("#C8001E"),
  brandDeep: z.string().default("#3A0008"),
  brandAccent: z.string().default("#FFE17A"),
  brandAccentDeep: z.string().default("#C9952B"),
});

export type AppIconProps = z.infer<typeof appIconSchema>;

export const AppIcon: React.FC<AppIconProps> = ({
  logoSrc,
  brandPrimary,
  brandDeep,
  brandAccent,
  brandAccentDeep,
}) => {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 50% 40%, ${brandPrimary} 0%, ${brandDeep} 75%, #1A0204 100%)`,
        fontFamily: "Georgia, serif",
        overflow: "hidden",
      }}
    >
      {/* Subtle gold radiance from corners */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at top left, rgba(255,225,122,0.18) 0%, transparent 45%), " +
            "radial-gradient(ellipse at bottom right, rgba(255,225,122,0.12) 0%, transparent 45%)",
        }}
      />

      {/* Dark vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(circle at 50% 50%, transparent 50%, rgba(0,0,0,0.65) 100%)",
        }}
      />

      {/* Gold border frame (rounded) */}
      <div
        style={{
          position: "absolute",
          inset: 56,
          border: "5px solid",
          borderImage: `linear-gradient(135deg, #FFF1B8 0%, ${brandAccent} 35%, ${brandAccentDeep} 70%, #A07417 100%) 1`,
          borderRadius: 0,
          opacity: 0.85,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 76,
          border: `2px solid ${brandAccent}55`,
        }}
      />

      {/* Corner gold accents */}
      {(
        [
          { top: 56, left: 56, t: true, l: true },
          { top: 56, right: 56, t: true, r: true },
          { bottom: 56, left: 56, b: true, l: true },
          { bottom: 56, right: 56, b: true, r: true },
        ] as const
      ).map((c, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            ...("top" in c ? { top: c.top } : {}),
            ...("bottom" in c ? { bottom: c.bottom } : {}),
            ...("left" in c ? { left: c.left } : {}),
            ...("right" in c ? { right: c.right } : {}),
            width: 72,
            height: 72,
            borderTop:
              "t" in c && c.t ? `6px solid ${brandAccent}` : "none",
            borderBottom:
              "b" in c && c.b ? `6px solid ${brandAccent}` : "none",
            borderLeft:
              "l" in c && c.l ? `6px solid ${brandAccent}` : "none",
            borderRight:
              "r" in c && c.r ? `6px solid ${brandAccent}` : "none",
            opacity: 0.95,
          }}
        />
      ))}

      {/* Centered logo */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 160,
        }}
      >
        <Img
          src={staticFile(logoSrc)}
          style={{
            width: "100%",
            height: "auto",
            maxHeight: "70%",
            objectFit: "contain",
            filter:
              "drop-shadow(0 12px 36px rgba(0,0,0,0.65)) drop-shadow(0 4px 12px rgba(255,225,122,0.15))",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
