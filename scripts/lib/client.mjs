// Shared client resolver for the multi-client (Jurie / Tranzzie) pipeline.
// John Calub's original scripts do NOT use this and are unaffected.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
export const projectRoot = path.join(__dirname, "..", "..");
const scriptsDir = path.join(__dirname, "..");

// Shared Google Cloud creds/project (the user's own, isolated from John
// Calub). Override per-process with the standard env vars if ever needed.
export const GCP = {
  project: process.env.GOOGLE_CLOUD_PROJECT || "jurie-quote-posters",
  location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
  adc:
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.join(os.homedir(), ".config", "gcloud", "adc-jurie.json"),
};

export const applyGcpEnv = () => {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS)
    process.env.GOOGLE_APPLICATION_CREDENTIALS = GCP.adc;
  if (!process.env.GOOGLE_CLOUD_PROJECT)
    process.env.GOOGLE_CLOUD_PROJECT = GCP.project;
};

export async function resolveClient(idArg) {
  const id =
    idArg || process.env.CLIENT || process.env.JURIE_CLIENT || "jurie";
  // On Railway, the dashboard spawns child processes with PERSIST_BASE set to
  // the persistent-volume config directory so that runtime edits (new brand
  // kits, edited briefs, etc.) are picked up instead of the Docker-image snapshot.
  const configBase = process.env.PERSIST_BASE
    ? path.join(process.env.PERSIST_BASE, "config")
    : path.join(projectRoot, "config");
  let clients = [];
  try {
    clients = JSON.parse(
      await fs.readFile(path.join(configBase, "clients.json"), "utf-8"),
    );
  } catch {
    /* fall through — try repo default as a last resort */
    try {
      clients = JSON.parse(
        await fs.readFile(path.join(projectRoot, "config", "clients.json"), "utf-8"),
      );
    } catch { /* give up */ }
  }
  const c = clients.find((x) => x.id === id);
  if (!c) {
    throw new Error(
      `Unknown client "${id}". Known: ${clients.map((x) => x.id).join(", ") || "(none)"}`,
    );
  }
  return {
    ...c,
    voiceProfilePath: path.join(scriptsDir, c.voiceProfile),
    quotePrefix: `${c.id}-quotes`,
  };
}

// Parse `--client <id>` or `-c <id>` out of argv; return { client, rest }.
export function takeClientArg(argv) {
  const a = [...argv];
  let client = process.env.CLIENT || "";
  for (let i = 0; i < a.length; i++) {
    if ((a[i] === "--client" || a[i] === "-c") && a[i + 1]) {
      client = a[i + 1];
      a.splice(i, 2);
      break;
    }
  }
  return { client, rest: a };
}
