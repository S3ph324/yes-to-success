#!/usr/bin/env node
// Multi-client Quote Poster Studio (Jurie + Tranzzie).
//
// Self-contained control surface for OUR clients only. It does NOT import or
// touch the John Calub server/dashboard. Pick a client → create/choose a
// Brand Kit, a Topic brief, and a Character → Generate → review + download
// posters for manual posting. Autoposting is shown but intentionally inert.
//
//   npm run jurie:dashboard      then open http://localhost:4317
//
// Env: JURIE_DASHBOARD_PORT (default 4317).

import { spawn } from "node:child_process";
import express from "express";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import multer from "multer";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const cfgDir = path.join(projectRoot, "config");
const publicDir = path.join(projectRoot, "public");

// Shown in the header as a deploy signal — bump package.json on each change.
let VERSION = "?";
try {
  VERSION = JSON.parse(
    readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  ).version;
} catch {
  /* leave "?" */
}

const PORT = parseInt(
  process.env.PORT || process.env.JURIE_DASHBOARD_PORT || "4317",
  10,
);
const HOSTED = process.env.HOSTED === "1";
// When hosting, outputs go here (writable volume) instead of the local Mac
// client folders. Per-client = EXPORT_BASE/<clientId>; b-roll = EXPORT_BASE/broll.
const EXPORT_BASE = process.env.EXPORT_BASE || "";

const app = express();
app.set("trust proxy", true);
app.use(express.json());

// ── Cost guardrails — public/no-login, so these protect the GCP bill ──────
const CAP_DAY = parseInt(process.env.STUDIO_DAILY_CAP || "40", 10);
const CAP_IP_HR = parseInt(process.env.STUDIO_IP_PER_HOUR || "4", 10);
let dayKey = "";
let dayCount = 0;
const ipHits = new Map();
// Returns true if allowed; otherwise writes a 429/503 and returns false.
// Only call once per real generation, AFTER input validation.
const guard = (req, res) => {
  if (process.env.STUDIO_KILL === "1") {
    res.status(503).json({ error: "Generation is temporarily disabled." });
    return false;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
    ipHits.clear();
  }
  if (dayCount >= CAP_DAY) {
    res.status(429).json({
      error: `Daily generation cap reached (${CAP_DAY}). Try again tomorrow.`,
    });
    return false;
  }
  const ip = String(req.ip || req.headers["x-forwarded-for"] || "anon")
    .split(",")[0]
    .trim();
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= CAP_IP_HR) {
    res.status(429).json({
      error: `Rate limit: max ${CAP_IP_HR} generations/hour per visitor.`,
    });
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount += 1;
  return true;
};

const readCfg = async (name, fb) => {
  try {
    return JSON.parse(await fs.readFile(path.join(cfgDir, name), "utf-8"));
  } catch {
    return fb;
  }
};
const writeCfg = (name, data) =>
  fs.writeFile(path.join(cfgDir, name), JSON.stringify(data, null, 2));

const getClients = () => readCfg("clients.json", []);
const getClient = async (id) =>
  (await getClients()).find((c) => c.id === id) || null;

// ── Clients ───────────────────────────────────────────────────────────────
app.get("/api/clients", async (_q, res) =>
  res.json(
    (await getClients()).map((c) => ({
      id: c.id,
      label: c.label,
      characterId: c.characterId || "",
    })),
  ),
);

// Serve a character reference photo for the Generate preview.
app.get("/api/charphoto", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("characters/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "characters")))
    return res.status(400).end();
  res.sendFile(fp);
});

// Serve a brand-kit logo for preview.
app.get("/api/brandlogo", (req, res) => {
  const rel = String(req.query.p || "");
  if (!rel.startsWith("brand/") || rel.includes(".."))
    return res.status(400).end();
  const fp = path.join(publicDir, rel);
  if (!fp.startsWith(path.join(publicDir, "brand")))
    return res.status(400).end();
  res.sendFile(fp);
});

// ── Brand Kits (brand-presets.json, filtered to the client) ───────────────
app.get("/api/brand", async (req, res) => {
  const all = await readCfg("brand-presets.json", []);
  res.json(all.filter((p) => p.client === req.query.client));
});
app.post("/api/brand", async (req, res) => {
  const p = req.body;
  if (!p?.id || !p?.client)
    return res.status(400).json({ error: "id and client required" });
  const all = await readCfg("brand-presets.json", []);
  const i = all.findIndex((x) => x.id === p.id);
  if (i === -1) all.push(p);
  else all[i] = { ...all[i], ...p };
  await writeCfg("brand-presets.json", all);
  res.json(p);
});

// ── Topics / Briefs (briefs.json, filtered to the client) ─────────────────
app.get("/api/briefs", async (req, res) => {
  const all = await readCfg("briefs.json", []);
  res.json(all.filter((b) => b.client === req.query.client));
});
app.post("/api/briefs", async (req, res) => {
  const b = req.body;
  if (!b?.id || !b?.client)
    return res.status(400).json({ error: "id and client required" });
  if (typeof b.topics === "string")
    b.topics = b.topics
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
  const all = await readCfg("briefs.json", []);
  const i = all.findIndex((x) => x.id === b.id);
  if (i === -1) all.push(b);
  else all[i] = { ...all[i], ...b };
  await writeCfg("briefs.json", all);
  res.json(b);
});

// ── Characters (characters.json, filtered to the client) ──────────────────
app.get("/api/characters", async (req, res) => {
  const all = await readCfg("characters.json", []);
  res.json(
    req.query.client
      ? all.filter((c) => c.client === req.query.client)
      : all,
  );
});
app.post("/api/characters", async (req, res) => {
  const c = req.body;
  if (!c?.id || !c?.client)
    return res.status(400).json({ error: "id and client required" });
  const all = await readCfg("characters.json", []);
  const i = all.findIndex((x) => x.id === c.id);
  if (i === -1) all.push({ photos: [], enabled: true, ...c });
  else all[i] = { ...all[i], ...c };
  await writeCfg("characters.json", all);
  res.json(c);
});

