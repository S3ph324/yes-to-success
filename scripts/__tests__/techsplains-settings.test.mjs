import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Point the lib at a temp settings file via env before importing it.
let tmpDir;
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tss-"));
  process.env.TECHSPLAINS_SETTINGS_PATH = path.join(tmpDir, "settings.json");
});
after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

test("readSettings returns defaults when the file is absent", async () => {
  const { readSettings } = await import("../lib/techsplains-settings.mjs");
  const { DEFAULT_POST_TIMES } = await import("../lib/techsplains-schedule.mjs");
  assert.deepEqual(await readSettings(), { postTimes: DEFAULT_POST_TIMES });
});

test("writeSettings sanitizes and round-trips post times", async () => {
  const { readSettings, writeSettings } = await import("../lib/techsplains-settings.mjs");
  const written = await writeSettings({ postTimes: ["21:00", "08:30", "bogus"] });
  assert.deepEqual(written.postTimes, ["08:30", "21:00"]);
  assert.deepEqual((await readSettings()).postTimes, ["08:30", "21:00"]);
});
