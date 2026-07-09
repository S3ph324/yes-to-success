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
  } catch (err) {
    if (err.code === "ENOENT") return {}; // no queue yet — first run
    throw err; // corrupt JSON / EACCES / etc: fail loud, never pave over state
  }
}

async function writeQueue(obj) {
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  const tmp = `${QUEUE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, QUEUE_PATH); // atomic on the same filesystem
}

let chain = Promise.resolve();
export function setEntry(key, patch) {
  const run = async () => {
    const q = await readQueue();
    q[key] = { ...(q[key] || {}), ...patch };
    await writeQueue(q);
    return q[key];
  };
  // Serialize after the previous op settles (run whether it resolved OR
  // rejected), but never let a prior failure poison later calls: the chain
  // continues from a swallowed copy while the caller still sees the real
  // outcome of THEIR write.
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

export async function getEntry(key) {
  return (await readQueue())[key] || null;
}