const photoStore = multer.diskStorage({
  destination: async (req, _f, cb) => {
    const client = req.query.client || "misc";
    const d = path.join(publicDir, "characters", client);
    await fs.mkdir(d, { recursive: true });
    cb(null, d);
  },
  filename: (_r, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
const uploadPhoto = multer({ storage: photoStore });
app.post(
  "/api/characters/photo",
  uploadPhoto.single("photo"),
  async (req, res) => {
    const { client, charId } = req.query;
    if (!req.file) return res.status(400).json({ error: "no file" });
    const rel = path.posix.join("characters", client, req.file.filename);
    const all = await readCfg("characters.json", []);
    const ch = all.find((x) => x.id === charId);
    if (ch) {
      ch.photos = ch.photos || [];
      ch.photos.push(rel);
      await writeCfg("characters.json", all);
    }
    res.json({ ok: true, path: rel });
  },
);

const logoStore = multer.diskStorage({
  destination: async (_r, _f, cb) => {
    const d = path.join(publicDir, "brand");
    await fs.mkdir(d, { recursive: true });
    cb(null, d);
  },
  filename: (_r, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
});
app.post(
  "/api/brand/logo",
  multer({ storage: logoStore }).single("logo"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "no file" });
    res.json({ ok: true, path: path.posix.join("brand", req.file.filename) });
  },
);

// ── Generate (one job at a time) ──────────────────────────────────────────
let job = null;
const sse = new Set();
const log = (line) => {
  if (!job) return;
  job.log.push(line);
  if (job.log.length > 3000) job.log.shift();
  for (const r of sse) r.write(`data: ${JSON.stringify(line)}\n\n`);
};
app.get("/api/log", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();
  for (const l of job?.log || []) r2(res, l);
  function r2(rr, l) {
    rr.write(`data: ${JSON.stringify(l)}\n\n`);
  }
  sse.add(res);
  req.on("close", () => sse.delete(res));
});
app.get("/api/status", (_q, res) =>
  res.json({
    running: !!job?.running,
    client: job?.client || "",
    code: job?.code ?? null,
  }),
);
app.post("/api/generate", async (req, res) => {
  if (job?.running)
    return res.status(409).json({ error: "A batch is already running." });
  const { client, topic, count, briefId, brandPresetId, characterId } =
    req.body || {};
  const c = await getClient(client);
  if (!c) return res.status(400).json({ error: "Unknown client" });
  const t = String(topic || "").trim().slice(0, 200);
  let n = parseInt(count, 10);
  if (!Number.isFinite(n)) n = 8;
  n = Math.max(1, Math.min(30, n));
  if (!t) return res.status(400).json({ error: "Topic is required." });
  if (!guard(req, res)) return;

  job = { running: true, client, log: [], code: null };
  log(`▶ [${c.label}] ${n} poster(s) about "${t}"…`);
  const env = { ...process.env };
  if (EXPORT_BASE) env.JURIE_EXPORT_DIR = path.join(EXPORT_BASE, client);
  if (briefId) env.DASHBOARD_BRIEF_ID = briefId;
  if (brandPresetId) env.DASHBOARD_BRAND_PRESET_ID = brandPresetId;
  if (characterId !== undefined) env.DASHBOARD_CHARACTER_ID = characterId;
  env.JURIE_NO_OPEN = "1";
  const child = spawn(
    "node",
    ["scripts/batch-jurie.mjs", "--client", client, String(n), t],
    { cwd: projectRoot, env },
  );
  const onData = (b) =>
    String(b)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach(log);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    job.running = false;
    job.code = code;
    log(code === 0 ? "✓ Done. Refresh Batches." : `✗ Exited (${code}).`);
  });
  res.json({ ok: true });
});

// ── Batches / posters (per client export dir) ─────────────────────────────
const safeStamp = (s) => /^[0-9T:\-]+$/.test(s);
const clientExportDir = (c) =>
  EXPORT_BASE ? path.join(EXPORT_BASE, c.id) : c.exportDir;

app.get("/api/batches", async (req, res) => {
  const c = await getClient(req.query.client);
  if (!c) return res.json([]);
  const baseDir = clientExportDir(c);
  let stamps = [];
  try {
    stamps = (await fs.readdir(baseDir))
      .filter(safeStamp)
      .sort()
      .reverse();
  } catch {
    return res.json([]);
  }
  const out = [];
  for (const stamp of stamps) {
    const dir = path.join(baseDir, stamp);
    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    } catch {
      continue;
    }
    let captions = "";
    try {
      captions = await fs.readFile(path.join(dir, "captions.txt"), "utf-8");
    } catch {
      /* none */
    }
    out.push({ stamp, count: files.length, files, captions });
  }
  res.json(out);
});
app.get("/posters/:client/:stamp/:file", async (req, res) => {
  const { client, stamp, file } = req.params;
  const c = await getClient(client);
  if (!c || !safeStamp(stamp) || !/^[\w.\- ]+\.png$/.test(file))
    return res.status(400).end();
  const cBase = clientExportDir(c);
  const fp = path.join(cBase, stamp, file);
  if (!fp.startsWith(path.join(cBase, stamp)))
    return res.status(400).end();
  if (req.query.dl)
    res.set("Content-Disposition", `attachment; filename="${file}"`);
  res.sendFile(fp);
});
app.post("/api/reveal", async (req, res) => {
  const c = await getClient(req.body?.client);
  if (!c) return res.status(400).json({ error: "bad client" });
  if (HOSTED || process.platform !== "darwin")
    return res.json({ ok: true, hosted: true });
  const stamp = String(req.body?.stamp || "");
  const base = clientExportDir(c);
  const target = safeStamp(stamp) ? path.join(base, stamp) : base;
  spawn("open", [target], { stdio: "ignore" });
  res.json({ ok: true });
});

// ── B-Roll maker ──────────────────────────────────────────────────────────
const BROLL_BASE = EXPORT_BASE
  ? path.join(EXPORT_BASE, "broll")
  : path.join(projectRoot, "..", "..", "brolls", "generated");
