// Persisted dashboard settings for Techsplains (currently: daily posting
// times). Separate file from the queue so per-video state and operator
// preferences can't clobber each other.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./client.mjs";
import { sanitizePostTimes, DEFAULT_POST_TIMES } from "./techsplains-schedule.mjs";

export const SETTINGS_PATH =
  process.env.TECHSPLAINS_SETTINGS_PATH ||
  path.join(projectRoot, "config", "techsplains-settings.json");

export async function readSettings() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(SETTINGS_PATH, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // corrupt JSON: fail loud
    raw = {};
  }
  return { postTimes: sanitizePostTimes(raw.postTimes ?? DEFAULT_POST_TIMES) };
}

export async function writeSettings(patch) {
  const current = await readSettings();
  const next = { ...current };
  if ("postTimes" in (patch || {})) next.postTimes = sanitizePostTimes(patch.postTimes);
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, SETTINGS_PATH); // atomic on the same filesystem
  return next;
}
