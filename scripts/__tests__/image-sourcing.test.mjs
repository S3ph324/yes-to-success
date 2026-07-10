import { test } from "node:test";
import assert from "node:assert/strict";
import * as imageSourcing from "../lib/image-sourcing.mjs";

test("image-sourcing exports the vision-gated sourcing functions", () => {
  assert.equal(typeof imageSourcing.pickBest, "function");
  assert.equal(typeof imageSourcing.fetchBuf, "function");
  assert.equal(typeof imageSourcing.stockImage, "function");
  assert.equal(imageSourcing.stockImage.length, 5);
  assert.equal(typeof imageSourcing.genImage, "function");
  assert.equal(imageSourcing.genImage.length, 3);
  assert.equal(typeof imageSourcing.STYLE_TAIL, "string");
  assert.match(imageSourcing.STYLE_TAIL, /No text, no words/);
});
