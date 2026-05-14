#!/usr/bin/env node
// One-shot pipeline: generate quotes → generate backgrounds → render cards.
//
// Usage:
//   GOOGLE_API_KEY=... npm run quotes:batch -- [count] [png|mp4]

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const count = process.argv[2] || "20";
const format = process.argv[3] || "png";

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", cwd: projectRoot });
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });

console.log("━━━ Step 1: Generate quotes with Gemini ━━━");
await run("node", ["scripts/generate-quotes.mjs", count]);

const outDir = path.join(projectRoot, "out");
const files = await fs.readdir(outDir);
const latest = files
  .filter((f) => f.startsWith("quotes-") && f.endsWith(".json"))
  .sort()
  .pop();
if (!latest) {
  console.error("Could not find a generated quotes JSON file.");
  process.exit(1);
}
const latestPath = path.join(outDir, latest);
console.log(`\nUsing ${latest}`);

console.log("\n━━━ Step 2: Generate backgrounds with Imagen ━━━");
await run("node", ["scripts/generate-backgrounds.mjs", latestPath]);

console.log("\n━━━ Step 3: Render cards with Remotion ━━━");
await run("node", ["scripts/render-batch.mjs", latestPath, format]);

console.log("\n━━━ Step 4: Build gallery ━━━");
await run("node", ["scripts/gallery.mjs"]);

// Auto-open in default browser (macOS).
const latestCards = path.join(projectRoot, "out", "cards");
const batches = (await fs.readdir(latestCards)).sort();
const galleryPath = path.join(
  latestCards,
  batches[batches.length - 1],
  "gallery.html",
);
await run("open", [galleryPath]);
