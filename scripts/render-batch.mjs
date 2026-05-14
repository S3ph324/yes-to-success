#!/usr/bin/env node
// Render a batch of mixed-variant quote cards from a quotes JSON file.
//
// Each quote has a `variant` field that maps to a Remotion composition:
//   classic → QuoteCard
//   image   → ImageQuoteCard  (requires bgPath populated by generate-backgrounds.mjs)
//   bold    → BoldQuoteCard
//
// Usage:
//   node scripts/render-batch.mjs <path/to/quotes.json> [png|mp4]

import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const quotesArg = process.argv[2];
const format = (process.argv[3] || "png").toLowerCase();
if (!quotesArg) {
  console.error(
    "Usage: node scripts/render-batch.mjs <quotes.json> [png|mp4]",
  );
  process.exit(1);
}
if (!["png", "mp4"].includes(format)) {
  console.error(`Unknown format: ${format}`);
  process.exit(1);
}
const quotesPath = path.isAbsolute(quotesArg)
  ? quotesArg
  : path.join(process.cwd(), quotesArg);
const quotes = JSON.parse(await fs.readFile(quotesPath, "utf-8"));

// Pull the active brand preset (from the dashboard) if available.
const brandPresetId = process.env.DASHBOARD_BRAND_PRESET_ID || "";
let activeBrand = null;
try {
  const presets = JSON.parse(
    await fs.readFile(
      path.join(projectRoot, "config", "brand-presets.json"),
      "utf-8",
    ),
  );
  activeBrand =
    presets.find((p) => p.id === brandPresetId) || presets[0] || null;
} catch {
  // no brand config yet — fall back to component defaults
}

const VARIANT_TO_COMP = {
  classic: "QuoteCard",
  image: "ImageQuoteCard",
  bold: "BoldQuoteCard",
};

console.log(`Rendering ${quotes.length} card(s) as ${format.toUpperCase()}…`);

console.log("Bundling Remotion project (one-time)…");
const t0 = Date.now();
const bundleLocation = await bundle({
  entryPoint: path.join(projectRoot, "src", "index.ts"),
  webpackOverride: (config) => config,
});
console.log(`  bundled in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outDir = path.join(projectRoot, "out", "cards", stamp);
await fs.mkdir(outDir, { recursive: true });

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

// Resolve logo source. If the brand preset uploaded a new logo, it's saved
// directly in public/ as the bare filename (e.g. logo-1234567890.png).
// Remotion's staticFile() resolves relative paths against public/.
const resolveLogoSrc = (configured) => {
  if (!configured) return "yes-to-success-logo.png";
  return configured;
};

const brandColors = activeBrand
  ? {
      brandPrimary: activeBrand.brandPrimary,
      brandDeep: activeBrand.brandDeep,
      brandAccent: activeBrand.brandAccent,
      brandAccentDeep: activeBrand.brandAccentDeep,
      brandRed: activeBrand.brandPrimary,
    }
  : {
      brandPrimary: "#C8001E",
      brandDeep: "#3A0008",
      brandAccent: "#FFE17A",
      brandAccentDeep: "#C9952B",
      brandRed: "#C8001E",
    };

const propsForVariant = (q) => {
  const base = {
    quote: q.quote,
    signoff: activeBrand?.signoff || q.signoff || "— John Calub",
    subtitle:
      activeBrand?.subtitle ||
      q.subtitle ||
      "Philippines' #1 Success Coach",
    aspectRatio: q.aspectRatio || "4:5",
    logoSrc: resolveLogoSrc(activeBrand?.logoSrc || q.logoSrc),
    url: activeBrand?.url || q.url || "JOHNCALUBTRAINING.COM",
  };
  if (q.variant === "image") {
    return {
      ...base,
      bgSrc: q.bgPath || "",
      brandAccent: brandColors.brandAccent,
      brandAccentDeep: brandColors.brandAccentDeep,
    };
  }
  if (q.variant === "bold") {
    return {
      ...base,
      keyword:
        (q.keyword || q.quote.split(" ")[0] || "SUCCESS").toUpperCase(),
      brandPrimary: "#0F0F12",
      brandAccent: brandColors.brandAccent,
      brandAccentDeep: brandColors.brandAccentDeep,
      brandRed: brandColors.brandRed,
    };
  }
  return {
    ...base,
    theme: q.theme || "mindset",
    brandPrimary: brandColors.brandPrimary,
    brandDeep: brandColors.brandDeep,
    brandAccent: brandColors.brandAccent,
    brandAccentDeep: brandColors.brandAccentDeep,
  };
};

let i = 0;
let failed = 0;
for (const q of quotes) {
  i += 1;
  const variant = q.variant || "classic";
  const compId = VARIANT_TO_COMP[variant] || "QuoteCard";
  const slug = slugify(q.quote);
  const ext = format === "mp4" ? "mp4" : "png";
  const aspect = (q.aspectRatio || "4:5").replace(":", "x");
  const fname = `card-${String(i).padStart(2, "0")}-${variant}-${aspect}-${slug}.${ext}`;
  const outPath = path.join(outDir, fname);
  const inputProps = propsForVariant(q);

  try {
    const tStart = Date.now();
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: compId,
      inputProps,
    });
    if (format === "png") {
      await renderStill({
        composition,
        serveUrl: bundleLocation,
        output: outPath,
        inputProps,
        imageFormat: "png",
        frame: 60,
      });
    } else {
      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: "h264",
        outputLocation: outPath,
        inputProps,
      });
    }
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(
      `  [${i}/${quotes.length}] ${variant.padEnd(7)} ${(q.aspectRatio || "4:5").padEnd(4)} ${fname}  (${dt}s)`,
    );
  } catch (err) {
    failed += 1;
    console.warn(
      `  [${i}/${quotes.length}] FAILED ${variant} ${fname}: ${err.message?.slice(0, 100) || err}`,
    );
  }
}

console.log(
  `\n✓ Done. ${quotes.length - failed}/${quotes.length} card(s) saved to:\n  ${outDir}`,
);
if (failed > 0) console.log(`  (${failed} failed — see warnings above)`);
