#!/usr/bin/env node
// One-shot eyeglasses-showcase pipeline (Tranzzie only): topic/angle →
// product-showcase copy → product-accurate scene backgrounds → rendered
// posters in Tranzzie's export folder (manual posting).
//
// Mirrors batch-jurie.mjs but swaps step 1 for the eyeglasses content
// generator (clean product-showcase copy — productLine/tagline/ctaTag, NOT
// the hook→payoff quote shape) and relies on generate-backgrounds-jurie.mjs's
// eyeglasses-mode branch (triggered by DASHBOARD_EYEGLASSES_ID) for step 2.
// Step 3 reuses render-batch-jurie.mjs, which detects the `eyeglassesId` tag
// on each entry and routes it to ProductShowcaseCard — a clean product-photo
// poster — instead of the JurieQuoteCard quote-graphic treatment.
//
// Usage:
//   node scripts/batch-eyeglasses-tranzzie.mjs [count] [topic/angle...]
// Env (set by the dashboard's /api/generate handler):
//   DASHBOARD_EYEGLASSES_ID          - which config/eyeglasses.json entry to feature
//   DASHBOARD_EYEGLASSES_STYLE       - "showcase" | "model"
//   DASHBOARD_EYEGLASSES_PLACEMENT   - "standing" | "flat" | "floating" | "auto"
//   DASHBOARD_EYEGLASSES_STYLE_KEY   - visual style key within placement (e.g. "dark_luxury")
//   DASHBOARD_EYEGLASSES_MODEL_STYLE - "outdoor_lifestyle" | "indoor_studio" | etc.
//   DASHBOARD_ASPECT_DIST            - optional {"1:1":25,"4:5":50,"9:16":25} mix
//
// Autoposting is intentionally NOT wired (manual posting only).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GCP, projectRoot, resolveClient } from "./lib/client.mjs";

const client = await resolveClient("tranzzie");

const count = process.argv[2] || "8";
const topic =
  process.argv.slice(3).join(" ").trim() || process.env.CLIENT_TOPIC || "";

const eyeglassesId = process.env.DASHBOARD_EYEGLASSES_ID || "";
if (!eyeglassesId) {
  console.error(
    "DASHBOARD_EYEGLASSES_ID is required — pick a frame on the Generate tab " +
      "(add one in the 🕶️ Eyeglasses tab first if the list is empty).",
  );
  process.exit(1);
}

const env = {
  ...process.env,
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || GCP.adc,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || GCP.project,
  CLIENT: client.id,
  DASHBOARD_BRIEF_ID: process.env.DASHBOARD_BRIEF_ID || client.briefId,
  DASHBOARD_BRAND_PRESET_ID:
    process.env.DASHBOARD_BRAND_PRESET_ID || client.brandPresetId,
  DASHBOARD_EYEGLASSES_ID: eyeglassesId,
  DASHBOARD_EYEGLASSES_STYLE: process.env.DASHBOARD_EYEGLASSES_STYLE || "showcase",
  ...(process.env.DASHBOARD_EYEGLASSES_PLACEMENT
    ? { DASHBOARD_EYEGLASSES_PLACEMENT: process.env.DASHBOARD_EYEGLASSES_PLACEMENT }
    : {}),
  ...(process.env.DASHBOARD_EYEGLASSES_STYLE_KEY
    ? { DASHBOARD_EYEGLASSES_STYLE_KEY: process.env.DASHBOARD_EYEGLASSES_STYLE_KEY }
    : {}),
  ...(process.env.DASHBOARD_EYEGLASSES_MODEL_STYLE
    ? { DASHBOARD_EYEGLASSES_MODEL_STYLE: process.env.DASHBOARD_EYEGLASSES_MODEL_STYLE }
    : {}),
  ...(topic ? { CLIENT_TOPIC: topic } : {}),
};

const run = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn("node", args, { stdio: "inherit", cwd: projectRoot, env });
    p.on("error", (err) =>
      reject(new Error(`spawn error for ${args[1]}: ${err.message}`)),
    );
    p.on("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${path.basename(args[1])} exited ${signal ? `signal:${signal}` : code}`,
            ),
          ),
    );
  });

console.log(
  `━━━ ${client.label} eyeglasses-showcase batch: ${count} poster(s)` +
    (topic ? ` — angle "${topic}"` : "") +
    ` — frame ${eyeglassesId} ━━━`,
);

// Pre-run sweep: clear stale generated-bg and out/ files from crashed previous
// runs so they don't accumulate and cause ENOSPC before rendering starts.
{
  const bgRoot = path.join(projectRoot, "public", "generated-bg");
  try {
    const subs = await fs.readdir(bgRoot);
    await Promise.all(subs.map(s => fs.rm(path.join(bgRoot, s), { recursive: true, force: true }).catch(() => {})));
    if (subs.length) console.log(`  Cleared ${subs.length} stale generated-bg folder(s).`);
  } catch { /* generated-bg may not exist yet — fine */ }

  const outDir = path.join(projectRoot, "out");
  try {
    const files = await fs.readdir(outDir);
    const stale = files.filter(f => f.endsWith(".json") || f.endsWith(".txt"));
    await Promise.all(stale.map(f => fs.rm(path.join(outDir, f), { force: true }).catch(() => {})));
    if (stale.length) console.log(`  Cleared ${stale.length} stale out/ file(s).`);
  } catch { /* ignore */ }
}

console.log(`\n━━━ Step 1: Generate eyeglasses-showcase copy (${client.label} voice) ━━━`);
await run([
  "scripts/generate-eyeglasses-tranzzie.mjs",
  "--client",
  client.id,
  String(count),
]);

const outDir = path.join(projectRoot, "out");
const files = await fs.readdir(outDir);
const latest = files
  .filter((f) => f.startsWith(`${client.quotePrefix}-`) && f.endsWith(".json"))
  .sort()
  .pop();
if (!latest) {
  console.error(`Could not find a generated ${client.quotePrefix} JSON.`);
  process.exit(1);
}
const latestPath = path.join(outDir, latest);
console.log(`\nUsing ${latest}`);

console.log("\n━━━ Step 2: Generate product-accurate scene backgrounds ━━━");
try {
  await run([
    "scripts/generate-backgrounds-jurie.mjs",
    "--client",
    client.id,
    latestPath,
  ]);
} catch (err) {
  console.error(`\n✗ Background generation failed: ${err.message}`);
  process.exit(1);
}

console.log("\n━━━ Step 3: Render posters ━━━");
try {
  await run([
    "scripts/render-batch-jurie.mjs",
    "--client",
    client.id,
    latestPath,
  ]);
} catch (err) {
  console.error(`\n✗ Render step failed: ${err.message}`);
  process.exit(1);
}

// The dashboard sets JURIE_NO_OPEN=1 so it does NOT pop a gallery window —
// results show in the dashboard's Batches tab instead. CLI runs still open it.
if (!process.env.JURIE_NO_OPEN) {
  const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;
  try {
    const stamps = (await fs.readdir(EXPORT_DIR)).sort();
    const gallery = path.join(
      EXPORT_DIR,
      stamps[stamps.length - 1],
      "gallery.html",
    );
    spawn("open", [gallery], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}
console.log("\n✓ Done.");
