import { test } from "node:test";
import assert from "node:assert/strict";
import { posesToGenerate, posePrompt } from "../lib/presenter-poses.mjs";

const presenter = {
  poseDir: "characters/tranzzie",
  poses: {
    hook: "jurie-point.png", introA: "jurie-point.png", introB: "jurie-present.png",
    question: "jurie-think.png", defA: "jurie-explain.png", defB: "jurie-point.png",
    outro: "jurie-base.png",
  },
};

test("dedupes pose FILES (point appears 3× → generated once)", () => {
  const jobs = posesToGenerate(presenter, () => false);
  const files = jobs.map((j) => j.file).sort();
  assert.deepEqual(files, ["jurie-base.png", "jurie-explain.png", "jurie-point.png", "jurie-present.png", "jurie-think.png"]);
});

test("skips files that already exist on disk", () => {
  const jobs = posesToGenerate(presenter, (f) => f.endsWith("jurie-point.png"));
  assert.ok(!jobs.some((j) => j.file === "jurie-point.png"));
  assert.equal(jobs.length, 4);
});

test("posePrompt forces a black studio background and the same person", () => {
  const p = posePrompt("jurie-point.png", "Tranzzie");
  assert.match(p, /black/i);
  assert.match(p, /point/i);
  assert.doesNotMatch(p, /text|watermark|logo/i); // pipeline never asks for text
});
