// Pure helpers for render-diff-batch.mjs: pick the Remotion composition for a
// brand template + variant, and build the phase-kind → pose-path map.
import { poseFileFor } from "./diff-config.mjs";

export function compositionFor(template, variant) {
  const dyk = variant === "didyouknow";
  if (template === "photo") return dyk ? "TranzzieDidYouKnowCard" : "TranzzieDiffCard";
  return dyk ? "DidYouKnowCard" : "DifferenceCard";
}

export function posePropsFor(cfg) {
  const out = {};
  for (const kind of Object.keys(cfg.presenter.poses)) out[kind] = poseFileFor(cfg, kind);
  return out;
}
