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
// chroma-key GREEN background so the generator can cut them out to a transparent
// PNG — one mask-free composition then serves BOTH a cartoon and a realistic
// version of the same host.
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
  // Photoreal: lock her actual appearance from the reference photos and give her
  // ONE consistent, clean outfit so every pose looks like the same real person
  // photographed on the same day — natural, relaxed, not stiff or AI-posed.
  return (
    `A PHOTOREALISTIC studio photograph of the EXACT SAME real young woman from the reference photos — ` +
    `same face and features, same warm skin tone, same clear/off-white rectangular eyeglasses, ` +
    `same charcoal-grey baseball cap worn BACKWARDS, same long dark straight hair — she is the ${brandName} host, ${attitude}. ` +
    `Her posture and hands look completely NATURAL and relaxed, candid and real — a genuine, un-posed moment, ` +
    `not stiff, not exaggerated, not an obvious AI pose. ` +
    `She wears the SAME clean outfit in every shot: a plain white short-sleeve crew-neck T-shirt (no graphics, no logos, no print). ` +
    `Real DSLR portrait quality: soft even key light, true-to-life skin texture, sharp focus, shallow depth of field. ` +
    `Centered, upper body / waist-up, facing the camera, on a PURE FLAT CHROMA-KEY GREEN background ` +
    `(#00FF00, solid uniform green, no gradient, no shadows cast on the background) so she can be cut out cleanly. ` +
    `Vertical 9:16. No text, no words, no logos, no watermark.`
  );
}

// The consistency instruction appended when a base pose is fed back as the
// appearance anchor — worded for the target style so photoreal locks a real
// person / real outfit and the cartoon locks the flat-vector art style.
export function consistencyNote(style = "photoreal") {
  if (style === "flat-vector") {
    return (
      " CRITICAL CONSISTENCY: this is the EXACT SAME cartoon mascot shown in the LAST reference image — " +
      "keep her face, glasses, cap, hair, skin tone, the grey T-shirt and the exact flat-vector art style " +
      "100% IDENTICAL to that reference; change ONLY the hand gesture and expression."
    );
  }
  return (
    " CRITICAL CONSISTENCY: this is the EXACT SAME real woman shown in the LAST reference image — " +
    "keep her face, glasses, backwards cap, hair, skin tone, the plain white T-shirt, the lighting and the " +
    "photographic look 100% IDENTICAL to that reference; change ONLY the hand gesture and expression, and keep it natural."
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
