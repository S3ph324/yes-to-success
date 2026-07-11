import { test } from "node:test";
import assert from "node:assert/strict";
import { newestScriptsFile } from "../lib/diff-stamp.mjs";

test("picks the newest scripts file for the given client", () => {
  const files = [
    "tranzzie-scripts-2026-07-10T09-00.json",
    "tranzzie-scripts-2026-07-11T09-00.json",
    "techsplains-scripts-2026-07-11T10-00.json",
    "random.txt",
  ];
  assert.equal(newestScriptsFile(files, "tranzzie"), "tranzzie-scripts-2026-07-11T09-00.json");
  assert.equal(newestScriptsFile(files, "techsplains"), "techsplains-scripts-2026-07-11T10-00.json");
  assert.equal(newestScriptsFile(files, "nobody"), null);
});
