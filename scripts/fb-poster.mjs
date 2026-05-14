// Facebook Graph API helper for posting + scheduling photos to a Page.
//
// Uses FB's native scheduling (scheduled_publish_time) so the Mac doesn't
// have to be on at posting time — FB handles delivery from their servers.

import fs from "node:fs/promises";
import path from "node:path";

const GRAPH_BASE = "https://graph.facebook.com/v22.0";

// Validate a page access token. Returns { id, name, category } on success.
export const validateToken = async (token) => {
  const resp = await fetch(`${GRAPH_BASE}/me?access_token=${encodeURIComponent(token)}&fields=id,name,category`);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token invalid: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
};

// Verify a specific Page ID is accessible with the given token.
export const validatePage = async (pageId, token) => {
  const resp = await fetch(
    `${GRAPH_BASE}/${encodeURIComponent(pageId)}?access_token=${encodeURIComponent(token)}&fields=id,name,fan_count,picture`,
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Page check failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
};

// Post or schedule a single photo to a Page.
//
// Args:
//   pageId       FB Page ID
//   token        Page access token
//   imagePath    Absolute path to image file on disk
//   caption      Caption text (the FB post body)
//   scheduledAt  Optional Date object. If set, FB will schedule (must be
//                10 min to 6 months in future). If omitted, posts immediately.
//
// Returns: { id, post_id, scheduled: boolean, scheduledAt? }
export const postPhotoToPage = async ({
  pageId,
  token,
  imagePath,
  caption,
  scheduledAt,
}) => {
  const imageBytes = await fs.readFile(imagePath);
  const filename = path.basename(imagePath);
  const ext = path.extname(filename).toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";

  const form = new FormData();
  form.append("access_token", token);
  if (caption) form.append("caption", caption);

  if (scheduledAt) {
    const now = Date.now();
    const minTime = now + 10 * 60 * 1000;   // FB requires ≥10 min in future
    const maxTime = now + 180 * 24 * 60 * 60 * 1000; // 6 months
    const t = scheduledAt.getTime();
    if (t < minTime) {
      throw new Error(
        `Scheduled time must be at least 10 minutes from now (was ${Math.round((t - now) / 60000)} min)`,
      );
    }
    if (t > maxTime) {
      throw new Error("Scheduled time must be within 6 months");
    }
    form.append("published", "false");
    form.append(
      "scheduled_publish_time",
      String(Math.floor(t / 1000)),
    );
  }

  // FormData needs a File-like for binary parts in Node 20+.
  const blob = new Blob([imageBytes], { type: mime });
  form.append("source", blob, filename);

  const resp = await fetch(`${GRAPH_BASE}/${encodeURIComponent(pageId)}/photos`, {
    method: "POST",
    body: form,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`FB post failed: ${resp.status} ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    id: data.id,
    post_id: data.post_id,
    scheduled: !!scheduledAt,
    scheduledAt: scheduledAt?.toISOString(),
    fbUrl: data.post_id
      ? `https://www.facebook.com/${data.post_id}`
      : `https://www.facebook.com/${data.id}`,
  };
};

// Look up a previously-scheduled or posted item by FB post id.
export const getPostStatus = async (postId, token) => {
  const resp = await fetch(
    `${GRAPH_BASE}/${encodeURIComponent(postId)}?access_token=${encodeURIComponent(token)}&fields=id,is_published,scheduled_publish_time,created_time,permalink_url`,
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Status check failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
};

// Compute next N peak-hour slots in a given timezone starting after `from`.
//
// peakHours: array of "HH:MM" strings in the target timezone
// timezone:  IANA TZ string e.g. "Asia/Manila"
// from:      Date — slots strictly after this moment
// count:     how many slots to return
// dailyCap:  optional, max slots per day (defaults to peakHours.length)
//
// Returns array of Date objects (UTC instants), chronologically sorted
// within each day so the morning slot fires before the afternoon slot.
export const nextSlots = ({ peakHours, timezone, from, count, dailyCap }) => {
  const cap = dailyCap || peakHours.length;
  // Sort the hour strings chronologically once.
  const sortedHours = [...peakHours].sort();
  const slots = [];
  let cursor = new Date(from.getTime());
  for (let day = 0; slots.length < count && day < 30; day++) {
    let usedToday = 0;
    for (const hhmm of sortedHours) {
      if (usedToday >= cap) break;
      const [hStr, mStr] = hhmm.split(":");
      const h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      const dt = dateInTimezone(cursor, day, h, m, timezone);
      if (dt > from) {
        slots.push(dt);
        usedToday += 1;
      }
      if (slots.length >= count) break;
    }
  }
  return slots;
};

// Build a Date instant for (cursor's date + dayOffset) at HH:MM in given timezone.
function dateInTimezone(cursor, dayOffset, h, m, timezone) {
  // Compute the local date components for `cursor` in that timezone
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(cursor);
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  const y = parseInt(pick("year"), 10);
  const mo = parseInt(pick("month"), 10);
  const d = parseInt(pick("day"), 10);

  // Construct in UTC first, then offset to target tz
  const target = new Date(Date.UTC(y, mo - 1, d + dayOffset, h, m, 0));
  // We've placed the components as if they were UTC, but they should
  // be interpreted as local-time-in-timezone. Need to subtract the tz offset.
  const tzOffsetMs = getTimezoneOffset(target, timezone);
  return new Date(target.getTime() - tzOffsetMs);
}

function getTimezoneOffset(date, timezone) {
  const local = new Date(
    date.toLocaleString("en-US", { timeZone: timezone }),
  );
  const utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}
