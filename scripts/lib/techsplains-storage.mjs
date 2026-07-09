// Backblaze B2 upload for Techsplains videos. Buffer's API has no file upload —
// a video post needs a public URL — so approved MP4s are pushed to a public B2
// bucket and Buffer is handed the resulting download URL. Native B2 REST API
// (v3), zero dependencies.
//
// Env (in .env): B2_KEY_ID, B2_APP_KEY, B2_BUCKET_ID, B2_BUCKET_NAME.
// The application key needs writeFiles + shareFiles on that bucket. The bucket
// stays PRIVATE (B2 blocks public buckets until an account has payment history)
// — instead we mint a signed download URL (valid 7 days, B2's max) that Buffer
// can fetch without B2 credentials.
import "./load-env.mjs";
import fs from "node:fs";
import crypto from "node:crypto";

export function storageConfigured() {
  return Boolean(
    process.env.B2_KEY_ID &&
      process.env.B2_APP_KEY &&
      process.env.B2_BUCKET_ID &&
      process.env.B2_BUCKET_NAME,
  );
}

async function authorize() {
  const basic = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString("base64");
  const r = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${basic}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`B2 authorize failed: ${j.message || r.status}`);
  const storage = j.apiInfo?.storageApi || {};
  return { authToken: j.authorizationToken, apiUrl: storage.apiUrl, downloadUrl: storage.downloadUrl };
}

// Percent-encode each path segment but keep the slashes (B2 filenames are
// slash-delimited "folders"). Also the public URL must use the same encoding.
function encodeName(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

// Max lifetime of a B2 signed download URL (7 days). Buffer copies the media
// into its own storage when the post is created, so the link only needs to be
// live at scheduling time — this window is comfortably enough.
const SIGN_SECONDS = 604800;

// Upload a local file and return a signed, publicly-fetchable download URL.
export async function uploadPublic(localPath, remoteName) {
  if (!storageConfigured()) throw new Error("B2 not configured");
  const { authToken, apiUrl, downloadUrl } = await authorize();

  const gu = await fetch(`${apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: "POST",
    headers: { Authorization: authToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId: process.env.B2_BUCKET_ID }),
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
      bucketId: process.env.B2_BUCKET_ID,
      fileNamePrefix: remoteName,
      validDurationInSeconds: SIGN_SECONDS,
    }),
  });
  const daj = await da.json();
  if (!da.ok) throw new Error(`B2 download-auth failed: ${daj.message || da.status}`);

  return `${downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${encoded}?Authorization=${daj.authorizationToken}`;
}
