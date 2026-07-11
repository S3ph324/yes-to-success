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

// All three take an optional per-client queue path (default = the legacy
// techsplains QUEUE_PATH) so a multi-brand dashboard can keep each client's
// queue in its own file without the callers/tests that omit it changing.
export async function readQueue(queuePath = QUEUE_PATH) {
  try {
    return JSON.parse(await fs.readFile(queuePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return {}; // no queue yet — first run
    throw err; // corrupt JSON / EACCES / etc: fail loud, never pave over state
  }
}

async function writeQueue(obj, queuePath) {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  const tmp = `${queuePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, queuePath); // atomic on the same filesystem
}

// One serialization chain PER queue path — two brands writing their own files
// never block each other, but writes to the same file stay ordered.
const chains = new Map();
export function setEntry(key, patch, queuePath = QUEUE_PATH) {
  const run = async () => {
    const q = await readQueue(queuePath);
    q[key] = { ...(q[key] || {}), ...patch };
    await writeQueue(q, queuePath);
    return q[key];
  };
  // Serialize after the previous op for THIS path settles (run whether it
  // resolved OR rejected), but never let a prior failure poison later calls:
  // the chain continues from a swallowed copy while the caller still sees the
  // real outcome of THEIR write.
  const prev = chains.get(queuePath) || Promise.resolve();
  const result = prev.then(run, run);
  chains.set(queuePath, result.catch(() => {}));
  return result;
}

export async function getEntry(key, queuePath = QUEUE_PATH) {
  return (await readQueue(queuePath))[key] || null;
}
