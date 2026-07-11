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

// style: "photoreal" (default) or "flat-vector" (cartoon brand mascot). Both
// keep the SAME person from the reference photos recognizable and sit on a pure
// black background for the card's feathered-top composite.
export function posePrompt(file, brandName, style = "photoreal") {
  const stem = file.replace(/\.png$/i, "");
  const attitude = ATTITUDE[stem] || "friendly neutral pose, gentle smile";
  if (style === "flat-vector") {
    return (
      `A FLAT VECTOR CARTOON MASCOT version of the SAME person from the reference photos — ` +
      `keep her clearly recognizable: same eyeglasses, same cap, same long dark hair, same friendly face — ` +
      `she is the ${brandName} brand mascot, ${attitude}. ` +
      `Modern flat vector illustration: bold clean outlines, smooth flat colors, minimal cel shading, ` +
      `simple friendly facial features, rounded shapes — a Duolingo / Headspace style brand mascot. ` +
      `She wears the SAME simple cream crew-neck top in every shot (consistent outfit). ` +
      `Centered, upper body / waist-up, facing the camera, on a PURE FLAT CHROMA-KEY GREEN background ` +
      `(#00FF00, solid uniform green, no gradient, no shadows cast on the background) so it can be cut out cleanly. ` +
      `Vertical 9:16, crisp and readable at small size. No text, no words, no logos, no watermark.`
    );
  }
  return (
    `Photorealistic upper-body portrait of the SAME person from the reference photos ` +
    `(same face, same glasses, same hair, same apparent age and gender) — the ${brandName} presenter, ${attitude}. ` +
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
    jobs.push({ kind, file, prompt: posePrompt(file, presenter._brandName || "the", presenter.style) });
  }
  return jobs;
}
