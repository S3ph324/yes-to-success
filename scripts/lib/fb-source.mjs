// Facebook source monitor — reads a Page's recent posts and their PUBLIC
// comments, and turns real audience questions into carousel topics.
//
// WHY THE GRAPH API AND NOT THE BROWSER: browser scraping was tried first and
// does not work. Facebook renders a Page feed with the posts but ZERO comments
// (measured: 4 posts visible, 0 comment buttons, no comment text — comments
// only load per-post behind clicks), and it actively obfuscates the DOM with
// scrambled character runs to defeat scrapers. The Graph API returns the same
// data as clean JSON and does not break when Facebook reskins.
//
// Scope is deliberately public comments only. The Page inbox is not read here:
// DMs are private messages from individuals, and mining them needs a separate,
// explicit decision.
//
// Credentials live in config/posting.json (gitignored, never committed):
//   { "pages": { "jurie": {"pageId":"…","token":"…"},
//                "tranzzie": {"pageId":"…","token":"…"} } }
// The older single-page shape { pageId, token } is still accepted.

import fs from "node:fs/promises";
import path from "node:path";

const GRAPH_BASE = "https://graph.facebook.com/v22.0";

const graph = async (endpoint, params = {}) => {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`${GRAPH_BASE}/${endpoint}?${qs}`);
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = body?.error?.message || `HTTP ${resp.status}`;
    throw new Error(`Graph ${endpoint}: ${msg}`);
  }
  return body;
};

/** Read the page credential map. Returns {} when nothing is configured. */
export async function loadPageCreds(persistBase) {
  const p = path.join(persistBase, "config", "posting.json");
  let raw;
  try { raw = JSON.parse(await fs.readFile(p, "utf-8")); } catch { return {}; }
  if (raw?.pages && typeof raw.pages === "object") return raw.pages;
  // Legacy single-page file.
  if (raw?.pageId && raw?.token) return { default: { pageId: raw.pageId, token: raw.token, pageName: raw.pageName } };
  return {};
}

/** Confirm a token really can see the page, with a readable error if not. */
export async function checkPage({ pageId, token }) {
  const d = await graph(pageId, { access_token: token, fields: "id,name,fan_count" });
  return { id: d.id, name: d.name, fans: d.fan_count };
}

/** Recent posts on a Page. */
export async function getPosts({ pageId, token, limit = 15, sinceDays = 30 }) {
  const since = Math.floor((Date.now() - sinceDays * 864e5) / 1000);
  const d = await graph(`${pageId}/posts`, {
    access_token: token,
    fields: "id,message,created_time,permalink_url,comments.summary(true).limit(0)",
    limit: String(limit),
    since: String(since),
  });
  return (d.data || []).map((p) => ({
    id: p.id,
    message: p.message || "",
    createdAt: p.created_time,
    url: p.permalink_url,
    commentCount: p.comments?.summary?.total_count ?? 0,
  }));
}

/** Public comments on one post. */
export async function getComments({ postId, token, limit = 50 }) {
  const d = await graph(`${postId}/comments`, {
    access_token: token,
    fields: "id,message,created_time,like_count",
    limit: String(limit),
    filter: "toplevel",
    order: "reverse_chronological",
  });
  return (d.data || [])
    .map((c) => ({ id: c.id, message: (c.message || "").trim(), createdAt: c.created_time, likes: c.like_count || 0 }))
    .filter((c) => c.message);
}

// A comment is worth turning into a carousel only if it carries a real
// question. Bare tags, emoji and "PRICE"-style keyword replies are noise —
// on these pages they are the overwhelming majority.
const NOISE = /^(price|pm|dm|pa ?pm|interested|hm|hmm|ok+|sana|nice|wow|ganda|amazing|thanks?|salamat|\W*)$/i;
const QUESTION_HINT = /\?|^(paano|pano|ano|bakit|saan|kailan|sino|magkano|pwede|puwede|how|what|why|when|where|can i|is it|does)\b/i;

export function isQuestion(text) {
  const t = String(text || "").trim();
  if (t.length < 12 || t.length > 400) return false;
  if (NOISE.test(t)) return false;
  return QUESTION_HINT.test(t);
}

/**
 * Walk a Page's recent posts, pull their public comments, and return the
 * question-shaped ones — deduped against topics already covered.
 * @returns {Promise<{page:object, candidates:Array, scanned:{posts:number,comments:number}}>}
 */
export async function harvestQuestions({
  pageId, token, limit = 10, sinceDays = 30, maxPerPost = 50, alreadyCovered = [],
}) {
  const page = await checkPage({ pageId, token });
  const posts = await getPosts({ pageId, token, limit, sinceDays });
  const seenNorm = new Set(alreadyCovered.map((t) => String(t).toLowerCase().replace(/\W+/g, " ").trim()));
  const candidates = [];
  let commentsScanned = 0;

  for (const post of posts) {
    if (!post.commentCount) continue;
    let comments = [];
    try { comments = await getComments({ postId: post.id, token, limit: maxPerPost }); }
    catch { continue; } // one unreadable post must not abort the harvest
    commentsScanned += comments.length;
    for (const c of comments) {
      if (!isQuestion(c.message)) continue;
      const norm = c.message.toLowerCase().replace(/\W+/g, " ").trim();
      if (seenNorm.has(norm)) continue;
      seenNorm.add(norm);
      candidates.push({
        question: c.message,
        likes: c.likes,
        askedAt: c.createdAt,
        onPost: post.message.slice(0, 90),
        postUrl: post.url,
      });
    }
  }
  // Most-engaged questions first — those are the ones the audience shares.
  candidates.sort((a, b) => b.likes - a.likes || String(b.askedAt).localeCompare(String(a.askedAt)));
  return { page, candidates, scanned: { posts: posts.length, comments: commentsScanned } };
}
