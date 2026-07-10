// scripts/lib/course-render.mjs
// Wraps rendered module/bonus sections in the branded or blank HTML theme
// and prints the result to PDF via a shared Puppeteer browser instance.
// Also plans which content files become which output PDF (one combined
// Main-Course PDF from all modules; one PDF per bonus doc).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./client.mjs";
import { escapeHtml } from "./course-content.mjs";

const TEMPLATES_DIR = path.join(projectRoot, "course", "templates");
const PUBLIC_DIR = path.join(projectRoot, "public");
const LOGO_ABS = path.join(
  os.homedir(), "Downloads", "Work", "02_Clients", "Techsplains", "06_Branding", "profile-1024.png",
);

const THEME_CSS_FILE = { branded: "branded.css", blank: "blank.css" };

async function loadThemeCss(theme) {
  const file = THEME_CSS_FILE[theme];
  if (!file) throw new Error(`Unknown theme "${theme}". Expected "branded" or "blank".`);
  return fs.readFile(path.join(TEMPLATES_DIR, file), "utf-8");
}

// sections: array of { bodyHtml }, each rendered on its own printed page.
export async function buildPage({ theme, title, sections }) {
  const css = await loadThemeCss(theme);
  const brandFooter =
    theme === "branded"
      ? `<div class="brand-footer"><img class="brand-logo" src="file://${LOGO_ABS}" alt="Techsplains"><span>Follow @techsplains for more byte-sized tech explainers.</span></div>`
      : "";
  const body = sections
    .map((s) => `<section class="course-page">${s.bodyHtml}${brandFooter}</section>`)
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="file://${PUBLIC_DIR}/">
<style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

// Prints `html` to a PDF at `outPath` using a page on the given (already
// launched) Puppeteer browser. Writes the composed HTML to a temp file and
// navigates to it via file:// — page.setContent() + <base href="file://">
// is unreliable for loading local images from a non-file:// origin;
// navigating directly to a file:// URL is the standard, reliable pattern.
export async function renderPdf(browser, html, outPath) {
  const page = await browser.newPage();
  const tmpDir = path.join(projectRoot, "course", "out", ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpHtmlPath = path.join(tmpDir, `${path.basename(outPath, ".pdf")}-${Date.now()}.html`);
  try {
    await fs.writeFile(tmpHtmlPath, html, "utf-8");
    await page.goto(`file://${tmpHtmlPath}`, { waitUntil: "load" });
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath,
      format: "Letter",
      printBackground: true,
      margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
    });
  } finally {
    await page.close();
    await fs.rm(tmpHtmlPath, { force: true });
  }
}

// Pure planning helper — given discovered module/bonus filenames (already
// sorted), returns the list of documents to render. All modules concatenate
// into one Main-Course doc; each bonus file becomes its own PDF named after
// itself.
export function planOutputs(moduleFiles, bonusFiles) {
  const docs = [];
  if (moduleFiles.length) {
    docs.push({ kind: "main", files: moduleFiles, outName: "01-Main-Course.pdf" });
  }
  for (const f of bonusFiles) {
    docs.push({ kind: "bonus", files: [f], outName: f.replace(/\.md$/, ".pdf") });
  }
  return docs;
}
