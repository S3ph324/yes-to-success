// Shared config for the Techsplains difference-video pipeline.
// Techsplains runs on its OWN GCP project + service-account key, separate from
// Jurie's (lib/client.mjs GCP defaults) and John Calub's machine-wide ADC.
// Do not use applyGcpEnv() from lib/client.mjs in techsplains scripts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

// Minimal .env loader (no dotenv dep): the pipeline scripts run standalone
// via npm scripts, so repo-root .env values (PEXELS_API_KEY, overrides) are
// read here. Real environment variables always win.
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
try {
  const envText = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env — fine */ }

export const TS_GCP = {
  project: process.env.TECHSPLAINS_GCP_PROJECT || "techsplains",
  // Text works fine on the global endpoint. The IMAGE model's global-endpoint
  // quota on this fresh project starves after a handful of requests (429 +
  // empty responses) while us-central1 answers instantly — separate pools.
  location: process.env.TECHSPLAINS_GCP_LOCATION || "global",
  imageLocation: process.env.TECHSPLAINS_GCP_IMAGE_LOCATION || "us-central1",
  adc:
    process.env.TECHSPLAINS_GCP_ADC ||
    path.join(os.homedir(), ".config", "gcloud", "adc-techsplains.json"),
};

export const TS_TTS = {
  // Gemini-TTS (style-directed) replaced Chirp3 — the user found Chirp too
  // robotic. Same "Orus" voice identity, but the style prompt makes it read
  // like a human explainer instead of a screen reader.
  model: process.env.TECHSPLAINS_TTS_MODEL || "gemini-2.5-flash-tts",
  voice: process.env.TECHSPLAINS_TTS_VOICE || "Orus",
  stylePrompt:
    process.env.TECHSPLAINS_TTS_STYLE ||
    "Read this narration in a natural, friendly, QUICK voice — energetic and " +
    "up-tempo like a viral shorts narrator excited to share a fact, but still " +
    "human and clearly enunciated, never rushed into mumbling. Keep the tone " +
    "steady and consistent start to finish, no dramatic swings or over-acting. " +
    "Only the briefest beat between sentences:",
  // Post-speed the track toward this length if the model reads long (user
  // feedback: 45-49s reads felt "soo slow", then 36s reads still too slow —
  // the reference format is ~30s and the user asked for a faster read).
  targetSec: Number(process.env.TECHSPLAINS_TARGET_SEC || "31"),
  maxTempo: 1.28,
};

export const TS_HANDLE = "@techsplains";
export const TS_OUTRO = "Follow Techsplains for more!";

// Force this process's Google credentials to the techsplains key. Called at
// the top of every techsplains script so a shell that has Jurie's or Calub's
// env vars set can never silently bill the wrong project.
export const applyTechsplainsGcpEnv = () => {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = TS_GCP.adc;
  process.env.GOOGLE_CLOUD_PROJECT = TS_GCP.project;
};

export const makeStamp = () =>
  new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

export const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
