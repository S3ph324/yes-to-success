import { z } from "zod";

export const aspectRatioSchema = z
  .enum(["1:1", "4:5", "9:16"])
  .default("4:5");

export type AspectRatio = z.infer<typeof aspectRatioSchema>;

export const aspectToDimensions = (ratio: AspectRatio) => {
  switch (ratio) {
    case "1:1":
      return { width: 1080, height: 1080 };
    case "9:16":
      return { width: 1080, height: 1920 };
    case "4:5":
    default:
      return { width: 1080, height: 1350 };
  }
};

// Per-aspect tuning so layouts feel intentional, not stretched.
// All values are pixels for the current canvas height.
export const layoutForAspect = (
  ratio: AspectRatio,
  height: number,
) => {
  // logoTop: distance from top to logo
  // logoHeight: rendered height of the logo
  // signoffBottom: distance from bottom of card to top of signoff group
  // padTopForQuote: top padding that pushes the quote below the logo
  // padBotForQuote: bottom padding above the signoff group
  switch (ratio) {
    case "1:1":
      return {
        logoTop: Math.round(height * 0.06),
        logoHeight: Math.round(height * 0.2),
        signoffBottom: Math.round(height * 0.07),
        signoffSize: 32,
        subtitleSize: 16,
        urlBottom: Math.round(height * 0.03),
        urlSize: 14,
        padX: 70,
      };
    case "9:16":
      return {
        logoTop: Math.round(height * 0.09),
        logoHeight: Math.round(height * 0.17),
        signoffBottom: Math.round(height * 0.12),
        signoffSize: 46,
        subtitleSize: 22,
        urlBottom: Math.round(height * 0.06),
        urlSize: 18,
        padX: 110,
      };
    case "4:5":
    default:
      return {
        logoTop: Math.round(height * 0.075),
        logoHeight: Math.round(height * 0.21),
        signoffBottom: Math.round(height * 0.13),
        signoffSize: 44,
        subtitleSize: 22,
        urlBottom: Math.round(height * 0.07),
        urlSize: 18,
        padX: 110,
      };
  }
};

// Dynamic font sizing for the main quote body — scales with both
// text length and the available canvas area.
export const quoteFontSize = (
  text: string,
  ratio: AspectRatio,
  width: number,
) => {
  const len = text.length;
  // Base size proportional to width (1080 → these constants)
  const w = width;
  const scale = w / 1080;
  if (ratio === "1:1") {
    if (len < 50) return Math.round(72 * scale);
    if (len < 90) return Math.round(60 * scale);
    if (len < 140) return Math.round(48 * scale);
    if (len < 200) return Math.round(40 * scale);
    return Math.round(34 * scale);
  }
  if (ratio === "9:16") {
    if (len < 50) return Math.round(104 * scale);
    if (len < 90) return Math.round(86 * scale);
    if (len < 140) return Math.round(70 * scale);
    if (len < 200) return Math.round(58 * scale);
    return Math.round(48 * scale);
  }
  // 4:5 default
  if (len < 50) return Math.round(96 * scale);
  if (len < 90) return Math.round(80 * scale);
  if (len < 140) return Math.round(66 * scale);
  if (len < 200) return Math.round(54 * scale);
  return Math.round(44 * scale);
};
