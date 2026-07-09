// Side-effect .env loader (no dotenv dep). Import this for its side effect;
// repo-root .env values land in process.env, and real environment variables
// always win. Same parsing as lib/techsplains.mjs's inline loader, factored
// out so the dashboard's Buffer/storage libs don't each re-implement it.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
try {
  const envText = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* no .env — fine */
}
