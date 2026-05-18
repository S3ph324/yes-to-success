#!/usr/bin/env node
// Veo 3 animation for b-roll shots (image-to-video from each first frame).
// GATED: broll-batch.mjs only calls this when BROLL_VEO=1. Veo 3 is gated
// and costly (~$3–6 per 8s clip) — keep it off until access/budget is
// confirmed. Run directly only if you know what you're spending.
//
// Usage: BROLL_VEO=1 node scripts/broll-veo.mjs out/broll-<stamp>.json

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

if (process.env.BROLL_VEO !== "1") {
  console.error(
    "Refusing to run: Veo is gated. Set BROLL_VEO=1 to confirm you accept\n" +
      "the cost (~$3–6 per 8s clip).",
  );
  process.exit(1);
}

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const VEO_MODEL = process.env.VEO_MODEL || "veo-3.0-generate-001";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/broll-veo.mjs <broll.json>");
  process.exit(1);
}
const jsonPath = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
const shots = (data.shots || []).filter((s) => s.framePath);
const aspect = data.meta?.aspect === "16:9" ? "16:9" : "9:16";

// Only animate shots explicitly marked picked:true (the dashboard sets this
// when the user selects them). If none are marked, animate nothing.
const picks = shots.filter((s) => s.picked);
if (picks.length === 0) {
  console.log("No shots marked picked:true — nothing to animate. (Pick first.)");
  process.exit(0);
}

const stem = path.basename(jsonPath, ".json");
const relDir = path.join("broll-clips", stem);
const absDir = path.join(projectRoot, "public", relDir);
await fs.mkdir(absDir, { recursive: true });

const ai = new GoogleGenAI({ vertexai: true, project, location });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(
  `Veo ${VEO_MODEL}: animating ${picks.length} picked shot(s), ${aspect} …`,
);

for (const s of picks) {
  try {
    const imgBytes = await fs.readFile(
      path.join(projectRoot, "public", s.framePath),
    );
    let op = await ai.models.generateVideos({
      model: VEO_MODEL,
      prompt: s.videoPrompt,
      image: { imageBytes: imgBytes.toString("base64"), mimeType: "image/png" },
      config: { aspectRatio: aspect, numberOfVideos: 1 },
    });
    while (!op.done) {
      await sleep(10000);
      op = await ai.operations.getVideosOperation({ operation: op });
    }
    const gen =
      op.response?.generatedVideos?.[0] || op.result?.generatedVideos?.[0];
    const vid = gen?.video;
    let buf = null;
    if (vid?.videoBytes) buf = Buffer.from(vid.videoBytes, "base64");
    else if (vid?.uri) {
      const r = await fetch(vid.uri);
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf) {
      console.warn(`  [${s.n}] no video returned`);
      continue;
    }
    const fname = `shot-${String(s.n).padStart(2, "0")}.mp4`;
    await fs.writeFile(path.join(absDir, fname), buf);
    s.clipPath = path.join(relDir, fname);
    console.log(`  [${s.n}] ${fname}`);
  } catch (err) {
    console.warn(
      `  [${s.n}] Veo failed: ${err?.message ? String(err.message).slice(0, 180) : err}`,
    );
  }
}

await fs.writeFile(jsonPath, JSON.stringify(data, null, 2));
console.log(`\n✓ Clips → ${absDir}\n✓ Updated ${jsonPath}`);
