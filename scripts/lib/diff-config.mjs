// Config resolver for the multi-brand difference-video pipeline (Techsplains,
// Tranzzie, …). Reads each client's `video` block from clients.json and returns
// a fully-resolved DiffClient, including the correct GCP-env applier (isolated
// techsplains key vs the shared Jurie key). Generalizes lib/techsplains.mjs.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot, applyGcpEnv as applySharedGcpEnv } from "./client.mjs";

// Same PERSIST_BASE-aware config dir as resolveClient, so Railway runtime edits win.
const configBase = () =>
  process.env.PERSIST_BASE
    ? path.join(process.env.PERSIST_BASE, "config")
    : path.join(projectRoot, "config");
const scriptsDir = path.join(projectRoot, "scripts");

const expandHome = (p) =>
  p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

async function readJson(abs, fallback) {
  try { return JSON.parse(await fs.readFile(abs, "utf-8")); }
  catch { return fallback; }
}

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

// POSIX <poseDir>/<pose file> for a phase kind (used by staticFile in render).
export const poseFileFor = (cfg, kind) =>
  path.posix.join(cfg.presenter.poseDir, cfg.presenter.poses[kind]);

// GCP resolution per keyword. "techsplains" = its own isolated key/project.
// "shared" = the Jurie project (lib/client.mjs default) — same as Tranzzie posters.
function resolveGcp(keyword) {
  if (keyword === "shared") {
    return {
      project: process.env.GOOGLE_CLOUD_PROJECT || "jurie-quote-posters",
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
      imageLocation: process.env.GOOGLE_CLOUD_IMAGE_LOCATION || "us-central1",
      adc:
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        path.join(os.homedir(), ".config", "gcloud", "adc-jurie.json"),
      apply: () => applySharedGcpEnv(),
    };
  }
  // default: techsplains isolated
  const project = process.env.TECHSPLAINS_GCP_PROJECT || "techsplains";
  const adc =
    process.env.TECHSPLAINS_GCP_ADC ||
    path.join(os.homedir(), ".config", "gcloud", "adc-techsplains.json");
  return {
    project,
    location: process.env.TECHSPLAINS_GCP_LOCATION || "global",
    imageLocation: process.env.TECHSPLAINS_GCP_IMAGE_LOCATION || "us-central1",
    adc,
    apply: () => {
      process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
      process.env.GOOGLE_CLOUD_PROJECT = project;
    },
  };
}

export async function resolveDiffClient(id) {
  const cfgDir = configBase();
  let clients = await readJson(path.join(cfgDir, "clients.json"), null);
  if (!clients)
    clients = await readJson(path.join(projectRoot, "config", "clients.json"), []);
  const client = clients.find((c) => c.id === id);
  if (!client) throw new Error(`Unknown client "${id}". Known: ${clients.map((c) => c.id).join(", ")}`);
  const v = client.video;
  if (!v) throw new Error(`Client "${id}" has no "video" config block.`);

  const briefs = await readJson(path.join(cfgDir, "briefs.json"), []);
  const brief = briefs.find((b) => b.id === v.briefId) || null;
  const gcp = resolveGcp(v.gcp);

  return {
    id,
    brandName: v.brandName,
    handle: v.handle,
    template: v.template,
    accent: v.accent,
    logo: v.logo || null,
    outro: v.outro,
    dykOpener: v.dykOpener,
    language: v.language,
    whisperLang: v.whisperLang,
    tts: v.tts,
    presenter: v.presenter,
    voiceProfilePath: path.join(scriptsDir, v.voiceProfile),
    briefId: v.briefId,
    brief,
    contentMix: v.contentMix,
    ledgerPath: path.join(cfgDir, path.basename(v.ledger)),
    queuePath: path.join(cfgDir, path.basename(v.queue)),
    exportDir: expandHome(v.exportDir),
    gcp: { project: gcp.project, location: gcp.location, imageLocation: gcp.imageLocation, adc: expandHome(gcp.adc) },
    applyGcpEnv: gcp.apply,
  };
}