const brollUpload = multer({
  storage: multer.diskStorage({
    destination: async (_r, _f, cb) => {
      const d = path.join(projectRoot, "out", "broll-uploads");
      await fs.mkdir(d, { recursive: true });
      cb(null, d);
    },
    filename: (_r, file, cb) =>
      cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, "_")}`),
  }),
});

app.post(
  "/api/broll/generate",
  brollUpload.single("video"),
  async (req, res) => {
    if (job?.running)
      return res.status(409).json({ error: "A job is already running." });
    const aspect = req.body?.aspect === "16:9" ? "16:9" : "9:16";
    let n = parseInt(req.body?.count, 10);
    if (!Number.isFinite(n)) n = 8;
    n = Math.max(1, Math.min(40, n));
    const characterId = String(req.body?.characterId || "");
    const scriptText = String(req.body?.script || "").trim();
    if (HOSTED && req.file)
      return res.status(400).json({
        error:
          "Video B-roll is disabled on the hosted build — paste a script, or run video locally.",
      });
    const args = [
      "scripts/broll-batch.mjs",
      "--aspect",
      aspect,
      "--count",
      String(n),
    ];
    if (characterId && characterId !== "none")
      args.push("--character", characterId);
    if (req.file) {
      args.push("--video", req.file.path);
    } else if (scriptText.length > 10) {
      const sf = path.join(
        projectRoot,
        "out",
        `broll-input-${Date.now()}.txt`,
      );
      await fs.writeFile(sf, scriptText);
      args.push("--script", sf);
    } else {
      return res
        .status(400)
        .json({ error: "Provide a script (10+ chars) or a video file." });
    }
    if (!guard(req, res)) return;
    job = { running: true, client: "broll", log: [], code: null };
    log(
      `▶ B-Roll: ${n} shot(s), ${aspect}` +
        (characterId && characterId !== "none"
          ? `, character ${characterId}`
          : "") +
        (req.file ? " (from video)" : " (from script)") +
        "…",
    );
    const env = { ...process.env, BROLL_EXPORT_DIR: BROLL_BASE };
    const child = spawn("node", args, { cwd: projectRoot, env });
    const onData = (b) =>
      String(b).split(/\r?\n/).filter(Boolean).forEach(log);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      job.running = false;
      job.code = code;
      log(code === 0 ? "✓ Done. Refresh B-Roll sets." : `✗ Exited (${code}).`);
    });
    res.json({ ok: true });
  },
);

app.get("/api/broll/sets", async (_q, res) => {
  let stamps = [];
  try {
    stamps = (await fs.readdir(BROLL_BASE))
      .filter(safeStamp)
      .sort()
      .reverse();
  } catch {
    return res.json([]);
  }
  const out = [];
  for (const stamp of stamps) {
    const dir = path.join(BROLL_BASE, stamp);
    let man = null;
    try {
      man = JSON.parse(
        await fs.readFile(path.join(dir, "manifest.json"), "utf-8"),
      );
    } catch {
      continue;
    }
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      /* none */
    }
    const shots = (man.shots || []).map((s) => ({
      n: s.n,
      title: s.title,
      beat: s.beat,
      timecode: s.timecode,
      usesCharacter: s.usesCharacter,
      imagePrompt: s.imagePrompt,
      videoPrompt: s.videoPrompt,
      picked: !!s.picked,
      hasFrame: files.includes(`shot-${String(s.n).padStart(2, "0")}.png`),
    }));
    out.push({
      stamp,
      meta: man.meta || {},
      shots,
      hasHtml: files.includes("broll.html"),
    });
  }
  res.json(out);
});

app.get("/broll-asset/:stamp/:file", (req, res) => {
  const { stamp, file } = req.params;
  if (
    !safeStamp(stamp) ||
    !/^(shot-\d+\.png|broll\.html|manifest\.json)$/.test(file)
  )
    return res.status(400).end();
  const fp = path.join(BROLL_BASE, stamp, file);
  if (!fp.startsWith(path.join(BROLL_BASE, stamp)))
    return res.status(400).end();
  if (req.query.dl)
    res.set("Content-Disposition", `attachment; filename="${file}"`);
  res.sendFile(fp);
});

app.post("/api/broll/pick", async (req, res) => {
  const stamp = String(req.body?.stamp || "");
  const picks = Array.isArray(req.body?.picks) ? req.body.picks : [];
  if (!safeStamp(stamp)) return res.status(400).json({ error: "bad stamp" });
  const manPath = path.join(BROLL_BASE, stamp, "manifest.json");
  let man;
  try {
    man = JSON.parse(await fs.readFile(manPath, "utf-8"));
  } catch {
    return res.status(404).json({ error: "set not found" });
  }
  for (const s of man.shots || []) s.picked = picks.includes(s.n);
  await fs.writeFile(manPath, JSON.stringify(man, null, 2));
  // Mirror picks to the working out/ json so a future Veo run honors them.
  try {
    const created = man.meta?.createdAt;
    if (created) {
      const wp = path.join(projectRoot, "out", `broll-${created}.json`);
      const w = JSON.parse(await fs.readFile(wp, "utf-8"));
      for (const s of w.shots || []) s.picked = picks.includes(s.n);
      await fs.writeFile(wp, JSON.stringify(w, null, 2));
    }
  } catch {
    /* working json may be gone — manifest is the source of truth */
  }
  res.json({ ok: true, picked: picks.length });
});

// Zip + stream all PNGs in a folder (batch download).
const sendZip = async (dir, zipName, res) => {
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png"));
  } catch {
    return res.status(404).json({ error: "not found" });
  }
  if (!files.length) return res.status(404).json({ error: "no images" });
  const tmp = path.join("/tmp", `dl-${Date.now()}-${zipName}`);
  const zp = spawn("zip", ["-j", "-q", tmp, ...files], { cwd: dir });
  zp.on("error", () =>
    res.status(500).json({ error: "zip not available on server" }),
  );
  zp.on("close", (code) => {
    if (code !== 0)
      return res.status(500).json({ error: "zip failed" });
    res.download(tmp, zipName, () => fs.unlink(tmp).catch(() => {}));
  });
};

app.get("/api/batch-zip", async (req, res) => {
  const c = await getClient(req.query.client);
  const stamp = String(req.query.stamp || "");
  if (!c || !safeStamp(stamp))
    return res.status(400).json({ error: "bad request" });
  await sendZip(
    path.join(clientExportDir(c), stamp),
    `${c.id}-${stamp}.zip`,
    res,
  );
});

app.get("/api/broll/zip", async (req, res) => {
  const stamp = String(req.query.stamp || "");
  if (!safeStamp(stamp))
    return res.status(400).json({ error: "bad request" });
  await sendZip(path.join(BROLL_BASE, stamp), `broll-${stamp}.zip`, res);
});

app.get("/api/env", (_q, res) =>
  res.json({
    hosted: HOSTED,
    dailyCap: CAP_DAY,
    ipPerHour: CAP_IP_HR,
    version: VERSION,
  }),
);
app.get("/healthz", (_q, res) => res.json({ ok: true }));
app.get("/", (_q, res) => res.type("html").send(PAGE));
app.listen(PORT, () =>
  console.log(`\n  Quote Poster Studio → http://localhost:${PORT}\n`),
);

// ── UI ────────────────────────────────────────────────────────────────────
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quote Poster Studio</title><style>
:root{--gold:#E8B64A;--gold2:#ffe27a;--red:#E0564B;--bg:#0a0a0b;--panel:#121214;
--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.14);--txt:#ededee;--mut:#7f7f87}
*{box-sizing:border-box}::selection{background:var(--gold);color:#15120a}
body{margin:0;background:var(--bg);color:var(--txt);
font-family:'Montserrat',system-ui,-apple-system,Arial,sans-serif;
-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:8px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.18)}
header{position:sticky;top:0;z-index:20;padding:18px 32px;border-bottom:1px solid var(--line);
display:flex;align-items:center;gap:18px;flex-wrap:wrap;background:var(--bg)}
header b{font-size:14px;font-weight:600;letter-spacing:.26em;color:var(--mut)}
header b i{color:var(--txt);font-style:normal}header .sp{flex:1}
select,input,textarea{background:transparent;border:1px solid var(--line2);color:var(--txt);
border-radius:8px;padding:10px 13px;font:inherit;transition:border-color .15s;outline:none}
select:focus,input:focus,textarea:focus{border-color:var(--gold)}
select:hover,input:hover,textarea:hover{border-color:rgba(255,255,255,.24)}
textarea{width:100%;min-height:92px;resize:vertical}
main{max-width:1080px;margin:0 auto;padding:34px 32px 64px}
nav{display:flex;gap:26px;margin:0 0 30px;border-bottom:1px solid var(--line);flex-wrap:wrap}
nav button{background:0;border:0;color:var(--mut);padding:0 2px 14px;cursor:pointer;font:inherit;
font-size:13px;letter-spacing:.02em;position:relative;transition:color .15s}
nav button:hover{color:var(--txt)}
nav button.on{color:var(--txt);font-weight:600}
nav button.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;
background:var(--gold);border-radius:2px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
padding:26px;margin-bottom:18px}
h2{margin:0 0 18px;font-size:11px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--mut)}
label{display:block;font-size:12px;color:var(--mut);margin:14px 0 6px}
.row{display:flex;gap:16px;flex-wrap:wrap}.row>div{flex:1;min-width:160px}
button{transition:opacity .15s,border-color .15s,color .15s}
button.go{background:var(--gold);color:#15120a;border:0;font-weight:700;letter-spacing:.01em;
padding:12px 24px;border-radius:8px;cursor:pointer}
button.go:hover{opacity:.88}button.go:disabled{opacity:.4;cursor:not-allowed}
button.sec{background:0;border:1px solid var(--line2);color:var(--mut);padding:10px 16px;
border-radius:8px;cursor:pointer;font-size:13px}
button.sec:hover{border-color:var(--gold);color:var(--txt)}
pre{background:#0d0d0f;border:1px solid var(--line);border-radius:10px;padding:15px;max-height:240px;
overflow:auto;font-size:12px;line-height:1.6;white-space:pre-wrap;color:#b9b9bf}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:18px}
figure{margin:0;background:#0d0d0f;border:1px solid var(--line);border-radius:12px;overflow:hidden;
position:relative;transition:border-color .2s}
figure:hover{border-color:var(--line2)}
figure img{width:100%;display:block;aspect-ratio:4/5;object-fit:cover}
.dl{position:absolute;top:9px;right:9px;background:rgba(0,0,0,.6);color:#fff;
border:1px solid rgba(255,255,255,.2);text-decoration:none;font-size:11px;font-weight:600;
padding:6px 11px;border-radius:7px;opacity:0;transition:opacity .18s,background .15s;backdrop-filter:blur(4px)}
figure:hover .dl{opacity:1}.dl:hover{background:var(--gold);color:#15120a;border-color:var(--gold)}
figcaption{padding:12px 13px;font-size:11px;line-height:1.55;color:var(--mut);
white-space:pre-wrap;max-height:112px;overflow:auto}
.muted{color:var(--mut);font-size:13px}
.item{border:1px solid var(--line);border-radius:10px;padding:15px;margin-bottom:10px;
transition:border-color .15s}.item:hover{border-color:var(--line2)}
.pill{font-size:11px;color:var(--mut);border:1px solid var(--line2);padding:3px 10px;
border-radius:999px;margin-left:8px;font-weight:500}
.disabled{opacity:.42;pointer-events:none}
.sw{display:flex;gap:9px;align-items:center;font-size:13px;color:var(--mut)}
.bx-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:8px}
.bx-tools{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bx-tools input{min-width:240px}
.bx-row{display:flex;justify-content:space-between;align-items:center;gap:10px}
#toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%) translateY(14px);
background:#1a1a1d;border:1px solid var(--line2);color:var(--txt);padding:12px 20px;border-radius:10px;
font-size:13px;opacity:0;pointer-events:none;transition:.22s;z-index:60}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.bad{border-color:var(--red);color:#ffd9d6}
/* — typography pass — */
body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",
Roboto,system-ui,sans-serif;font-size:14px;line-height:1.55;letter-spacing:-.006em;
text-rendering:optimizeLegibility;font-feature-settings:"kern","liga","calt"}
b,strong{font-weight:600}
header b{font-size:13px;font-weight:600;letter-spacing:.24em}
header b i{font-weight:600;letter-spacing:.24em}
nav button{font-size:13px;font-weight:500;letter-spacing:.01em}
nav button.on{font-weight:600}
h2{font-size:11px;font-weight:600;letter-spacing:.165em}
label{font-size:11.5px;font-weight:500;letter-spacing:.01em}
.row>div>label:first-child{margin-top:0}
input,select,textarea{font-size:13.5px;letter-spacing:-.003em}
button.go{font-size:13.5px;font-weight:600;letter-spacing:.012em}
button.sec{font-weight:500;letter-spacing:.005em}
.pill{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
font-variant-numeric:tabular-nums}
.muted{font-size:12.5px;line-height:1.55}
figcaption{font-size:11.5px;line-height:1.62;letter-spacing:-.003em}
pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
font-size:11.5px;line-height:1.62;letter-spacing:0;color:#a8a8af}
#g_pct{font-variant-numeric:tabular-nums;letter-spacing:.02em}
#toast{font-size:13px;letter-spacing:.004em}
h1,h2,h3{font-feature-settings:"kern","liga"}
</style></head><body>
<header><b>QUOTE&nbsp;POSTER&nbsp;<i>STUDIO</i></b>
<span class="pill" title="deployed version">v${VERSION}</span><span class="sp"></span>
<div class="sw">Client <select id="client"></select></div>
<span class="pill">manual posting</span></header>
<div id="toast"></div>
<main>
<nav id="nav"></nav>
<div id="view"></div>
</main>
<script>
const $=s=>document.querySelector(s);
function toast(msg,bad){const t=$('#toast');if(!t)return;t.textContent=msg;
  t.className='show'+(bad?' bad':'');clearTimeout(t._h);
  t._h=setTimeout(()=>{t.className='';},2800);}
let CLIENT=localStorage.getItem('qps_client')||'';
let TAB='generate';
const api=(u,o)=>fetch(u,o).then(r=>r.json());
async function boot(){
  const cs=await api('/api/clients');
  $('#client').innerHTML=cs.map(c=>'<option value="'+c.id+'">'+c.label+'</option>').join('');
  if(!cs.find(c=>c.id===CLIENT))CLIENT=cs[0]?.id||'';
  $('#client').value=CLIENT;
  $('#client').onchange=e=>{CLIENT=e.target.value;localStorage.setItem('qps_client',CLIENT);render();};
  const tabs=[['generate','Generate'],['brand','Brand Kits'],['topics','Topics'],['chars','Characters'],['batches','Batches'],['broll','B-Roll']];
  $('#nav').innerHTML=tabs.map(([k,l])=>'<button data-t="'+k+'">'+l+'</button>').join('');
  document.querySelectorAll('#nav button').forEach(b=>b.onclick=()=>{TAB=b.dataset.t;render();});
  render();
}
function setNav(){document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('on',b.dataset.t===TAB));}
async function render(){
  setNav();
  if(TAB==='generate')return viewGenerate();
  if(TAB==='brand')return viewBrand();
  if(TAB==='topics')return viewTopics();
  if(TAB==='chars')return viewChars();
  if(TAB==='batches')return viewBatches();
  if(TAB==='broll')return viewBroll();
}
let es;
async function viewGenerate(){
  const briefs=await api('/api/briefs?client='+CLIENT);
  const brands=await api('/api/brand?client='+CLIENT);
  const chars=await api('/api/characters?client='+CLIENT);
  const cls=await api('/api/clients');
  const defChar=(cls.find(c=>c.id===CLIENT)||{}).characterId||'';
  const photoOf={};chars.forEach(c=>{photoOf[c.id]=(c.photos&&c.photos[0])||'';});
  const charOpts='<option value="">— none (scene only) —</option>'
   +chars.map(c=>{const n=(c.photos||[]).length;
     return '<option value="'+c.id+'"'+(c.id===defChar?' selected':'')+'>'
      +c.name+' ('+n+' photo'+(n===1?'':'s')+')</option>';}).join('');
  $('#view').innerHTML=
   '<div class="card"><h2>Generate</h2>'
   +'<div class="row"><div><label>Topic</label><input id="g_topic" placeholder="type a topic"></div>'
   +'<div style="flex:0 0 110px"><label>Count</label><input id="g_count" type="number" min="1" max="30" value="8"></div></div>'
   +'<div class="row"><div><label>Topic preset (brief)</label><select id="g_brief"><option value="">— brief default —</option>'
   +briefs.map(b=>'<option value="'+b.id+'">'+b.name+'</option>').join('')+'</select></div>'
   +'<div><label>Brand kit</label><select id="g_brand"><option value="">— preset default —</option>'
   +brands.map(b=>'<option value="'+b.id+'">'+b.name+'</option>').join('')+'</select></div></div>'
   +'<div class="row" style="align-items:flex-start"><div><label>Character</label>'
   +'<select id="g_char">'+charOpts+'</select>'
   +'<p class="muted" style="margin:8px 0 0">Who gets generated into every poster. "none" = scene only.</p></div>'
   +'<div style="flex:0 0 160px"><label>Preview</label>'
   +'<div id="g_cprev" style="width:160px;height:160px;border:1px solid var(--line);border-radius:10px;'
   +'background:#101012 center/cover no-repeat;display:flex;align-items:center;justify-content:center;'
   +'color:var(--mut);font-size:12px">none</div></div>'
   +'<div style="flex:0 0 130px"><label>Logo</label>'
   +'<div id="g_lprev" style="width:130px;height:130px;border:1px solid var(--line);border-radius:10px;'
   +'background:#000 center/contain no-repeat;display:flex;align-items:center;justify-content:center;'
   +'color:var(--mut);font-size:11px">none</div></div></div>'
   +'<p style="margin:14px 0"><button class="go" id="g_go">Generate posters</button></p>'
   +'<div id="g_prog" style="display:none;margin:4px 0 14px">'
   +'<div style="height:12px;background:#0a0a0b;border:1px solid var(--line);border-radius:999px;overflow:hidden">'
   +'<div id="g_bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--gold),#ffe27a);transition:width .45s"></div></div>'
   +'<div id="g_pct" class="muted" style="margin-top:6px;font-size:12px">0%</div></div>'
   +'<pre id="g_log" style="display:none"></pre></div>'
   +'<div class="card disabled"><h2>Auto-post to Facebook <span class="pill">coming soon</span></h2>'
   +'<p class="muted">Disabled. Posters are posted manually for now.</p></div>';
  function updPrev(){const id=$('#g_char').value,p=photoOf[id],el=$('#g_cprev');
    if(p){el.style.backgroundImage='url(/api/charphoto?p='+encodeURIComponent(p)+')';el.textContent='';}
    else{el.style.backgroundImage='';el.textContent=id?'(no photo)':'none';}}
  $('#g_char').onchange=updPrev;updPrev();
  const logoOf={};brands.forEach(b=>{logoOf[b.id]=b.logoSrc||'';});
  const defBrand=brands[0]?brands[0].id:'';
  function updLogo(){const id=$('#g_brand').value||defBrand,p=logoOf[id],el=$('#g_lprev');
    if(p){el.style.backgroundImage='url(/api/brandlogo?p='+encodeURIComponent(p)+')';el.textContent='';}
    else{el.style.backgroundImage='';el.textContent='no logo';}}
  $('#g_brand').onchange=updLogo;updLogo();
  $('#g_brief').onchange=e=>{const b=briefs.find(x=>x.id===e.target.value);if(b&&b.topics&&b.topics[0])$('#g_topic').value=b.topics[0];};
  let phase='';
  function setProg(p,err){const b=$('#g_bar'),t=$('#g_pct');if(!b)return;
    p=Math.max(0,Math.min(100,Math.round(p)));b.style.width=p+'%';
    if(err){b.style.background='linear-gradient(90deg,var(--red),#ff6b6b)';t.textContent='Failed — see log';}
    else t.textContent=p+'%'+(p>=100?' — done':'');}
  function progFrom(line){
    if(line.indexOf('Step 1')>-1){phase='q';return 6;}
    if(/✓\\s+\\d+\\s+.*quotes in/.test(line))return 15;
    if(line.indexOf('Step 2')>-1){phase='bg';return 16;}
    if(line.indexOf('Step 3')>-1){phase='render';return 62;}
    const m=line.match(/\\[(\\d+)\\/(\\d+)\\]/);
    if(m){const i=+m[1],n=+m[2]||1;
      if(phase==='bg'||/\\bbg-/.test(line))return 16+44*(i/n);
      if(phase==='render')return 62+35*(i/n);}
    if(line.indexOf('✓ Done')>-1)return 100;
    return -1;}
  $('#g_go').onclick=async()=>{
    const body={client:CLIENT,topic:$('#g_topic').value.trim(),count:+$('#g_count').value||8,
      briefId:$('#g_brief').value,brandPresetId:$('#g_brand').value,characterId:$('#g_char').value};
    if(!body.topic)return toast('Enter a topic first',true);
    $('#g_go').disabled=true;phase='';
    $('#g_log').style.display='block';$('#g_log').textContent='';
    $('#g_prog').style.display='block';
    $('#g_bar').style.background='linear-gradient(90deg,var(--gold),#ffe27a)';setProg(2,false);
    es&&es.close();es=new EventSource('/api/log');
    es.onmessage=ev=>{const line=JSON.parse(ev.data),L=$('#g_log');
      L.textContent+=line+'\\n';L.scrollTop=L.scrollHeight;
      if(line.indexOf('✗ Exited')>-1){setProg(100,true);es.close();$('#g_go').disabled=false;return;}
      const p=progFrom(line);if(p>=0)setProg(p,false);
      if(line.indexOf('✓ Done')>-1){es.close();$('#g_go').disabled=false;
        toast('Batch complete \\u2713');setTimeout(()=>{TAB='batches';render();},850);}};
    const r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok){toast((await r.json()).error||'Failed to start',true);$('#g_go').disabled=false;$('#g_prog').style.display='none';}
  };
}
async function viewBrand(){
  const b=await api('/api/brand?client='+CLIENT);
  $('#view').innerHTML='<div class="card"><h2>Brand Kits — '+CLIENT+'</h2>'
   +b.map(p=>'<div class="item" style="display:flex;gap:12px;align-items:center">'
   +(p.logoSrc?'<img src="/api/brandlogo?p='+encodeURIComponent(p.logoSrc)+'" style="width:58px;height:58px;object-fit:contain;background:#000;border-radius:8px;border:1px solid var(--line)">':'<div style="width:58px;height:58px;border:1px dashed var(--line);border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:10px">no logo</div>')
   +'<div><b>'+p.name+'</b> <span class="pill">'+p.id+'</span><br>'
   +'<span class="muted">gold '+p.brandAccent+' · red '+p.brandPrimary+' · CTA "'+(p.ctaComment||'')+'" / '+(p.ctaTail||'')+'</span></div></div>').join('')
   +'<h2 style="margin-top:18px">Create / update a brand kit</h2>'
   +'<div class="row"><div><label>ID</label><input id="b_id" placeholder="preset_'+CLIENT+'_2"></div>'
   +'<div><label>Name</label><input id="b_name"></div></div>'
   +'<div class="row"><div><label>Gold (accent)</label><input id="b_gold" value="#F5C13B"></div>'
   +'<div><label>Gold deep</label><input id="b_goldd" value="#C7902A"></div>'
   +'<div><label>Red</label><input id="b_red" value="#E11522"></div></div>'
   +'<div class="row"><div><label>CTA comment word</label><input id="b_cta" value="MENTOR"></div>'
   +'<div><label>CTA tail</label><input id="b_tail" value="LEARN MORE"></div></div>'
   +'<label>Logo (optional)</label><input id="b_logo" type="file" accept="image/*">'
   +'<p style="margin-top:14px"><button class="go" id="b_save">Save brand kit</button></p></div>';
  $('#b_save').onclick=async()=>{
    let logoSrc='';const f=$('#b_logo').files[0];
    if(f){const fd=new FormData();fd.append('logo',f);
      const u=await api('/api/brand/logo',{method:'POST',body:fd});logoSrc=u.path||'';}
    const p={id:$('#b_id').value.trim(),client:CLIENT,name:$('#b_name').value.trim()||$('#b_id').value,
      brandAccent:$('#b_gold').value,brandAccentDeep:$('#b_goldd').value,brandPrimary:$('#b_red').value,
      brandDeep:'#0A0A0A',ctaComment:$('#b_cta').value.toUpperCase(),ctaTail:$('#b_tail').value.toUpperCase()};
    if(logoSrc)p.logoSrc=logoSrc;
    if(!p.id)return toast('Brand kit ID required',true);
    await fetch('/api/brand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
    toast('Brand kit saved');viewBrand();
  };
}
async function viewTopics(){
  const b=await api('/api/briefs?client='+CLIENT);
  $('#view').innerHTML='<div class="card"><h2>Topic Presets — '+CLIENT+'</h2>'
   +b.map(x=>'<div class="item"><b>'+x.name+'</b> <span class="pill">'+x.id+'</span><br>'
   +'<span class="muted">'+(x.topics||[]).join(' · ')+'</span></div>').join('')
   +'<h2 style="margin-top:18px">Create / update a topic preset</h2>'
   +'<div class="row"><div><label>ID</label><input id="t_id" placeholder="brief_'+CLIENT+'_2"></div>'
   +'<div><label>Name</label><input id="t_name"></div></div>'
   +'<label>Topics (one per line)</label><textarea id="t_topics"></textarea>'
   +'<label>Voice notes</label><textarea id="t_voice"></textarea>'
   +'<p style="margin-top:14px"><button class="go" id="t_save">Save topic preset</button></p></div>';
  $('#t_save').onclick=async()=>{
    const body={id:$('#t_id').value.trim(),client:CLIENT,name:$('#t_name').value.trim()||$('#t_id').value,
      topics:$('#t_topics').value,voiceNotes:$('#t_voice').value,bannedPhrases:[]};
    if(!body.id)return toast('Topic preset ID required',true);
    await fetch('/api/briefs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    toast('Topic preset saved');viewTopics();
  };
}
async function viewChars(){
  const c=await api('/api/characters?client='+CLIENT);
  $('#view').innerHTML='<div class="card"><h2>Characters — '+CLIENT+'</h2>'
   +(c.length?c.map(x=>'<div class="item"><b>'+x.name+'</b> <span class="pill">'+x.id+'</span> '
   +'<span class="muted">'+(x.photos||[]).length+' photo(s)'+(x.enabled?'':' · disabled')+'</span></div>').join('')
   :'<p class="muted">No character yet. Optional — Tranzzie can run scene-only.</p>')
   +'<h2 style="margin-top:18px">Create / update a character</h2>'
   +'<div class="row"><div><label>ID</label><input id="c_id" placeholder="char_'+CLIENT+'"></div>'
   +'<div><label>Name</label><input id="c_name"></div></div>'
   +'<p style="margin-top:12px"><button class="go" id="c_save">Save character</button></p>'
   +'<h2 style="margin-top:18px">Add a photo to a character</h2>'
   +'<div class="row"><div><label>Character ID</label><input id="c_pid" placeholder="char_'+CLIENT+'"></div>'
   +'<div><label>Photo</label><input id="c_file" type="file" accept="image/*"></div></div>'
   +'<p style="margin-top:12px"><button class="sec" id="c_up">Upload photo</button></p></div>';
  $('#c_save').onclick=async()=>{
    const body={id:$('#c_id').value.trim(),client:CLIENT,name:$('#c_name').value.trim()||$('#c_id').value,enabled:true};
    if(!body.id)return toast('Character ID required',true);
    await fetch('/api/characters',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    toast('Character saved');viewChars();
  };
  $('#c_up').onclick=async()=>{
    const f=$('#c_file').files[0],id=$('#c_pid').value.trim();
    if(!f||!id)return toast('Pick a character ID and a file',true);
    const fd=new FormData();fd.append('photo',f);
    await fetch('/api/characters/photo?client='+CLIENT+'&charId='+encodeURIComponent(id),{method:'POST',body:fd});
    toast('Photo uploaded');viewChars();
  };
}
async function viewBatches(){
  const ALL=await api('/api/batches?client='+CLIENT);
  $('#view').innerHTML=
   '<div class="bx-head"><h2 style="margin:0">Batches <span class="pill">'+CLIENT+'</span></h2>'
   +'<div class="bx-tools"><input id="bx_q" placeholder="Filter by date or caption…">'
   +'<button class="sec" id="bx_open">Open folder</button>'
   +'<button class="sec" id="bx_ref">Refresh</button></div></div>'
   +'<div id="bx_meta" class="muted" style="margin:0 0 14px"></div><div id="bx_list"></div>';
  const esc=s=>(s||'').replace(/[<>]/g,'');
  function paint(){
    const q=($('#bx_q').value||'').trim().toLowerCase();
    let nb=0,np=0;
    const html=ALL.map(B=>{
      const caps=B.captions.split(/^#\\d+\\s*$/m).map(s=>s.trim()).filter(Boolean);
      const stampHit=B.stamp.toLowerCase().indexOf(q)>-1;
      const idx=B.files.map((_f,i)=>i).filter(i=>!q||stampHit||(caps[i]||'').toLowerCase().indexOf(q)>-1);
      if(!idx.length)return '';
      nb++;np+=idx.length;
      return '<div class="card"><div class="bx-row"><b>'+B.stamp+'</b>'
       +'<span><span class="pill">'+idx.length+(idx.length!==B.count?(' / '+B.count):'')+' posters</span> '
       +'<a class="sec" style="text-decoration:none" href="/api/batch-zip?client='+CLIENT+'&stamp='+encodeURIComponent(B.stamp)+'">⬇ All (.zip)</a></span></div>'
       +'<div class="grid" style="margin-top:14px">'+idx.map(i=>{
         const f=B.files[i],u='/posters/'+CLIENT+'/'+encodeURIComponent(B.stamp)+'/'+encodeURIComponent(f);
         return '<figure><img loading="lazy" src="'+u+'"><a class="dl" href="'+u+'?dl=1" download>↓ PNG</a>'
          +'<figcaption>'+(esc(caps[i])||'—')+'</figcaption></figure>';}).join('')
       +'</div></div>';}).join('');
    $('#bx_list').innerHTML=ALL.length?(html||'<p class="muted">No posters match “'+esc(q)+'”.</p>')
      :'<p class="muted">No batches yet. Generate some on the Generate tab.</p>';
    $('#bx_meta').textContent=ALL.length
      ?(nb+' batch'+(nb===1?'':'es')+' · '+np+' poster'+(np===1?'':'s')+(q?' (filtered)':''))
      :'';
  }
  $('#bx_q').oninput=paint;
  $('#bx_ref').onclick=viewBatches;
  $('#bx_open').onclick=()=>{fetch('/api/reveal',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({client:CLIENT})});toast('Opening export folder…');};
  paint();
}
async function viewBroll(){
  const chars=await api('/api/characters');
  const ENV=await api('/api/env').catch(()=>({}));
  let src='script';
  const charOpts='<option value="none">— none (scenes only) —</option>'
   +chars.map(c=>'<option value="'+c.id+'">'+c.name+' ('+c.client+', '
    +((c.photos||[]).length)+' photo'+(((c.photos||[]).length)===1?'':'s')+')</option>').join('');
  $('#view').innerHTML=
   '<div class="card"><h2>B-Roll Maker</h2>'
   +'<div class="muted" style="margin:-6px 0 16px">Paste a script or upload a video — the AI finds the beats and writes paired '
   +'Nano Banana (first frame) + Veo 3.1 prompts, then renders every first frame. You pick the keepers. '
   +'Veo auto-animation is wired but OFF for now.</div>'
   +'<div class="bx-tools" style="margin-bottom:14px">'
   +'<button class="sec" id="br_t_s">Script</button><button class="sec" id="br_t_v">Video</button></div>'
   +'<div id="br_src_s"><label>Script</label>'
   +'<textarea id="br_script" placeholder="Paste the script (Taglish ok)…" style="min-height:140px"></textarea></div>'
   +'<div id="br_src_v" style="display:none"><label>Video file</label>'
   +'<input id="br_video" type="file" accept="video/*"><div class="muted" style="margin-top:6px">'
   +'Transcribed with whisperx (large-v3, tl) — short clips recommended.</div></div>'
   +'<div class="row" style="margin-top:6px">'
   +'<div><label>Aspect</label><select id="br_aspect"><option value="9:16">9:16 vertical</option>'
   +'<option value="16:9">16:9 landscape</option></select></div>'
   +'<div style="flex:0 0 120px"><label>Shots</label><input id="br_count" type="number" min="1" max="40" value="8"></div>'
   +'<div><label>Character (optional)</label><select id="br_char">'+charOpts+'</select></div></div>'
   +'<p style="margin:16px 0"><button class="go" id="br_go">Generate b-rolls</button></p>'
   +'<pre id="br_log" style="display:none"></pre></div>'
   +'<div class="bx-head"><h2 style="margin:0">Sets</h2><div class="bx-tools">'
   +'<button class="sec" id="br_ref">Refresh</button></div></div><div id="br_sets"></div>';
  const showSrc=()=>{$('#br_src_s').style.display=src==='script'?'':'none';
    $('#br_src_v').style.display=src==='video'?'':'none';
    $('#br_t_s').style.borderColor=src==='script'?'var(--gold)':'';
    $('#br_t_v').style.borderColor=src==='video'?'var(--gold)':'';};
  $('#br_t_s').onclick=()=>{src='script';showSrc();};
  $('#br_t_v').onclick=()=>{src='video';showSrc();};
  if(ENV.hosted){$('#br_t_v').style.display='none';$('#br_src_v').style.display='none';
    $('#br_t_s').style.display='none';
    $('#br_src_s').insertAdjacentHTML('afterbegin',
      '<div class="muted" style="margin-bottom:8px">Hosted build — script input only (video B-roll runs locally).</div>');}
  showSrc();
  let es;
  $('#br_go').onclick=async()=>{
    const fd=new FormData();
    fd.append('aspect',$('#br_aspect').value);
    fd.append('count',$('#br_count').value||'8');
    fd.append('characterId',$('#br_char').value);
    if(src==='video'){const f=$('#br_video').files[0];
      if(!f)return alert('Choose a video file');fd.append('video',f);}
    else{const t=$('#br_script').value.trim();
      if(t.length<10)return alert('Paste a script (10+ chars)');fd.append('script',t);}
    $('#br_go').disabled=true;$('#br_log').style.display='block';$('#br_log').textContent='';
    es&&es.close();es=new EventSource('/api/log');
    es.onmessage=ev=>{const line=JSON.parse(ev.data),L=$('#br_log');
      L.textContent+=line+'\\n';L.scrollTop=L.scrollHeight;
      if(line.indexOf('✓ Done')>-1||line.indexOf('✗ Exited')>-1){es.close();
        $('#br_go').disabled=false;loadSets();}};
    const r=await fetch('/api/broll/generate',{method:'POST',body:fd});
    if(!r.ok){alert((await r.json()).error||'Failed');$('#br_go').disabled=false;}
  };
  $('#br_ref').onclick=loadSets;
  async function loadSets(){
    const sets=await api('/api/broll/sets');
    if(!sets.length){$('#br_sets').innerHTML='<p class="muted">No b-roll sets yet.</p>';return;}
    $('#br_sets').innerHTML=sets.map(S=>{
      const m=S.meta||{};
      const shots=S.shots.map(sh=>{
        const a='/broll-asset/'+encodeURIComponent(S.stamp)+'/shot-'+String(sh.n).padStart(2,'0')+'.png';
        const img=sh.hasFrame
          ?'<figure><img loading="lazy" src="'+a+'"><a class="dl" href="'+a+'?dl=1" download>↓ PNG</a></figure>'
          :'<figure><div class="frame ph" style="aspect-ratio:4/5;display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:11px">no frame</div></figure>';
        return '<div style="margin-bottom:14px">'+img
         +'<div style="margin-top:8px;font-size:13px;font-weight:600">'+sh.n+'. '+(sh.title||'').replace(/[<>]/g,'')
         +(sh.usesCharacter?' <span class="charbadge" style="background:#1c1f26;color:#b48bff;font-size:9px;padding:2px 7px;border-radius:4px;text-transform:uppercase">char</span>':'')+'</div>'
         +(sh.timecode?'<div class="muted" style="font-size:11px">'+sh.timecode+'</div>':'')
         +'<div class="muted" style="font-size:11px;margin:4px 0 6px">'+(sh.beat||'').replace(/[<>]/g,'')+'</div>'
         +'<label style="display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--txt);margin:0 0 6px">'
         +'<input type="checkbox" class="br_pick" data-n="'+sh.n+'"'+(sh.picked?' checked':'')+' style="width:auto">pick</label><br>'
         +'<button class="sec br_cp" data-t="img" data-s="'+S.stamp+'" data-n="'+sh.n+'" style="font-size:11px;padding:6px 10px">Copy image prompt</button> '
         +'<button class="sec br_cp" data-t="vid" data-s="'+S.stamp+'" data-n="'+sh.n+'" style="font-size:11px;padding:6px 10px">Copy Veo prompt</button>'
         +'</div>';
      }).join('');
      return '<div class="card"><div class="bx-row"><b>'+S.stamp+'</b>'
       +'<span><span class="pill">'+S.shots.length+' shots</span>'
       +'<span class="pill">'+(m.aspect||'')+'</span>'
       +'<span class="pill">'+(m.charMode==='reference-image'?'character':'no character')+'</span>'
       +(S.hasHtml?' <a class="sec" style="text-decoration:none" target="_blank" href="/broll-asset/'+encodeURIComponent(S.stamp)+'/broll.html">Open HTML</a>':'')
       +' <a class="sec" style="text-decoration:none" href="/api/broll/zip?stamp='+encodeURIComponent(S.stamp)+'">⬇ All (.zip)</a>'
       +' <button class="go br_save" data-s="'+S.stamp+'" style="padding:8px 14px;font-size:12px">Save picks</button></span></div>'
       +'<div class="grid" style="margin-top:14px;grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">'+shots+'</div></div>';
    }).join('');
    document.querySelectorAll('.br_cp').forEach(b=>b.onclick=()=>{
      const S=sets.find(x=>x.stamp===b.dataset.s),sh=S&&S.shots.find(y=>y.n==b.dataset.n);
      if(!sh)return;const txt=b.dataset.t==='img'?sh.imagePrompt:sh.videoPrompt;
      navigator.clipboard.writeText(txt||'').then(()=>{const o=b.textContent;
        b.textContent='Copied';setTimeout(()=>b.textContent=o,1200);});});
    document.querySelectorAll('.br_save').forEach(b=>b.onclick=async()=>{
      const card=b.closest('.card');
      const picks=[...card.querySelectorAll('.br_pick:checked')].map(c=>+c.dataset.n);
      const r=await fetch('/api/broll/pick',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({stamp:b.dataset.s,picks})});
      if(r.ok)toast(picks.length+' shot(s) picked & saved');});
  }
  loadSets();
}
boot();
</script></body></html>`;
