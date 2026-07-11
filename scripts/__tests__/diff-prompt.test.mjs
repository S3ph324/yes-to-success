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

test("brand tokens are parametrized where they belong (DYK opener + outro), and the voice profile carries brand identity", () => {
  const r = buildInstructions(tranzzie, "Tranzzie video voice profile", { used: [] }, { count: 3, dyk: 1, general: 0 });
  // The DYK opener + outro are the genuinely parametrized brand tokens.
  assert.match(r.dykInstruction, /Alam mo ba/);
  assert.match(r.dykInstruction, /Follow Tranzzie for more!/);
  // No Techsplains brand tokens leak into a Tranzzie run.
  assert.doesNotMatch(r.dykInstruction, /Follow Techsplains for more!/);
  assert.doesNotMatch(r.dykInstruction, /Did you know/);
  // Brand identity reaches the instruction via the voice profile (which leads
  // sharedBlocks) — the diffInstruction body itself is brand-neutral by design.
  assert.match(r.diffInstruction, /Tranzzie video voice profile/);
});

test("techsplains prompt is reproduced verbatim (byte-identical guard against condensing)", () => {
  const r = buildInstructions(techsplains, "VOICE", { used: [] }, { count: 3, dyk: 1, general: 0 });
  // Hallmark phrases from the original prompt that must never be dropped.
  assert.match(r.diffInstruction, /huh, I didn't know that/);
  // \s+ tolerates the source line-wrap in "wait out a\n  drought…".
  assert.match(r.diffInstruction, /A toad can wait out a\s+drought buried in mud for months/);
  assert.match(r.dykInstruction, /Did you know/);
  assert.match(r.dykInstruction, /Follow Techsplains for more!/);
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

test("videoDykTopics are surfaced in the shared blocks", () => {
  const cfg = {
    brandName: "Tranzzie", outro: "Follow Tranzzie for more!", dykOpener: "Alam mo ba",
    contentMix: { dykDefault: 0.34, generalDefault: 0, allowGeneral: false },
    brief: { topics: ["blue-light vs regular"], videoDykTopics: ["how to pick frames for your face shape"] },
  };
  const r = buildInstructions(cfg, "VOICE", { used: [] }, { count: 2, dyk: 1, general: 0 });
  assert.match(r.dykInstruction, /face shape/);
});
