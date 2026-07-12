// Per-client persisted dashboard settings (currently: daily posting times).
// Generalizes techsplains-settings.mjs so each brand has its OWN settings file
// (config/<client>-settings.json), keeping operator preferences isolated per
// brand. Separate file from the queue so per-video state and preferences can't
// clobber each other.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./client.mjs";
import { sanitizePostTimes, DEFAULT_POST_TIMES } from "./techsplains-schedule.mjs";

// Path for a client's settings file. <CLIENT>_SETTINGS_PATH overrides it.
export function settingsPath(clientId) {
  const U = String(clientId || "").toUpperCase();
  return (
    process.env[`${U}_SETTINGS_PATH`] ||
    path.join(projectRoot, "config", `${clientId}-settings.json`)
  );
}

export async function readSettings(clientId) {
  const p = settingsPath(clientId);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(p, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // corrupt JSON: fail loud
    raw = {};
  }
  return { postTimes: sanitizePostTimes(raw.postTimes ?? DEFAULT_POST_TIMES) };
}

export async function writeSettings(clientId, patch) {
  const p = settingsPath(clientId);
  const current = await readSettings(clientId);
  const next = { ...current };
  if ("postTimes" in (patch || {})) next.postTimes = sanitizePostTimes(patch.postTimes);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, p); // atomic on the same filesystem
  return next;
}
