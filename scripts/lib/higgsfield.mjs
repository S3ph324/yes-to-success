// Higgsfield client — drives the `higgsfield` CLI rather than a REST key.
//
// Auth lives in the CLI's own logged-in session on this machine (there is no
// HIGGSFIELD_API_KEY anywhere in this repo), which is why everything here
// shells out. The practical consequence: anything using this module is
// LOCAL-ONLY. The deployed Railway studio has no higgsfield binary and no
// session, so carousel generation cannot run there until we add REST creds.
//
// Two models, because neither does both jobs:
//   text2image_soul_v2  0.12 cr  identity-locked scenes of Jurie, but it
//                                cannot render legible text.
//   nano_banana_flash   1.5  cr  "Nano Banana 2" — renders type crisply and
//                                supports 4:5, but has no Soul identity lock.
// So a cover is Soul → compose: ~1.62 credits instead of guessing at either.
//
// NOTE the model-id trap: `nano_banana_2` is an ALIAS for Nano Banana *Pro*
// (2 cr). The model actually labelled "Nano Banana 2" is `nano_banana_flash`.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const HF_BIN = process.env.HIGGSFIELD_BIN || "higgsfield";
export const MODEL_SOUL = "text2image_soul_v2";
export const MODEL_IMAGE = "nano_banana_flash";

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;

const run = (args, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(HF_BIN, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || "");
      const errOut = String(stderr || "");
      if (err) {
        const msg = (errOut || out || err.message || "").trim().slice(0, 400);
        if (/ENOENT/.test(err.message || "")) {
          return reject(new Error(`Higgsfield CLI not found (${HF_BIN}). Install it or set HIGGSFIELD_BIN.`));
        }
        const e = new Error(`higgsfield ${args[0]} ${args[1] || ""} failed: ${msg}`);
        // Keep stdout on the error: the CLI has been observed exiting non-zero
        // on a job that actually COMPLETED, with the finished job still printed
        // to stdout. Callers can salvage it rather than discard work we paid for.
        e.stdout = out;
        return reject(e);
      }
      resolve(out);
    });
  });

const parseJson = (raw) => {
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // The CLI sometimes prefixes human lines before the JSON body.
  const i = raw.indexOf("{"), j = raw.indexOf("[");
  const start = i < 0 ? j : j < 0 ? i : Math.min(i, j);
  if (start >= 0) { try { return JSON.parse(raw.slice(start)); } catch { /* give up */ } }
  return null;
};

// THE important bit. A `generate create` response carries BOTH the uploaded
// input reference and the generated output. Scraping URLs out of the raw text
// returns the INPUT — which silently ships the reference photo as the finished
// slide (this actually happened while building this feature). Only ever read
// the explicit `result_url` field.
const resultUrlOf = (parsed) => {
  if (!parsed) return "";
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const urls = items
    .filter((it) => it && typeof it === "object")
    .map((it) => it.result_url)
    .filter(Boolean);
  return urls.length ? urls[urls.length - 1] : "";
};

/** Estimated credit cost for a generation, without running it. */
export async function hfCost(model, params = {}) {
  const args = ["generate", "cost", model, "--json"];
  for (const [k, v] of Object.entries(params)) args.push(`--${k}`, String(v));
  const parsed = parseJson(await run(args, 60_000));
  const n = Number(parsed?.credits);
  return Number.isFinite(n) ? n : null;
}

/** Remaining credits on the signed-in account, or null if unreadable. */
export async function hfBalance() {
  try {
    const out = await run(["account", "status"], 60_000);
    const m = out.match(/([\d.]+)\s*credits/i);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/**
 * Create one generation and block until it finishes.
 * @param {object}   o
 * @param {string}   o.model    e.g. MODEL_IMAGE
 * @param {object}   o.params   CLI params (prompt, aspect_ratio, resolution…)
 * @param {string[]} o.images   local paths or upload ids -> --image-references
 * @returns {Promise<{url:string}>}
 */
export async function hfGenerate({ model, params = {}, images = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const args = ["generate", "create", model];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    args.push(`--${k}`, String(v));
  }
  // Local paths are auto-uploaded by the CLI.
  for (const img of images.filter(Boolean)) args.push("--image-references", img);
  args.push("--wait", "--json");

  let raw;
  try {
    raw = await run(args, timeoutMs);
  } catch (e) {
    // Recover a completed job from a non-zero exit (see the note in run()).
    const salvaged = resultUrlOf(parseJson(e.stdout || ""));
    if (!salvaged) throw e;
    return { url: salvaged, salvaged: true };
  }
  const url = resultUrlOf(parseJson(raw));
  if (!url) throw new Error(`No result_url returned for ${model} (job may have failed).`);
  return { url };
}

/** Download a generated asset to disk. */
export async function hfDownload(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
  return destPath;
}

/**
 * Identity-locked scene of a trained Soul. Cheap (0.12 cr) but CANNOT render
 * readable text — pair it with compose() for anything with type in it.
 * Soul 2.0 has no 4:5 ratio; 3:4 is the closest and compose() reframes.
 */
export async function soulScene({ prompt, soulId, aspect = "3:4", quality = "2k", timeoutMs }) {
  if (!soulId) throw new Error("soulScene needs a Soul reference id.");
  return hfGenerate({
    model: MODEL_SOUL,
    params: { prompt, custom_reference_id: soulId, aspect_ratio: aspect, quality },
    timeoutMs,
  });
}

/**
 * Lay out a finished slide: renders crisp type and supports 4:5. Pass the
 * Soul scene as a reference to carry the likeness through.
 */
export async function compose({ prompt, refs = [], aspect = "4:5", resolution = "2k", timeoutMs }) {
  return hfGenerate({
    model: MODEL_IMAGE,
    params: { prompt, aspect_ratio: aspect, resolution },
    images: refs,
    timeoutMs,
  });
}
