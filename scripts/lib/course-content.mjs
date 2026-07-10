// scripts/lib/course-content.mjs
// Content-loading layer for the Techsplains PDF course: looks up reused
// difference-pair topics (text + real sourced images) from the existing
// video pipeline's output, and turns course Markdown files into HTML with
// {{sidebar:N}} placeholders resolved into "Did You Know?" boxes.

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { projectRoot } from "./client.mjs";

const norm = (s) => String(s || "").trim().toLowerCase();

export function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Scans every techsplains-scripts-*.json in `dir` and indexes every segment
// by its normalized "aLabel|bLabel" key. `out/` (and public/generated-diff/)
// are gitignored/local-only — this index only ever reflects whatever batches
// currently exist on the machine running it.
export async function buildTopicIndex(dir = path.join(projectRoot, "out")) {
  const index = new Map();
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => /^techsplains-scripts-.*\.json$/.test(f));
  } catch {
    return index;
  }
  for (const f of files.sort()) {
    let videos;
    try {
      videos = JSON.parse(await fs.readFile(path.join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    for (const v of videos) {
      for (const s of v.segments || []) {
        if (!s.aLabel) continue;
        const key = `${norm(s.aLabel)}|${norm(s.bLabel)}`;
        index.set(key, {
          title: v.title,
          aLabel: s.aLabel,
          bLabel: s.bLabel,
          defA: s.defA || "",
          defB: s.defB || "",
          aImg: s.aImg || "",
          bImg: s.bImg || "",
        });
      }
    }
  }
  return index;
}

// Looks up a reused difference-pair by its two labels and verifies its
// images still exist on disk. Throws a clear, actionable error rather than
// silently producing a course page with a broken image.
export async function findTopic(
  index,
  aLabel,
  bLabel,
  { publicDir = path.join(projectRoot, "public") } = {},
) {
  const key = `${norm(aLabel)}|${norm(bLabel)}`;
  const hit = index.get(key);
  if (!hit) {
    throw new Error(
      `No sourced topic found for "${aLabel}" vs "${bLabel}". Re-run ` +
        `"npm run techsplains:gen" and "npm run techsplains:images" for ` +
        `this pair before referencing it from course content.`,
    );
  }
  for (const [side, rel] of [["aImg", hit.aImg], ["bImg", hit.bImg]]) {
    if (!rel) continue;
    try {
      await fs.access(path.join(publicDir, rel));
    } catch {
      throw new Error(
        `Topic "${aLabel}" vs "${bLabel}" has ${side}="${rel}" but that ` +
          `file is missing on disk — re-run "npm run techsplains:images".`,
      );
    }
  }
  return hit;
}

function sidebarHtml(t) {
  const figure = (label, rel) =>
    rel
      ? `<figure><img src="${rel}" alt="${escapeHtml(label)}"><figcaption>${escapeHtml(label)}</figcaption></figure>`
      : "";
  return `
<aside class="sidebar">
  <p class="sidebar-eyebrow">Did You Know?</p>
  <h4>${escapeHtml(t.aLabel)}${t.bLabel ? ` vs ${escapeHtml(t.bLabel)}` : ""}</h4>
  <div class="sidebar-pair">
    ${figure(t.aLabel, t.aImg)}
    ${figure(t.bLabel, t.bImg)}
  </div>
  <p><strong>${escapeHtml(t.aLabel)}:</strong> ${escapeHtml(t.defA)}</p>
  ${t.defB ? `<p><strong>${escapeHtml(t.bLabel)}:</strong> ${escapeHtml(t.defB)}</p>` : ""}
</aside>`;
}

const SIDEBAR_RE = /\{\{sidebar:(\d+)\}\}/g;

// Parses a course content Markdown file (YAML frontmatter + body), resolves
// any {{sidebar:N}} placeholders against `sidebars[N]` in frontmatter, and
// returns { title, moduleNumber, tier, bodyHtml }.
//
// The placeholder substitution runs on the RAW markdown `content`, before
// marked.parse() — not on the parsed HTML. marked wraps bare-text lines in
// <p>, so substituting after parsing would nest the sidebar's block-level
// <aside> inside a <p> (invalid HTML, silently auto-corrected by browsers,
// but avoidable). Substituting first means marked sees a real HTML block
// (a line starting with a block tag, blank-line-delimited) and passes it
// through unwrapped, per how marked's tokenizer treats raw HTML blocks.
export async function renderModuleMarkdown(filePath, topicIndex, { publicDir } = {}) {
  const raw = await fs.readFile(filePath, "utf-8");
  const { data, content } = matter(raw);
  const sidebarDefs = data.sidebars || [];
  const resolved = [];
  for (const sb of sidebarDefs) {
    resolved.push(await findTopic(topicIndex, sb.a, sb.b, { publicDir }));
  }
  const withSidebars = content.replace(SIDEBAR_RE, (match, idxStr) => {
    const idx = Number(idxStr);
    const t = resolved[idx];
    if (!t) {
      throw new Error(
        `${filePath} references {{sidebar:${idx}}} but frontmatter only ` +
          `defines ${resolved.length} sidebar(s).`,
      );
    }
    return sidebarHtml(t);
  });
  const bodyHtml = marked.parse(withSidebars);
  return {
    title: data.title || path.basename(filePath, ".md"),
    moduleNumber: data.moduleNumber ?? null,
    tier: data.tier ?? null,
    bodyHtml,
  };
}
