// SHIM — Techsplains config now lives in clients.json's `video` block and is
// resolved by lib/diff-config.mjs. These exports preserve the old surface so
// any not-yet-migrated importer keeps working. New code should use
// resolveDiffClient("techsplains") directly.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { resolveDiffClient, makeStamp, slugify } from "./diff-config.mjs";

// Preserve the .env side-load the old module did (repo-root .env → process.env).
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
try {
  const envText = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env — fine */ }

const ts = await resolveDiffClient("techsplains");

export const TS_GCP = { project: ts.gcp.project, location: ts.gcp.location, imageLocation: ts.gcp.imageLocation, adc: ts.gcp.adc };
export const TS_TTS = { ...ts.tts };
export const TS_HANDLE = ts.handle;
export const TS_OUTRO = ts.outro;
export const applyTechsplainsGcpEnv = ts.applyGcpEnv;
export { makeStamp, slugify };
