import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlots, sanitizePostTimes, DEFAULT_POST_TIMES } from "../lib/techsplains-schedule.mjs";

const local = (iso) => {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

test("fills the remaining times of the current day, then rolls forward", () => {
  // "after" is 10:30 → 09:00 today is gone; 15:00 + 21:00 today, 09:00 tomorrow.
  const after = new Date("2026-07-12T10:30:00");
  const slots = nextSlots({ postTimes: ["09:00", "15:00", "21:00"], count: 3, after });
  assert.deepEqual(slots.map(local), ["15:00", "21:00", "9:00"]);
  assert.equal(new Date(slots[0]).getDate(), 12);
  assert.equal(new Date(slots[2]).getDate(), 13);
});

test("skips slots already taken so new batches continue the calendar", () => {
  const after = new Date("2026-07-12T00:00:00");
  const first = nextSlots({ postTimes: ["09:00", "21:00"], count: 2, after });
  const second = nextSlots({ postTimes: ["09:00", "21:00"], count: 2, after, taken: first });
  // No overlap, and the second batch lands on the NEXT day.
  assert.equal(new Set([...first, ...second]).size, 4);
  assert.equal(new Date(second[0]).getDate(), 13);
});

test("a slot exactly equal to `after` is excluded (strictly future)", () => {
  const after = new Date("2026-07-12T09:00:00");
  const slots = nextSlots({ postTimes: ["09:00"], count: 1, after });
  assert.equal(new Date(slots[0]).getDate(), 13);
});

test("count 0 returns empty", () => {
  assert.deepEqual(nextSlots({ postTimes: ["09:00"], count: 0 }), []);
});

test("sanitizePostTimes dedupes, sorts, caps at 4, falls back to defaults", () => {
  assert.deepEqual(sanitizePostTimes(["21:00", "09:00", "09:00"]), ["09:00", "21:00"]);
  assert.deepEqual(
    sanitizePostTimes(["05:00", "04:00", "03:00", "02:00", "01:00"]),
    ["01:00", "02:00", "03:00", "04:00"],
  );
  assert.deepEqual(sanitizePostTimes(["nope", "25:99"]), DEFAULT_POST_TIMES);
  assert.deepEqual(sanitizePostTimes(undefined), DEFAULT_POST_TIMES);
});
