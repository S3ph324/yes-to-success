// Parse the shared batch stamp from a <client>-scripts-<stamp>.json filename.
// Accepts any lowercase client prefix and the legacy "techsplains-" prefix.
export function stampFromScriptsPath(p) {
  const m = String(p).match(/[a-z0-9]+-scripts-(.+)\.json$/i);
  return m ? m[1] : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
}
