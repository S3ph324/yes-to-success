import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, parseCaptionsTxt } from "../lib/techsplains-manifest.mjs";

test("buildManifest maps render results to manifest rows", () => {
  const results = [
    { fname: "techsplains-01-codec.mp4", v: { title: "Codec vs Container", caption: "cap A", variant: "difference", durationSec: 40.2 } },
    { fname: "techsplains-02-dyk.mp4", v: { title: "Did You Know: MP", caption: "cap B", variant: "didyouknow", durationSec: 23 } },
  ];
  assert.deepEqual(buildManifest(results), [
    { file: "techsplains-01-codec.mp4", title: "Codec vs Container", caption: "cap A", variant: "difference", durationSec: 40.2 },
    { file: "techsplains-02-dyk.mp4", title: "Did You Know: MP", caption: "cap B", variant: "didyouknow", durationSec: 23 },
  ]);
});

test("buildManifest tolerates missing fields", () => {
  const [row] = buildManifest([{ fname: "x.mp4", v: { title: "T" } }]);
  assert.equal(row.caption, "");
  assert.equal(row.variant, "difference");
  assert.equal(row.durationSec, null);
});

test("parseCaptionsTxt splits the #N — Title / caption / dashes format", () => {
  const txt =
    "#1 — Codec vs Container\nFirst caption line. 🤔\n----------------------------------------\n\n" +
    "#2 — Did You Know: Megapixels\nSecond caption.\n----------------------------------------\n";
  assert.deepEqual(parseCaptionsTxt(txt), [
    { title: "Codec vs Container", caption: "First caption line. 🤔" },
    { title: "Did You Know: Megapixels", caption: "Second caption." },
  ]);
});
