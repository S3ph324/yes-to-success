#!/usr/bin/env node
// Buffer auto-posting integration for Jurie/Tranzzie clients.
// Posts rendered PNG posters to the client's Facebook Page via Buffer's
// GraphQL API. Images are served from the Railway studio's public /posters/
// route — no separate image host needed.
//
// Usage (called from batch-jurie.mjs after render):
//   node scripts/buffer-poster.mjs --client tranzzie <stamp> <captions.txt>
//
// Env vars required:
//   BUFFER_API_KEY          — Buffer API key (from buffer.com account settings)
//   BUFFER_TRANZZIE_CHANNEL — Buffer channel ID for Tranzzie Eyeglasses page
//   BUFFER_JURIE_CHANNEL    — Buffer channel ID for AI Learnings Mastery page
//   STUDIO_PUBLIC_URL       — Base URL of the Railway studio (no trailing slash)
//                             e.g. https://jurie-automation-production-5045.up.railway.app

import fs from "node:fs/promises";
import path from "node:path";
import { takeClientArg, resolveClient } from "./lib/client.mjs";

// ── Config ──────────────────────────────────────────────────────────────────
const BUFFER_API   = "https://api.buffer.com";
const API_KEY      = process.env.BUFFER_API_KEY || "";
const STUDIO_URL   = (process.env.STUDIO_PUBLIC_URL || "https://jurie-automation-production-5045.up.railway.app").replace(/\/$/, "");

const CHANNEL_IDS  = {
  tranzzie: process.env.BUFFER_TRANZZIE_CHANNEL || "6a1fb490c687a22dd4554170",
  jurie:    process.env.BUFFER_JURIE_CHANNEL    || "6a1fb490c687a22dd455416f",
};

// Minutes between scheduled posts (avoids flooding the feed).
const SPACING_MIN = parseInt(process.env.BUFFER_SPACING_MINUTES || "60", 10);

// ── GraphQL helper ───────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(BUFFER_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
  return json.data;
}

// ── Create a single scheduled Buffer post (updated API schema June 2026) ──────
async function schedulePost(channelId, imageUrl, caption, dueAt) {
  const data = await gql(`
    mutation CP($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on InvalidInputError { message }
        ... on UnexpectedError   { message }
        ... on LimitReachedError { message }
      }
    }
  `, {
    input: {
      channelId,
      schedulingType: "automatic",
      mode: "customScheduled",
      dueAt,
      text: caption,
      assets: [],
      metadata: {
        facebook: {
          type: "post",
          linkAttachment: { url: imageUrl },
        },
      },
    },
  });
  const result = data?.createPost;
  if (result?.message) throw new Error(result.message);
  return result?.post;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const { client: clientArg, rest } = takeClientArg(process.argv.slice(2));
const client    = await resolveClient(clientArg);
const stamp     = rest[0];
const captFile  = rest[1];

if (!stamp || !captFile) {
  console.error("Usage: node scripts/buffer-poster.mjs [--client id] <stamp> <captions.txt>");
  process.exit(1);
}

if (!API_KEY) {
  console.error("BUFFER_API_KEY is not set — skipping Buffer posting.");
  process.exit(0);
}

const channelId = CHANNEL_IDS[client.id];
if (!channelId) {
  console.error(`No Buffer channel ID configured for client "${client.id}" — skipping.`);
  process.exit(0);
}

// Read captions file.
const captText = await fs.readFile(captFile, "utf-8");
const captions = captText
  .split(/^-{20,}\s*$/m)
  .map(s => s.replace(/^#\d+\s*/m, "").trim())
  .filter(Boolean);

// Read the export directory to get poster filenames in order.
const exportDir = path.dirname(captFile);
const pngs = (await fs.readdir(exportDir))
  .filter(f => f.endsWith(".png"))
  .sort();

if (!pngs.length) {
  console.log("No PNG posters found — nothing to post to Buffer.");
  process.exit(0);
}

console.log(`\n━━━ Buffer: scheduling ${pngs.length} post(s) for ${client.label} ━━━`);
console.log(`  Channel ID : ${channelId}`);
console.log(`  Spacing    : ${SPACING_MIN} min between posts`);

// Start scheduling from 1 hour from now, spaced out.
const baseTime = Date.now() + 60 * 60 * 1000;
let succeeded = 0;
let failed    = 0;

for (let i = 0; i < pngs.length; i++) {
  const fname      = pngs[i];
  const caption    = captions[i] || "";
  const imageUrl   = `${STUDIO_URL}/posters/${client.id}/${encodeURIComponent(stamp)}/${encodeURIComponent(fname)}`;
  const schedMs    = baseTime + i * SPACING_MIN * 60 * 1000;
  const schedAt    = new Date(schedMs).toISOString();

  try {
    const post = await schedulePost(channelId, imageUrl, caption, schedAt);
    console.log(`  [${i + 1}/${pngs.length}] ✓ Scheduled ${fname}`);
    console.log(`           → Buffer post ${post.id} at ${post.scheduledAt}`);
    succeeded++;
  } catch (err) {
    console.warn(`  [${i + 1}/${pngs.length}] ✗ Failed ${fname}: ${err.message}`);
    failed++;
  }

  // Small delay between API calls to avoid rate limiting.
  if (i < pngs.length - 1) await new Promise(r => setTimeout(r, 500));
}

console.log(`\n✓ Buffer scheduling done: ${succeeded} scheduled, ${failed} failed`);
if (failed > 0) process.exit(1);
