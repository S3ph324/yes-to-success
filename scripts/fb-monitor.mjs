#!/usr/bin/env node
// Read a Facebook Page's recent public comments and surface the real audience
// questions worth turning into a carousel.
//
//   node scripts/fb-monitor.mjs                 # list configured pages
//   node scripts/fb-monitor.mjs jurie           # harvest one page
//   node scripts/fb-monitor.mjs tranzzie --days 60 --limit 20
//
// Credentials come from config/posting.json (gitignored) — never from argv, so
// tokens do not end up in shell history:
//   { "pages": { "jurie":    {"pageId":"…","token":"…"},
//                "tranzzie": {"pageId":"…","token":"…"} } }

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./lib/client.mjs";
import { harvestQuestions, loadPageCreds } from "./lib/fb-source.mjs";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const which = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);

const PERSIST = process.env.PERSIST_BASE || projectRoot;
const creds = await loadPageCreds(PERSIST);
const names = Object.keys(creds);

if (!names.length) {
  console.error(
    "No Page credentials found.\n\n" +
    `Create ${path.join(PERSIST, "config", "posting.json")} (gitignored) as:\n` +
    '  { "pages": {\n' +
    '      "jurie":    { "pageId": "<page id>", "token": "<page access token>" },\n' +
    '      "tranzzie": { "pageId": "<page id>", "token": "<page access token>" }\n' +
    "  } }\n\n" +
    "Get each token from developers.facebook.com > Graph API Explorer:\n" +
    "  pick the Page, grant pages_read_engagement, then copy the PAGE token\n" +
    "  (not the user token) and exchange it for a long-lived one.",
  );
  process.exit(1);
}
if (!which) {
  console.log(`Configured pages: ${names.join(", ")}`);
  console.log("Run: node scripts/fb-monitor.mjs <name>");
  process.exit(0);
}
const cred = creds[which];
if (!cred) { console.error(`Unknown page "${which}". Configured: ${names.join(", ")}`); process.exit(1); }

// Skip anything already turned into a carousel.
let covered = [];
try {
  const ledger = JSON.parse(await fs.readFile(path.join(PERSIST, "config", "jurie-topic-ledger.json"), "utf-8"));
  if (Array.isArray(ledger)) covered = ledger.map((e) => e.topic).filter(Boolean);
} catch { /* no ledger yet */ }

try {
  const { page, candidates, scanned } = await harvestQuestions({
    pageId: cred.pageId,
    token: cred.token,
    limit: Number(flag("limit", 10)),
    sinceDays: Number(flag("days", 30)),
    alreadyCovered: covered,
  });
  console.log(`\n${page.name} — ${page.fans ?? "?"} followers`);
  console.log(`scanned ${scanned.posts} posts, ${scanned.comments} comments, ${covered.length} topics already covered\n`);
  if (!candidates.length) {
    console.log("No new audience questions found in that window. Try --days 90.");
    process.exit(0);
  }
  candidates.slice(0, 20).forEach((c, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${c.likes} likes] ${c.question}`);
    console.log(`    on: ${c.onPost}${c.onPost.length >= 90 ? "…" : ""}\n`);
  });
  const outPath = path.join(PERSIST, "config", `fb-questions-${which}.json`);
  await fs.writeFile(outPath, JSON.stringify(candidates, null, 1));
  console.log(`${candidates.length} candidates written to ${outPath}`);
  console.log(`Feed one into the carousel with engine "question".`);
} catch (e) {
  console.error(`Harvest failed: ${e.message}`);
  if (/token|OAuth|190|expired/i.test(e.message)) {
    console.error("That usually means the Page token expired — regenerate it in Graph API Explorer.");
  }
  process.exit(1);
}
