import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSlots } from "../lib/techsplains-schedule.mjs";

test("one per day fills consecutive days at the given time", () => {
  const slots = computeSlots({ perDay: 1, timeOfDay: "09:00", startDate: "2026-07-10", count: 3 });
  assert.equal(slots.length, 3);
  const d0 = new Date(slots[0]);
  assert.equal(d0.getHours(), 9);
  assert.equal(d0.getMinutes(), 0);
  // Each subsequent slot is ~24h after the previous.
  const day = 24 * 60 * 60 * 1000;
  assert.equal(Math.round((new Date(slots[1]) - d0) / day), 1);
  assert.equal(Math.round((new Date(slots[2]) - d0) / day), 2);
});

test("multiple per day space posts 3h apart within a day, then roll over", () => {
  const slots = computeSlots({ perDay: 2, timeOfDay: "09:00", startDate: "2026-07-10", count: 3 });
  const [a, b, c] = slots.map((s) => new Date(s));
  assert.equal(a.getHours(), 9);
  assert.equal(b.getHours(), 12); // +3h same day
  assert.equal(a.toDateString(), b.toDateString());
  assert.notEqual(a.toDateString(), c.toDateString()); // third rolls to next day
  assert.equal(c.getHours(), 9);
});

test("count 0 returns empty", () => {
  assert.deepEqual(computeSlots({ perDay: 1, timeOfDay: "09:00", startDate: "2026-07-10", count: 0 }), []);
});
