#!/usr/bin/env node
// Renders every course content Markdown file into the final sellable folder
// structure: course/out/Techsplains-Editing-Course/{Branded,Blank}/*.pdf
//
// Usage:
//   node scripts/course-assemble.mjs                 # both themes
//   node scripts/course-assemble.mjs --theme branded  # one theme only

import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { projectRoot } from "./lib/client.mjs";
import { buildTopicIndex, renderModuleMarkdown } from "./lib/course-content.mjs";
import { buildPage, renderPdf, planOutputs } from "./lib/course-render.mjs";

const courseDir = path.join(projectRoot, "course");
const modulesDir = path.join(courseDir, "content", "modules");
const bonusDir = path.join(courseDir, "content", "bonus");
const outRoot = path.join(courseDir, "out", "Techsplains-Editing-Course");

const themeFlagIdx = process.argv.indexOf("--theme");
const themes = themeFlagIdx !== -1 ? [process.argv[themeFlagIdx + 1]] : ["branded", "blank"];

async function listMd(dir) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

// Bonus-doc titles come from author-controlled frontmatter prose (e.g. a
// future "The Techsplains Hook Vault") and aren't guaranteed brand-neutral
// the way the hardcoded main-course title is — strip the brand name for the
// Blank theme so a future bonus doc can't silently reopen the PDF-metadata
// leak Task 7 closed for the main course.
const stripBrand = (s) => s.replace(/\bTechsplains\s*/gi, "").replace(/\s{2,}/g, " ").trim();

async function main() {
  const topicIndex = await buildTopicIndex();
  const moduleFiles = await listMd(modulesDir);
  const bonusFiles = await listMd(bonusDir);
  const docs = planOutputs(moduleFiles, bonusFiles);
  if (!docs.length) {
    console.error(`No course content found under ${courseDir}/content/ — nothing to render.`);
    process.exit(1);
  }

  const browser = await puppeteer.launch();
  try {
    for (const theme of themes) {
      const destDir = path.join(outRoot, theme === "branded" ? "Branded" : "Blank");
      for (const doc of docs) {
        const srcDir = doc.kind === "main" ? modulesDir : bonusDir;
        const sections = [];
        // The PDF's <title> lands in the file's document-properties metadata,
        // not just the visible page — so the Blank theme needs its own
        // brand-free string, or "Blank" leaks Techsplains in Finder/Reader
        // file info even though the page content itself never mentions it.
        let title =
          theme === "branded"
            ? "Editing Explained: The Techsplains Beginner-to-Creator Course"
            : "Editing Explained: The Beginner-to-Creator Course";
        for (const f of doc.files) {
          const rendered = await renderModuleMarkdown(path.join(srcDir, f), topicIndex);
          sections.push(rendered);
          if (doc.kind === "bonus") title = theme === "blank" ? stripBrand(rendered.title) : rendered.title;
        }
        const html = await buildPage({ theme, title, sections });
        const outPath = path.join(destDir, doc.outName);
        await renderPdf(browser, html, outPath);
        console.log(`✓ [${theme}] ${doc.outName}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone → ${outRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
