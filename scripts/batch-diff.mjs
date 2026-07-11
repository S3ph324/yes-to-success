#!/usr/bin/env node
// One-shot multi-brand difference-video batch: scripts → images → director →
// voice → render. Client-parametrized via --client (default techsplains).
//
//   node scripts/batch-diff.mjs --client tranzzie 3 "blue-light lenses"
//   npm run techsplains:batch -- 3 "camera gear"

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { takeClientArg } from "./lib/client.mjs";
import { newestScriptsFile } from "./lib/diff-stamp.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const { client, rest } = takeClientArg(process.argv.slice(2));
const CLIENT_ID = client || "techsplains";
const clientFlag = ["--client", CLIENT_ID];

const step = (label, script, stepArgs) =>
  new Promise((resolve, reject) => {
    console.log(`\n━━━ ${label} ━━━`);
    const p = spawn(process.execPath, [path.join(__dirname, script), ...stepArgs], {
      stdio: "inherit",
      cwd: projectRoot,
    });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });

// 1) Scripts — client flag + the passthrough count/topic args.
await step("1/5 Scripts (Gemini)", "generate-diff-scripts.mjs", [...clientFlag, ...rest]);

const outDir = path.join(projectRoot, "out");
const scriptsFile = newestScriptsFile(await fs.readdir(outDir), CLIENT_ID);
if (!scriptsFile) {
  console.error(`No ${CLIENT_ID}-scripts-*.json found in out/ — generation failed?`);
  process.exit(1);
}
const scriptsPath = path.join(outDir, scriptsFile);

await step("2/5 Visuals", "generate-diff-images.mjs", [...clientFlag, scriptsPath]);
await step("3/5 Director QC", "generate-diff-director.mjs", [...clientFlag, scriptsPath]);
await step("4/5 Voiceover + timings", "generate-diff-audio.mjs", [...clientFlag, scriptsPath]);
await step("5/5 Render + export", "render-diff-batch.mjs", [...clientFlag, scriptsPath]);

console.log(`\n✓ ${CLIENT_ID} batch complete.`);
