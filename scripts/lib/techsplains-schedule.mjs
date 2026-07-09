// Assigns posting slots to queued videos: `perDay` posts per day starting at
// `timeOfDay`, spaced 3h apart within a day, rolling to the next day when full.

export function computeSlots({ perDay = 1, timeOfDay = "09:00", startDate, count }) {
  const [hh, mm] = timeOfDay.split(":").map(Number);
  const base = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  const slots = [];
  let day = 0;
  let idxInDay = 0;
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + day);
    d.setHours(hh + idxInDay * 3, mm, 0, 0);
    slots.push(d.toISOString());
    idxInDay += 1;
    if (idxInDay >= Math.max(1, perDay)) {
      idxInDay = 0;
      day += 1;
    }
  }
  return slots;
}
