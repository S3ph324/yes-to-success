// Shared aspect-ratio plan builder. Used by BOTH generate-backgrounds-jurie
// (so each background is composed for its target ratio) and render-batch-jurie
// (which crops/renders at that ratio). Deterministic for a given (dist, n) so
// the two stages always agree poster-by-poster.

export const ASPECT_RATIOS = ["1:1", "4:5", "9:16"];

export function buildAspectPlan(distRaw, n) {
  let dist = null;
  try {
    dist = JSON.parse(distRaw || "");
  } catch {
    /* not set / malformed — fall through to null */
  }
  if (!dist || typeof dist !== "object") return null;
  const entries = Object.entries(dist).filter(
    ([k, v]) => ASPECT_RATIOS.includes(k) && Number(v) > 0,
  );
  if (!entries.length) return null;
  const total = entries.reduce((a, [, v]) => a + Number(v), 0);
  if (total <= 0) return null;
  const raw = entries.map(([k, v]) => [k, (Number(v) / total) * n]);
  const buckets = raw.map(([k, r]) => ({ k, count: Math.floor(r), rem: r - Math.floor(r) }));
  let assigned = buckets.reduce((a, b) => a + b.count, 0);
  buckets
    .slice()
    .sort((a, b) => b.rem - a.rem)
    .forEach((b) => {
      if (assigned < n) {
        b.count += 1;
        assigned += 1;
      }
    });
  // Interleave: always pull from whichever bucket has the most remaining,
  // so a 25/50/25 split reads roughly 4:5,1:1,4:5,9:16,4:5,1:1,4:5,9:16…
  const out = [];
  const live = buckets.map((b) => ({ k: b.k, remaining: b.count }));
  for (let i = 0; i < n; i++) {
    live.sort((a, b) => b.remaining - a.remaining);
    const pick = live.find((b) => b.remaining > 0);
    if (!pick) break;
    pick.remaining -= 1;
    out.push(pick.k);
  }
  return out;
}
