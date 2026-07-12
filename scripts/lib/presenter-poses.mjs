// Pure helpers for the one-time Jurie pose-set generator.
import path from "node:path";

// Attitude per pose-file stem. Every prompt keeps the SAME person on a PURE
// BLACK studio background (so she composites onto the dark card with a feathered
// top edge — no bg-removal dependency), upper-body, facing camera, friendly.
const ATTITUDE = {
  "jurie-point": "clearly POINTING to one side with a single extended INDEX FINGER — arm raised, index finger out and the other fingers curled in — unmistakably a pointing gesture, NOT an open palm",
  "jurie-present": "presenting with ONE open, upturned palm held out to the side (fingers together, palm facing up) — a welcoming 'ta-da / here it is' gesture",
  "jurie-think": "ONE hand raised to her chin in a thoughtful 'hmm' pose, head tilted slightly, eyebrows raised, curious",
  "jurie-explain": "BOTH hands open and relaxed in front of her mid-explanation, mouth slightly open as if talking, warm and approachable",
  "jurie-base": "friendly neutral pose, both arms relaxed down at her sides, calm closed-mouth smile",
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
      `She ALWAYS wears the exact same outfit: a plain light-grey short-sleeve crew-neck T-SHIRT ` +
      `(no sweater, no long sleeves), and the same dark-grey backwards cap and the same clear/white ` +
      `rectangular glasses in every shot. Keep her face, skin tone and hair identical across shots. ` +
      `Centered, upper body / waist-up, facing the camera, on a PURE FLAT CHROMA-KEY GREEN background ` +
      `(#00FF00, solid uniform green, no gradient, no shadows cast on the background) so it can be cut out cleanly. ` +
      `Vertical 9:16, crisp and readable at small size. No text, no words, no logos, no watermark.`
    );
  }
  return (
    `Photorealistic upper-body portrait of the SAME person from the reference photos ` +
    `(same face, same glasses, same hair, same apparent age and gender) — the ${brandName} presenter, ${attitude}. ` +
    `She wears the SAME plain light-grey crew-neck T-shirt in every shot (consistent outfit). ` +
    `Shot on a PURE FLAT CHROMA-KEY GREEN background (#00FF00, solid uniform green, no gradient, ` +
    `no shadows cast on the background) so she can be cut out cleanly. Soft key light, sharp focus, ` +
    `natural skin, centered, waist-up, looking toward the camera. Vertical 9:16 friendly explainer-host energy.`
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
