// Pure helpers for the one-time Jurie pose-set generator.
import path from "node:path";

// Attitude per pose-file stem. Every prompt keeps the SAME person on a PURE
// BLACK studio background (so she composites onto the dark card with a feathered
// top edge — no bg-removal dependency), upper-body, facing camera, friendly.
const ATTITUDE = {
  "jurie-point": "pointing/gesturing to one side with an open hand, as if directing attention to something beside her",
  "jurie-present": "presenting with an open upturned palm, welcoming gesture",
  "jurie-think": "one hand near her chin, thoughtful and curious expression",
  "jurie-explain": "mid-explanation, calm relaxed hands, warm approachable expression",
  "jurie-base": "friendly neutral standing pose, gentle smile, hands relaxed",
};

export function posePrompt(file, brandName) {
  const stem = file.replace(/\.png$/i, "");
  const attitude = ATTITUDE[stem] || "friendly neutral pose, gentle smile";
  return (
    `Photorealistic upper-body portrait of the SAME young man from the reference photos ` +
    `(same face, same glasses, same hair) — the ${brandName} presenter. He is ${attitude}. ` +
    `Shot on a PURE SOLID BLACK studio background (#000000), soft key light, sharp focus, ` +
    `natural skin, casual modern outfit consistent across shots, centered, waist-up, ` +
    `looking toward the camera. Vertical 9:16 friendly explainer-host energy.`
  );
}

export function posesToGenerate(presenter, existsFn) {
  const seen = new Set();
  const jobs = [];
  // Stable order by first appearance in the poses map.
  for (const [kind, file] of Object.entries(presenter.poses)) {
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.posix.join(presenter.poseDir, file);
    if (existsFn(rel) || existsFn(file)) continue;
    jobs.push({ kind, file, prompt: posePrompt(file, presenter._brandName || "the") });
  }
  return jobs;
}
