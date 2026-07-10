import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import url from "node:url";
import { buildTopicIndex, findTopic, renderModuleMarkdown, escapeHtml } from "../lib/course-content.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_OUT = path.join(__dirname, "fixtures", "course", "out");
const FIXTURE_PUBLIC = path.join(__dirname, "fixtures", "course", "public");
const FIXTURE_MODULE = path.join(__dirname, "fixtures", "course", "sample-module.md");

test("escapeHtml escapes the five HTML-significant characters", () => {
  assert.equal(escapeHtml(`<a href="x">T&om's</a>`), "&lt;a href=&quot;x&quot;&gt;T&amp;om&#39;s&lt;/a&gt;");
});

test("buildTopicIndex + findTopic resolves a known difference-pair by label", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  const topic = await findTopic(index, "Cut", "Transition", { publicDir: FIXTURE_PUBLIC });
  assert.equal(topic.defA, "A cut instantly changes from one shot to the next.");
  assert.equal(topic.defB, "A transition is a visual effect that smoothly connects two shots.");
  assert.equal(topic.aImg, "generated-diff/fixture/01-1a.jpg");
});

test("findTopic is case/whitespace-insensitive on labels", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  const topic = await findTopic(index, "  cut ", "TRANSITION", { publicDir: FIXTURE_PUBLIC });
  assert.equal(topic.aLabel, "Cut");
});

test("findTopic throws a clear, actionable error for an unsourced pair", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  await assert.rejects(
    () => findTopic(index, "Codec", "Container", { publicDir: FIXTURE_PUBLIC }),
    /No sourced topic found for "Codec" vs "Container"/,
  );
});

test("findTopic throws when the image file is missing on disk", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  await assert.rejects(
    () => findTopic(index, "Cut", "Transition", { publicDir: path.join(__dirname, "fixtures", "course", "nonexistent-public") }),
    /file is missing on disk/,
  );
});

test("renderModuleMarkdown resolves {{sidebar:N}} into a Did-You-Know box", async () => {
  const index = await buildTopicIndex(FIXTURE_OUT);
  const { title, moduleNumber, tier, bodyHtml } = await renderModuleMarkdown(FIXTURE_MODULE, index, { publicDir: FIXTURE_PUBLIC });
  assert.equal(title, "Sample Module");
  assert.equal(moduleNumber, 99);
  assert.equal(tier, "fundamentals");
  // Tolerant of marked possibly adding heading attributes across versions —
  // the point of this assertion is "the heading rendered", not its exact tag.
  assert.match(bodyHtml, /<h1[^>]*>Sample Module<\/h1>/);
  assert.match(bodyHtml, /class="sidebar"/);
  assert.match(bodyHtml, /A cut instantly changes from one shot to the next\./);
  assert.match(bodyHtml, /src="generated-diff\/fixture\/01-1a\.jpg"/);
});

test("renderModuleMarkdown throws if a {{sidebar:N}} has no matching frontmatter entry", async () => {
  const badPath = path.join(__dirname, "fixtures", "course", "bad-module.md");
  const fs = await import("node:fs/promises");
  await fs.writeFile(badPath, `---\ntitle: "Bad"\nsidebars: []\n---\n\nBody {{sidebar:0}}\n`);
  const index = await buildTopicIndex(FIXTURE_OUT);
  await assert.rejects(
    () => renderModuleMarkdown(badPath, index, { publicDir: FIXTURE_PUBLIC }),
    /only defines 0 sidebar\(s\)/,
  );
  await fs.rm(badPath);
});
