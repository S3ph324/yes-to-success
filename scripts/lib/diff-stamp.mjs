// Parse the shared batch stamp from a <client>-scripts-<stamp>.json filename.
// Accepts any lowercase client prefix and the legacy "techsplains-" prefix.
export function stampFromScriptsPath(p) {
  const m = String(p).match(/[a-z0-9]+-scripts-(.+)\.json$/i);
  return m ? m[1] : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
}

// Pick the newest <clientId>-scripts-*.json filename from a directory listing
// (lexical sort works because the stamp is an ISO-ish timestamp). Returns
// null when no match is found.
export function newestScriptsFile(files, clientId) {
  const re = new RegExp(`^${clientId}-scripts-.*\\.json$`);
  const matches = files.filter((f) => re.test(f)).sort();
  return matches.length ? matches[matches.length - 1] : null;
}
