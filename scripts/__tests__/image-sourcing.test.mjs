import { test } from "node:test";
import assert from "node:assert/strict";
import * as imageSourcing from "../lib/image-sourcing.mjs";

test("image-sourcing exports the vision-gated sourcing functions", () => {
  assert.equal(typeof imageSourcing.pickBest, "function");
  assert.equal(typeof imageSourcing.fetchBuf, "function");
  assert.equal(typeof imageSourcing.stockImage, "function");
  assert.equal(imageSourcing.stockImage.length, 5);
  assert.equal(typeof imageSourcing.openverseImage, "function");
  assert.equal(imageSourcing.openverseImage.length, 5);
  assert.equal(typeof imageSourcing.stockVideo, "function");
  assert.equal(imageSourcing.stockVideo.length, 4);
  assert.equal(typeof imageSourcing.genImage, "function");
  assert.equal(imageSourcing.genImage.length, 3);
  assert.equal(typeof imageSourcing.STYLE_TAIL, "string");
  assert.match(imageSourcing.STYLE_TAIL, /No text, no words/);
});

test("configureImageGcp is exported and tolerates full/partial/empty config", () => {
  // The multi-brand video pipeline calls this to repoint the vision-gate +
  // image-gen at a client's own GCP project (Tranzzie = shared/Jurie) instead
  // of the Techsplains default. It must never throw at wiring time — the real
  // GCP client is built lazily on first source call.
  assert.equal(typeof imageSourcing.configureImageGcp, "function");
  assert.doesNotThrow(() =>
    imageSourcing.configureImageGcp({ project: "jurie-quote-posters", imageLocation: "us-central1", apply: () => {} }),
  );
  assert.doesNotThrow(() => imageSourcing.configureImageGcp({ project: "x" })); // partial → defaults fill in
  assert.doesNotThrow(() => imageSourcing.configureImageGcp()); // no arg → back to Techsplains default
});
