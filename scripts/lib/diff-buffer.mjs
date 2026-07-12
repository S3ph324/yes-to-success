// Per-client Buffer posting for difference videos. Generalizes
// techsplains-buffer.mjs so every brand posts to its OWN Buffer account — the
// env keys are namespaced by client id (BUFFER_<CLIENT>_*), so a client's
// videos can never be pushed to another brand's channel. Techsplains keeps
// using its own module unchanged; this one drives Tranzzie (and any future
// brand) from the same code path.
//
// Env per client "<id>" (upper-cased): BUFFER_<ID>_API_KEY, BUFFER_<ID>_CHANNEL,
// optional BUFFER_<ID>_FB_TYPE ("reel" default). Buffer's API has no upload
// mutation, so the video is referenced by a public URL (see diff-storage.mjs).
import "./load-env.mjs";

const API = "https://api.buffer.com";

const U = (clientId) => String(clientId || "").toUpperCase();
const apiKey = (clientId) => process.env[`BUFFER_${U(clientId)}_API_KEY`];
const channel = (clientId) => process.env[`BUFFER_${U(clientId)}_CHANNEL`];
// Facebook publishing type. Vertical 9:16 clips post as reels for reach;
// override to "post" per client via BUFFER_<ID>_FB_TYPE if a page isn't reel-eligible.
const fbTypeFor = (clientId) => process.env[`BUFFER_${U(clientId)}_FB_TYPE`] || "reel";

export function bufferConfigured(clientId) {
  return Boolean(apiKey(clientId) && channel(clientId));
}

async function gql(clientId, query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey(clientId)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

// Build the createPost input for a Facebook video. Pure — exported for testing
// so the exact shape can be asserted without a live API call.
export function buildPostInput({ channelId, videoUrl, caption, dueAt, fbType = "reel" }) {
  return {
    channelId,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt,
    text: caption || "",
    assets: [{ video: { url: videoUrl } }],
    metadata: { facebook: { type: fbType } },
  };
}

// Schedule one video post for the given client. Returns { postId, url }.
export async function schedulePost(clientId, { videoUrl, caption, dueAt }) {
  if (!bufferConfigured(clientId)) throw new Error(`Buffer (${clientId}) not configured`);
  const input = buildPostInput({
    channelId: channel(clientId),
    videoUrl,
    caption,
    dueAt,
    fbType: fbTypeFor(clientId),
  });
  const data = await gql(
    clientId,
    `mutation CP($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on InvalidInputError { message }
        ... on UnexpectedError   { message }
        ... on LimitReachedError { message }
      }
    }`,
    { input },
  );
  const result = data?.createPost;
  if (result?.message) throw new Error(result.message);
  const post = result?.post;
  if (!post?.id) throw new Error("createPost returned no post id");
  return { postId: post.id, url: `https://publish.buffer.com/posts/${post.id}` };
}
