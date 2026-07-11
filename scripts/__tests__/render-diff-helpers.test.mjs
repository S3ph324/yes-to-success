import { test } from "node:test";
import assert from "node:assert/strict";
import { stampFromScriptsPath } from "../lib/diff-stamp.mjs";

test("parses stamp from a client-prefixed scripts filename", () => {
  assert.equal(stampFromScriptsPath("/x/out/tranzzie-scripts-2026-07-11T09-30.json"), "2026-07-11T09-30");
});
test("parses stamp from the legacy techsplains filename", () => {
  assert.equal(stampFromScriptsPath("out/techsplains-scripts-2026-07-10T08-00.json"), "2026-07-10T08-00");
});
test("falls back to a generated stamp for an unrecognized name", () => {
  assert.match(stampFromScriptsPath("out/weird.json"), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
});
