#!/usr/bin/env node
// SHIM — batch-techsplains.mjs now delegates to the multi-brand batch-diff.mjs
// with --client techsplains. Kept so `npm run techsplains:batch` and any direct
// callers keep working unchanged.
import { spawn } from "node:child_process";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [path.join(__dirname, "batch-diff.mjs"), "--client", "techsplains", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
child.on("close", (code) => process.exit(code ?? 0));
