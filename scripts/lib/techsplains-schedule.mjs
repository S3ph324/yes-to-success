// Posting-slot math for the Techsplains queue.
//
// The operator fixes 1-4 posting TIMES per day (e.g. 09:00 / 15:00 / 21:00,
// server-local wall clock). Auto-schedule walks the calendar forward from
// `after` (usually "now"), yielding each day's times in order and skipping
// slots already taken by previously scheduled posts — so scheduling a new
// batch CONTINUES the posting calendar instead of double-booking day one.

export const DEFAULT_POST_TIMES = ["09:00", "15:00", "21:00"];

// Normalize a user-supplied times list: keep valid HH:MM, dedupe, sort into
// day order, cap at 4/day. An empty/garbage list falls back to the defaults
// rather than producing a schedule that can never emit a slot.
export function sanitizePostTimes(times) {
  const ok = [...new Set(
    (Array.isArray(times) ? times : []).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)),
  )].sort();
  return ok.length ? ok.slice(0, 4) : [...DEFAULT_POST_TIMES];
}

// Next `count` free posting slots strictly after `after`, honoring `taken`
// (ISO strings of slots already assigned). Returns ISO strings.
export function nextSlots({ postTimes, count, after = new Date(), taken = [] }) {
  const times = sanitizePostTimes(postTimes);
  const afterMs = new Date(after).getTime();
  const takenMs = new Set(
    (Array.isArray(taken) ? taken : [])
      .map((t) => new Date(t).getTime())
      .filter(Number.isFinite),
  );
  const base = new Date(afterMs);
  base.setHours(0, 0, 0, 0);
  const slots = [];
  // 366-day guard: with ≥1 valid time/day this can't trigger, but a bug here
  // must never become an infinite loop inside a request handler.
  for (let d = 0; slots.length < count && d < 366; d++) {
    for (const t of times) {
      if (slots.length >= count) break;
      const [hh, mm] = t.split(":").map(Number);
      const slot = new Date(base);
      slot.setDate(base.getDate() + d);
      slot.setHours(hh, mm, 0, 0);
      if (slot.getTime() <= afterMs || takenMs.has(slot.getTime())) continue;
      takenMs.add(slot.getTime());
      slots.push(slot.toISOString());
    }
  }
  return slots;
}
