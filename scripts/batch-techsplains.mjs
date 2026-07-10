#!/usr/bin/env node
// Techsplains one-shot batch: scripts → images → voice → MP4 export.
//
// Usage:
//   node scripts/batch-techsplains.mjs [count] [topic...]
//   npm run techsplains:batch -- 3 "video editing basics"

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const args = process.argv.slice(2);

const step = (label, script, stepArgs) =>
  new Promise((resolve, reject) => {
    console.log(`\n━━━ ${label} ━━━`);
    const p = spawn(process.execPath, [path.join(__dirname, script), ...stepArgs], {
      stdio: "inherit",
      cwd: projectRoot,
    });
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)),
    );
  });

await step("1/5 Scripts (Gemini)", "generate-diff-scripts.mjs", args);

// Newest scripts JSON is the one we just wrote.
const outDir = path.join(projectRoot, "out");
const scriptsFile = (await fs.readdir(outDir))
  .filter((f) => /^techsplains-scripts-.*\.json$/.test(f))
  .sort()
  .pop();
if (!scriptsFile) {
  console.error("No techsplains scripts JSON found in out/ — generation failed?");
  process.exit(1);
}
const scriptsPath = path.join(outDir, scriptsFile);

await step("2/5 Visuals (stock video / real photos / AI)", "generate-diff-images.mjs", [scriptsPath]);
await step("3/5 Director QC (scripts + visuals)", "generate-diff-director.mjs", [scriptsPath]);
await step("4/5 Voiceover + word timings (TTS + whisper)", "generate-diff-audio.mjs", [scriptsPath]);
await step("5/5 Render + export (Remotion)", "render-diff-batch.mjs", [scriptsPath]);

console.log("\n✓ Techsplains batch complete.");
