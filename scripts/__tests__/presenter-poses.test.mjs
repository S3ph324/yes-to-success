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

test("posePrompt forces a green-screen (cutout) background and the same person", () => {
  const p = posePrompt("jurie-point.png", "Tranzzie");
  assert.match(p, /green|#00FF00/i); // green screen → keyed to transparent
  assert.match(p, /same (real )?(young )?woman|same face|same person/i); // identity lock
  assert.match(p, /natural/i); // photoreal poses must read as natural, not stiff
  assert.match(p, /point/i); // gesture is threaded from the file stem
  assert.match(p, /no text|no watermark/i); // the render adds branding; the plate must be clean
});

test("posePrompt flat-vector style yields a cartoon mascot on green, distinct gestures", () => {
  const point = posePrompt("jurie-point.png", "Tranzzie", "flat-vector");
  const present = posePrompt("jurie-present.png", "Tranzzie", "flat-vector");
  assert.match(point, /flat vector|mascot/i);
  assert.match(point, /green|#00FF00/i);
  assert.match(point, /index finger/i); // point ≠ present
  assert.match(present, /open,? upturned palm/i);
});
