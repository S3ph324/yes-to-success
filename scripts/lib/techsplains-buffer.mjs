// Buffer posting for Techsplains videos. Techsplains has its OWN Buffer account
// (separate from Jurie/Tranzzie), so this uses BUFFER_TECHSPLAINS_* env vars,
// never the shared BUFFER_API_KEY. Buffer's API has no upload mutation, so the
// video is referenced by a public URL (see techsplains-storage.mjs).
//
// Schema verified live against api.buffer.com (June-2026): a Facebook video
// post uses assets:[{ video:{ url } }] (NO thumbnailUrl — rejected) and
// metadata.facebook.type "reel"; dueAt required with mode "customScheduled".
import "./load-env.mjs";

const API = "https://api.buffer.com";
// Facebook publishing type. Vertical 9:16 clips post as reels for reach;
// override to "post" via env if a page isn't reel-eligible.
const FB_TYPE = process.env.BUFFER_TECHSPLAINS_FB_TYPE || "reel";

export function bufferConfigured() {
  return Boolean(process.env.BUFFER_TECHSPLAINS_API_KEY && process.env.BUFFER_TECHSPLAINS_CHANNEL);
}

async function gql(query, variables) {
  const r = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.BUFFER_TECHSPLAINS_API_KEY}`,
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
export function buildPostInput({ channelId, videoUrl, caption, dueAt, fbType = FB_TYPE }) {
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

// Schedule one video post. Returns { postId, url }.
export async function schedulePost({ videoUrl, caption, dueAt }) {
  if (!bufferConfigured()) throw new Error("Buffer (Techsplains) not configured");
  const input = buildPostInput({
    channelId: process.env.BUFFER_TECHSPLAINS_CHANNEL,
    videoUrl,
    caption,
    dueAt,
  });
  const data = await gql(
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
