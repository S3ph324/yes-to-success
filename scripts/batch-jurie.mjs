#!/usr/bin/env node
// One-shot multi-client pipeline: topic → quotes → scene backgrounds →
// rendered posters in the client export folder (manual posting).
// Client-aware via config/clients.json. John Calub's batch.mjs is separate.
//
// Usage:
//   node scripts/batch-jurie.mjs [--client jurie|tranzzie] [count] [topic...]
//   node scripts/batch-jurie.mjs --client tranzzie 8 "photochromic lenses"
//
// Autoposting is intentionally NOT wired (manual posting only).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GCP,
  projectRoot,
  resolveClient,
  takeClientArg,
} from "./lib/client.mjs";

const { client: clientArg, rest } = takeClientArg(process.argv.slice(2));
const client = await resolveClient(clientArg);

const count = rest[0] || "8";
const topic =
  rest.slice(1).join(" ").trim() || process.env.CLIENT_TOPIC || "";

const env = {
  ...process.env,
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || GCP.adc,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || GCP.project,
  CLIENT: client.id,
  DASHBOARD_BRIEF_ID: process.env.DASHBOARD_BRIEF_ID || client.briefId,
  DASHBOARD_BRAND_PRESET_ID:
    process.env.DASHBOARD_BRAND_PRESET_ID || client.brandPresetId,
  ...(topic ? { CLIENT_TOPIC: topic } : {}),
};

const run = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn("node", args, { stdio: "inherit", cwd: projectRoot, env });
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`node ${args.join(" ")} exited ${code}`)),
    );
  });

console.log(
  `━━━ ${client.label} batch: ${count} poster(s)` +
    (topic ? ` about "${topic}"` : "") +
    ` ━━━`,
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

console.log(`\n━━━ Step 1: Generate quotes (${client.label} voice) ━━━`);
await run([
  "scripts/generate-quotes-jurie.mjs",
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

console.log("\n━━━ Step 2: Generate scene backgrounds ━━━");
await run([
  "scripts/generate-backgrounds-jurie.mjs",
  "--client",
  client.id,
  latestPath,
]);

console.log("\n━━━ Step 3: Render posters ━━━");
await run([
  "scripts/render-batch-jurie.mjs",
  "--client",
  client.id,
  latestPath,
]);

// ── Step 4 (optional): Schedule to Buffer ────────────────────────────────────
// Only runs when BUFFER_AUTOPOST=1 and BUFFER_API_KEY is set.
if (process.env.BUFFER_AUTOPOST === "1" && process.env.BUFFER_API_KEY) {
  const EXPORT_DIR = process.env.JURIE_EXPORT_DIR || client.exportDir;
  try {
    const stamps = (await fs.readdir(EXPORT_DIR)).filter(s => /^[0-9T\-]+$/.test(s)).sort();
    const latestStamp = stamps[stamps.length - 1];
    if (latestStamp) {
      const captionsPath = path.join(EXPORT_DIR, latestStamp, "captions.txt");
      console.log("\n━━━ Step 4: Schedule to Buffer ━━━");
      await run([
        "scripts/buffer-poster.mjs",
        "--client", client.id,
        latestStamp,
        captionsPath,
      ]);
    }
  } catch (err) {
    console.warn("Buffer posting skipped:", err.message);
  }
} else if (process.env.BUFFER_API_KEY && process.env.BUFFER_AUTOPOST !== "1") {
  console.log("\n  (Buffer autopost is off — set BUFFER_AUTOPOST=1 to enable)");
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
