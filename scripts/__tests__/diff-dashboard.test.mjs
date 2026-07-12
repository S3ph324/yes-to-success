import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { bufferConfigured, buildPostInput, schedulePost } from "../lib/diff-buffer.mjs";
import { storageConfigured } from "../lib/diff-storage.mjs";
import { readSettings, writeSettings, settingsPath } from "../lib/diff-settings.mjs";

// --- diff-buffer: per-client env + cross-client isolation ------------------
test("bufferConfigured reads BUFFER_<CLIENT>_* and is isolated per client", () => {
  const save = { ...process.env };
  delete process.env.BUFFER_TRANZZIE_API_KEY;
  delete process.env.BUFFER_TRANZZIE_CHANNEL;
  delete process.env.BUFFER_TECHSPLAINS_API_KEY;
  delete process.env.BUFFER_TECHSPLAINS_CHANNEL;

  assert.equal(bufferConfigured("tranzzie"), false);
  // Configuring techsplains must NOT make tranzzie look configured.
  process.env.BUFFER_TECHSPLAINS_API_KEY = "k";
  process.env.BUFFER_TECHSPLAINS_CHANNEL = "c";
  assert.equal(bufferConfigured("tranzzie"), false);
  assert.equal(bufferConfigured("techsplains"), true);
  // Now configure tranzzie.
  process.env.BUFFER_TRANZZIE_API_KEY = "k2";
  process.env.BUFFER_TRANZZIE_CHANNEL = "c2";
  assert.equal(bufferConfigured("tranzzie"), true);

  process.env = save;
});

test("schedulePost refuses when the client's Buffer is unconfigured", async () => {
  const save = { ...process.env };
  delete process.env.BUFFER_TRANZZIE_API_KEY;
  delete process.env.BUFFER_TRANZZIE_CHANNEL;
  await assert.rejects(
    () => schedulePost("tranzzie", { videoUrl: "u", caption: "c", dueAt: "2026-07-13T09:00:00Z" }),
    /tranzzie.*not configured/i,
  );
  process.env = save;
});

test("buildPostInput yields the Buffer FB-video shape with the given channel", () => {
  const input = buildPostInput({ channelId: "CH", videoUrl: "https://x/v.mp4", caption: "hi", dueAt: "2026-07-13T09:00:00Z", fbType: "reel" });
  assert.equal(input.channelId, "CH");
  assert.equal(input.mode, "customScheduled");
  assert.deepEqual(input.assets, [{ video: { url: "https://x/v.mp4" } }]);
  assert.equal(input.metadata.facebook.type, "reel");
  assert.equal(input.text, "hi");
});

// --- diff-storage: per-client B2 with fallback to shared B2_* --------------
test("storageConfigured uses <CLIENT>_B2_* and falls back to shared B2_*", () => {
  const save = { ...process.env };
  for (const k of Object.keys(process.env)) if (/_B2_|^B2_/.test(k)) delete process.env[k];

  assert.equal(storageConfigured("tranzzie"), false);
  // Shared B2_* alone makes any client configured (fallback).
  process.env.B2_KEY_ID = "id"; process.env.B2_APP_KEY = "ak";
  process.env.B2_BUCKET_ID = "bid"; process.env.B2_BUCKET_NAME = "bn";
  assert.equal(storageConfigured("tranzzie"), true);
  // A client-specific override also counts.
  process.env.TRANZZIE_B2_KEY_ID = "tid";
  assert.equal(storageConfigured("tranzzie"), true);

  process.env = save;
});

// --- diff-settings: per-client file, defaults, round-trip ------------------
test("settingsPath is namespaced per client and honors <CLIENT>_SETTINGS_PATH", () => {
  const save = process.env.TZTEST_SETTINGS_PATH;
  delete process.env.TZTEST_SETTINGS_PATH;
  assert.match(settingsPath("tztest"), /config\/tztest-settings\.json$/);
  process.env.TZTEST_SETTINGS_PATH = "/tmp/x.json";
  assert.equal(settingsPath("tztest"), "/tmp/x.json");
  if (save) process.env.TZTEST_SETTINGS_PATH = save; else delete process.env.TZTEST_SETTINGS_PATH;
});

test("readSettings returns default post times; writeSettings round-trips", async () => {
  const tmp = path.join(os.tmpdir(), `tztest-settings-${process.pid}.json`);
  const save = process.env.TZTEST_SETTINGS_PATH;
  process.env.TZTEST_SETTINGS_PATH = tmp;
  await fs.rm(tmp, { force: true });
  try {
    const def = await readSettings("tztest");
    assert.ok(Array.isArray(def.postTimes) && def.postTimes.length > 0);
    await writeSettings("tztest", { postTimes: ["08:00", "20:00"] });
    const back = await readSettings("tztest");
    assert.deepEqual(back.postTimes, ["08:00", "20:00"]);
  } finally {
    await fs.rm(tmp, { force: true });
    if (save) process.env.TZTEST_SETTINGS_PATH = save; else delete process.env.TZTEST_SETTINGS_PATH;
  }
});
