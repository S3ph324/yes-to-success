// Per-client Backblaze B2 upload for difference videos. Generalizes
// techsplains-storage.mjs: each brand may use its OWN bucket via
// <CLIENT>_B2_* env keys, falling back to the shared B2_* keys when a client
// doesn't define its own. Buffer's API has no file upload — a video post needs
// a public URL — so approved MP4s are pushed to B2 and Buffer is handed the
// resulting signed download URL. Native B2 REST API (v3), zero dependencies.
//
// Env per client "<id>" (upper-cased), each falling back to the un-prefixed key:
//   <ID>_B2_KEY_ID     | B2_KEY_ID
//   <ID>_B2_APP_KEY    | B2_APP_KEY
//   <ID>_B2_BUCKET_ID  | B2_BUCKET_ID
//   <ID>_B2_BUCKET_NAME| B2_BUCKET_NAME
// The bucket stays PRIVATE — we mint a signed download URL (valid 7 days, B2's
// max) that Buffer can fetch without B2 credentials.
import "./load-env.mjs";
import fs from "node:fs";
import crypto from "node:crypto";

const U = (clientId) => String(clientId || "").toUpperCase();
// Per-client key with fallback to the shared un-prefixed key.
const envFor = (clientId, suffix) =>
  process.env[`${U(clientId)}_B2_${suffix}`] || process.env[`B2_${suffix}`];

function creds(clientId) {
  return {
    keyId: envFor(clientId, "KEY_ID"),
    appKey: envFor(clientId, "APP_KEY"),
    bucketId: envFor(clientId, "BUCKET_ID"),
    bucketName: envFor(clientId, "BUCKET_NAME"),
  };
}

export function storageConfigured(clientId) {
  const c = creds(clientId);
  return Boolean(c.keyId && c.appKey && c.bucketId && c.bucketName);
}

async function authorize(c) {
  const basic = Buffer.from(`${c.keyId}:${c.appKey}`).toString("base64");
  const r = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`B2 authorize failed: ${j.message || r.status}`);
  const storage = j.apiInfo?.storageApi || {};
  return { authToken: j.authorizationToken, apiUrl: storage.apiUrl, downloadUrl: storage.downloadUrl };
}

// Percent-encode each path segment but keep the slashes (B2 filenames are
// slash-delimited "folders"). The public URL must use the same encoding.
function encodeName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

// Max lifetime of a B2 signed download URL (7 days). Buffer copies the media
// into its own storage when the post is created, so the link only needs to be
// live at scheduling time.
const SIGN_SECONDS = 604800;

// Upload a local file for the given client and return a signed download URL.
export async function uploadPublic(clientId, localPath, remoteName) {
  const c = creds(clientId);
  if (!storageConfigured(clientId)) throw new Error(`B2 (${clientId}) not configured`);
  const { authToken, apiUrl, downloadUrl } = await authorize(c);

  const gu = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: "POST",
    headers: { Authorization: authToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId: c.bucketId }),
  });
  const guj = await gu.json();
  if (!gu.ok) throw new Error(`B2 get_upload_url failed: ${guj.message || gu.status}`);

  const bytes = fs.readFileSync(localPath);
  const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");
  const encoded = encodeName(remoteName);

  const up = await fetch(guj.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: guj.authorizationToken,
      "X-Bz-File-Name": encoded,
      "Content-Type": "b2/x-auto",
      "Content-Length": String(bytes.length),
      "X-Bz-Content-Sha1": sha1,
    },
    body: bytes,
  });
  const upj = await up.json();
  if (!up.ok) throw new Error(`B2 upload failed: ${upj.message || up.status}`);

  // Sign the URL (private bucket) so Buffer can fetch without B2 auth.
  const da = await fetch(`${apiUrl}/b2api/v3/b2_get_download_authorization`, {
    method: "POST",
    headers: { Authorization: authToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      bucketId: c.bucketId,
      fileNamePrefix: remoteName,
      validDurationInSeconds: SIGN_SECONDS,
    }),
  });
  const daj = await da.json();
  if (!da.ok) throw new Error(`B2 download-auth failed: ${daj.message || da.status}`);

  return `${downloadUrl}/file/${c.bucketName}/${encoded}?Authorization=${daj.authorizationToken}`;
}
