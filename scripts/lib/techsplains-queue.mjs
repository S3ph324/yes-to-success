// Local-only approval/queue state for the Techsplains dashboard.
// Keyed by "<stamp>/<file>". Whole-file rewrites serialized through a promise
// chain so overlapping requests from the single local operator never clobber.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./client.mjs";

export const QUEUE_PATH =
  process.env.TECHSPLAINS_QUEUE_PATH ||
  path.join(projectRoot, "config", "techsplains-queue.json");

export const keyFor = (stamp, file) => `${stamp}/${file}`;

export async function readQueue() {
  try {
    return JSON.parse(await fs.readFile(QUEUE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function writeQueue(obj) {
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  await fs.writeFile(QUEUE_PATH, JSON.stringify(obj, null, 2));
}

let chain = Promise.resolve();
export function setEntry(key, patch) {
  chain = chain.then(async () => {
    const q = await readQueue();
    q[key] = { ...(q[key] || {}), ...patch };
    await writeQueue(q);
    return q[key];
  });
  return chain;
}

export async function getEntry(key) {
  return (await readQueue())[key] || null;
}
