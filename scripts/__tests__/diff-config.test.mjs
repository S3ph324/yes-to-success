import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDiffClient, poseFileFor, makeStamp, slugify } from "../lib/diff-config.mjs";

test("resolveDiffClient(techsplains) returns the legacy constants unchanged", async () => {
  const c = await resolveDiffClient("techsplains");
  assert.equal(c.accent, "#FFDD00");
  assert.equal(c.handle, "@techsplains");
  assert.equal(c.outro, "Follow Techsplains for more!");
  assert.equal(c.dykOpener, "Did you know");
  assert.equal(c.template, "mascot");
  assert.equal(c.tts.voice, "Orus");
  assert.equal(c.tts.targetSec, 31);
  assert.equal(c.tts.maxTempo, 1.28);
  assert.equal(c.whisperLang, "en");
  assert.equal(c.gcp.project, "techsplains");
  assert.match(c.gcp.adc, /adc-techsplains\.json$/);
  assert.equal(c.contentMix.allowGeneral, true);
  assert.equal(c.presenter.poses.question, "pose-confused.png");
});

test("resolveDiffClient(tranzzie) uses shared GCP + Tranzzie brand", async () => {
  const c = await resolveDiffClient("tranzzie");
  assert.equal(c.brandName, "Tranzzie");
  assert.equal(c.template, "photo");
  assert.equal(c.accent, "#F5C13B");
  assert.equal(c.dykOpener, "Alam mo ba");
  assert.equal(c.contentMix.allowGeneral, false);
  assert.equal(c.gcp.project, "jurie-quote-posters"); // shared Jurie project
  assert.match(c.gcp.adc, /adc-jurie\.json$/);
  assert.equal(c.presenter.characterId, "char_tranzzie_enhanced");
  assert.match(c.voiceProfilePath, /voice-profile-tranzzie-video\.md$/);
});

test("resolveDiffClient attaches the resolved brief object", async () => {
  const c = await resolveDiffClient("tranzzie");
  assert.equal(c.brief.id, "brief_tranzzie");
  assert.ok(Array.isArray(c.brief.topics) && c.brief.topics.length > 0);
});

test("poseFileFor builds a POSIX poseDir/pose path", async () => {
  const c = await resolveDiffClient("techsplains");
  assert.equal(poseFileFor(c, "defA"), "characters/techsplains/pose-think.png");
});

test("applyGcpEnv(shared) sets Jurie creds", async () => {
  const saved = { a: process.env.GOOGLE_APPLICATION_CREDENTIALS, p: process.env.GOOGLE_CLOUD_PROJECT };
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  const c = await resolveDiffClient("tranzzie");
  c.applyGcpEnv();
  assert.match(process.env.GOOGLE_APPLICATION_CREDENTIALS, /adc-jurie\.json$/);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = saved.a || "";
  process.env.GOOGLE_CLOUD_PROJECT = saved.p || "";
});

test("makeStamp/slugify still exported", () => {
  assert.match(makeStamp(), /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/);
  assert.equal(slugify("Codec vs Container!"), "codec-vs-container");
});
