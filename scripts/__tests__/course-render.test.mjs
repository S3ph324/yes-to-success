import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPage, planOutputs } from "../lib/course-render.mjs";

test("buildPage embeds the theme CSS and section HTML", async () => {
  const html = await buildPage({
    theme: "branded",
    title: "Test Doc",
    sections: [{ bodyHtml: "<h1>Hello</h1>" }],
  });
  assert.match(html, /<title>Test Doc<\/title>/);
  assert.match(html, /<h1>Hello<\/h1>/);
});

test("buildPage adds the follow-footer and brand accent color only for the branded theme", async () => {
  const branded = await buildPage({ theme: "branded", title: "T", sections: [{ bodyHtml: "<p>x</p>" }] });
  const blank = await buildPage({ theme: "blank", title: "T", sections: [{ bodyHtml: "<p>x</p>" }] });
  assert.match(branded, /Follow @techsplains/);
  assert.match(branded, /#FFDD00/);
  assert.doesNotMatch(blank, /Follow @techsplains/);
  assert.doesNotMatch(blank, /#FFDD00/);
});

test("buildPage throws on an unknown theme name", async () => {
  await assert.rejects(
    () => buildPage({ theme: "neon", title: "T", sections: [] }),
    /Unknown theme "neon"/,
  );
});

test("planOutputs combines all modules into one Main-Course doc and keeps bonus docs separate", () => {
  const docs = planOutputs(["01-welcome.md", "02-the-cut.md"], ["02-Glossary.md", "03-Checklist.md"]);
  assert.deepEqual(docs, [
    { kind: "main", files: ["01-welcome.md", "02-the-cut.md"], outName: "01-Main-Course.pdf" },
    { kind: "bonus", files: ["02-Glossary.md"], outName: "02-Glossary.pdf" },
    { kind: "bonus", files: ["03-Checklist.md"], outName: "03-Checklist.pdf" },
  ]);
});

test("planOutputs returns no main doc when there are no modules yet", () => {
  const docs = planOutputs([], ["04-Hooks-List.md"]);
  assert.deepEqual(docs, [{ kind: "bonus", files: ["04-Hooks-List.md"], outName: "04-Hooks-List.pdf" }]);
});
