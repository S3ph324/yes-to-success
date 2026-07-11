import { test } from "node:test";
import assert from "node:assert/strict";
import { stampFromScriptsPath } from "../lib/diff-stamp.mjs";
import { compositionFor, posePropsFor } from "../lib/render-diff-helpers.mjs";
import { resolveDiffClient } from "../lib/diff-config.mjs";

test("parses stamp from a client-prefixed scripts filename", () => {
  assert.equal(stampFromScriptsPath("/x/out/tranzzie-scripts-2026-07-11T09-30.json"), "2026-07-11T09-30");
});
test("parses stamp from the legacy techsplains filename", () => {
  assert.equal(stampFromScriptsPath("out/techsplains-scripts-2026-07-10T08-00.json"), "2026-07-10T08-00");
});
test("falls back to a generated stamp for an unrecognized name", () => {
  assert.match(stampFromScriptsPath("out/weird.json"), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
});

test("compositionFor maps template+variant to a Remotion id", () => {
  assert.equal(compositionFor("mascot", "difference"), "DifferenceCard");
  assert.equal(compositionFor("mascot", "didyouknow"), "DidYouKnowCard");
  assert.equal(compositionFor("photo", "difference"), "TranzzieDiffCard");
  assert.equal(compositionFor("photo", "didyouknow"), "TranzzieDidYouKnowCard");
});

test("posePropsFor resolves each phase kind to its poseDir path", async () => {
  const c = await resolveDiffClient("tranzzie");
  const poses = posePropsFor(c);
  assert.equal(poses.defA, "characters/tranzzie/jurie-explain.png");
  assert.equal(poses.outro, "characters/tranzzie/jurie-base.png");
});
