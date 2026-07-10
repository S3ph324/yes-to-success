import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInstructions } from "../lib/diff-prompt.mjs";

const techsplains = {
  brandName: "Techsplains", outro: "Follow Techsplains for more!", dykOpener: "Did you know",
  contentMix: { dykDefault: 0.25, generalDefault: 0.2, allowGeneral: true },
  brief: { topics: ["codec vs container"], generalTopics: ["frog vs toad"] },
};
const tranzzie = {
  brandName: "Tranzzie", outro: "Follow Tranzzie for more!", dykOpener: "Alam mo ba",
  contentMix: { dykDefault: 0.34, generalDefault: 0, allowGeneral: false },
  brief: { topics: ["blue-light vs regular lenses"], generalTopics: [] },
};

test("brand strings are interpolated, not hardcoded", () => {
  const r = buildInstructions(tranzzie, "VOICE", { used: [] }, { count: 3, dyk: 1, general: 0 });
  assert.match(r.diffInstruction, /Tranzzie/);
  assert.doesNotMatch(r.diffInstruction, /Techsplains/);
  assert.match(r.dykInstruction, /Alam mo ba/);
  assert.match(r.dykInstruction, /Follow Tranzzie for more!/);
});

test("allowGeneral:false forbids the general category", () => {
  const r = buildInstructions(tranzzie, "VOICE", { used: [] }, { count: 4, dyk: 1, general: 2 });
  assert.equal(r.GENERAL_COUNT, 0);
  assert.match(r.diffInstruction, /do not use the GENERAL/i);
});

test("techsplains keeps the general split when requested", () => {
  const r = buildInstructions(techsplains, "VOICE", { used: [] }, { count: 4, dyk: 1, general: 1 });
  assert.equal(r.GENERAL_COUNT, 1);
  assert.equal(r.DIFF_COUNT, 3);
  assert.equal(r.DYK_COUNT, 1);
  assert.match(r.dykInstruction, /Did you know/);
});

test("ledger lines are appended when present", () => {
  const r = buildInstructions(techsplains, "VOICE", { used: ["codec vs container"] }, { count: 1, dyk: 0, general: 0 });
  assert.match(r.diffInstruction, /codec vs container/);
});
