#!/usr/bin/env node
// One-shot B-Roll pipeline: analyze (script|video) → first frames →
// HTML deliverable. Veo 3 animation is WIRED but OFF by default; set
// BROLL_VEO=1 to also animate (gated to control cost).
//
// Usage:
//   node scripts/broll-batch.mjs --aspect 9:16 --count 8 --script path.txt
//   node scripts/broll-batch.mjs --aspect 16:9 --count 10 --character char_jurie --video clip.mp4

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { GCP, projectRoot } from "./lib/client.mjs";

const argv = process.argv.slice(2);

const env = {
  ...process.env,
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || GCP.adc,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || GCP.project,
};

const run = (args) =>
  new Promise((resolve, reject) => {
    const p = spawn("node", args, { stdio: "inherit", cwd: projectRoot, env });
    p.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited ${c}`)),
    );
  });

console.log("━━━ Step 1: Analyze source → shot list ━━━");
await run(["scripts/broll-analyze.mjs", ...argv]);

const outDir = path.join(projectRoot, "out");
const latest = (await fs.readdir(outDir))
  .filter((f) => f.startsWith("broll-") && f.endsWith(".json"))
  .sort()
  .pop();
if (!latest) {
  console.error("No broll-*.json produced.");
  process.exit(1);
}
const jsonPath = path.join(outDir, latest);
console.log(`\nUsing ${latest}`);

console.log("\n━━━ Step 2: Generate first frames (Nano Banana) ━━━");
await run(["scripts/broll-frames.mjs", jsonPath]);

if (process.env.BROLL_VEO === "1") {
  console.log("\n━━━ Step 3: Animate with Veo 3 (BROLL_VEO=1) ━━━");
  await run(["scripts/broll-veo.mjs", jsonPath]);
} else {
  console.log(
    "\n━━━ Step 3: Veo 3 animation SKIPPED (off) ━━━\n" +
      "  Wired but disabled to control cost. Animate picks manually, or\n" +
      "  set BROLL_VEO=1 once Veo access/budget is confirmed.",
  );
}

console.log("\n━━━ Step 4: Build HTML deliverable ━━━");
await run(["scripts/broll-deliverable.mjs", jsonPath]);

console.log("\n✓ B-Roll batch done.");
