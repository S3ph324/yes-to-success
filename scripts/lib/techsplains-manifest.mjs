// Machine-readable manifest for a rendered Techsplains batch, plus a fallback
// parser for older batches that only have the human-readable captions.txt.

export function buildManifest(results) {
  return results.map(({ fname, v }) => ({
    file: fname,
    title: v.title || fname,
    caption: v.caption || "",
    variant: v.variant || "difference",
    durationSec: v.durationSec ?? null,
  }));
}

// captions.txt blocks are: "#N — Title" line, caption lines, then a run of
// dashes. Split on the dash rows and pull title + caption out of each block.
export function parseCaptionsTxt(text) {
  const out = [];
  for (const block of text.split(/^-{4,}$/m)) {
    const lines = block.trim().split("\n");
    if (!lines.length || !/^#\d+\s*—/.test(lines[0])) continue;
    out.push({
      title: lines[0].replace(/^#\d+\s*—\s*/, "").trim(),
      caption: lines.slice(1).join("\n").trim(),
    });
  }
  return out;
}
