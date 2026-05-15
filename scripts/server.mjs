#!/usr/bin/env node
// Unified dashboard backend.
//
// Endpoints:
//   GET  /api/brand                       List brand presets
//   POST /api/brand                       Save (create/update) preset
//   POST /api/brand/logo                  Multipart logo upload
//   GET  /api/briefs                      List briefs
//   POST /api/briefs                      Save brief
//   DELETE /api/briefs/:id                Delete brief
//   GET  /api/characters                  List characters
//   POST /api/characters                  Save character
//   DELETE /api/characters/:id            Delete character
//   POST /api/characters/photo            Multipart photo upload (charId + photo)
//   GET  /api/batches                     List batches (summaries)
//   GET  /api/batches/:stamp              Get one batch with cards
//   POST /api/batches/:stamp/cards/:idx/approval   Set approval status
//   POST /api/generate                    Run the pipeline (streams stdout)
//   GET  /api/cards/:stamp/:file          Serve a card image from out/cards/
//   GET  /api/static/:filename            Serve from public/
//   GET  /uploads/*                       Serve from public/ (logos + character photos)
//   GET  /console                         Legacy simple console HTML
//   GET  /*                               Dashboard SPA (Vite build)
//
// Auth: optional DASHBOARD_PASSWORD env var triggers HTTP Basic Auth.
//
// Usage:
//   GOOGLE_CLOUD_PROJECT=... PORT=8787 node scripts/server.mjs

import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import { existsSync, createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

// ── GCP service account auth shim ──────────────────────────────────────────
// On hosted environments (Railway, Fly, Render…) we can't ship a JSON file
// on disk. Convention: paste the full SA JSON into an env var named
// GOOGLE_APPLICATION_CREDENTIALS_JSON. At startup we drop it on /tmp and
// point GOOGLE_APPLICATION_CREDENTIALS at the file so any Google SDK
// (including @google/genai vertexai mode) picks it up via ADC.
if (
  process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON &&
  !process.env.GOOGLE_APPLICATION_CREDENTIALS
) {
  const tmpPath = "/tmp/gcp-sa-key.json";
  writeFileSync(tmpPath, process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  console.log(
    `[auth] Wrote SA key from GOOGLE_APPLICATION_CREDENTIALS_JSON → ${tmpPath}`,
  );
}
import {
  validateToken as fbValidateToken,
  validatePage as fbValidatePage,
  postPhotoToPage as fbPostPhoto,
  nextSlots as fbNextSlots,
} from "./fb-poster.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const PORT = Number(process.env.PORT) || 8787;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const DIST_DIR = path.join(projectRoot, "dashboard", "dist");
const PUBLIC_DIR = path.join(projectRoot, "public");
const CONFIG_DIR = path.join(projectRoot, "config");
const OUT_DIR = path.join(projectRoot, "out");

await fs.mkdir(CONFIG_DIR, { recursive: true });
await fs.mkdir(path.join(CONFIG_DIR, "batches"), { recursive: true });
await fs.mkdir(path.join(PUBLIC_DIR, "characters"), { recursive: true });

// --- Config persistence helpers --------------------------------------------

const cfgPath = (file) => path.join(CONFIG_DIR, file);
const readJson = async (file, fallback) => {
  try {
    const data = await fs.readFile(cfgPath(file), "utf-8");
    return JSON.parse(data);
  } catch {
    return fallback;
  }
};
const writeJson = async (file, data) =>
  fs.writeFile(cfgPath(file), JSON.stringify(data, null, 2));

// Seed defaults if first run
const seedDefaults = async () => {
  const brand = await readJson("brand-presets.json", null);
  if (!brand) {
    await writeJson("brand-presets.json", [
      {
        id: "preset_default",
        name: "John Calub Training",
        logoSrc: "yes-to-success-logo.png",
        brandPrimary: "#C8001E",
        brandDeep: "#3A0008",
        brandAccent: "#FFE17A",
        brandAccentDeep: "#C9952B",
        url: "JOHNCALUBTRAINING.COM",
        signoff: "— John Calub",
        subtitle: "Philippines' #1 Success Coach",
      },
    ]);
  }
  const briefs = await readJson("briefs.json", null);
  if (!briefs) {
    await writeJson("briefs.json", [
      {
        id: "brief_default",
        name: "Default — 3 Pillars",
        topics: ["trading", "yes-to-success", "biohacking"],
        voiceNotes:
          "Empathetic tone. Validate the audience's effort before reframing. Mix Taglish naturally.",
        bannedPhrases: [
          "walang kwentang trabaho",
          "tamad ka",
          "guaranteed income",
          "this supplement cures",
        ],
        activeCampaigns: "",
      },
    ]);
  }
  const chars = await readJson("characters.json", null);
  if (!chars) {
    await writeJson("characters.json", []);
  }
  const posting = await readJson("posting.json", null);
  if (!posting) {
    await writeJson("posting.json", {
      pageId: "",
      token: "",
      pageName: "",
      timezone: "Asia/Manila",
      peakHours: ["07:30", "12:30", "20:00"],
      dailyCap: 3,
    });
  }
};
await seedDefaults();

// --- Auth middleware -------------------------------------------------------

const auth = (req, res, next) => {
  if (!PASSWORD) return next();
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Yes to Success Dashboard"');
    return res.status(401).send("Auth required");
  }
  const [, b64] = header.split(" ");
  const decoded = Buffer.from(b64, "base64").toString("utf-8");
  const sep = decoded.indexOf(":");
  const pass = sep === -1 ? decoded : decoded.slice(sep + 1);
  if (pass !== PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Yes to Success Dashboard"');
    return res.status(401).send("Wrong password");
  }
  next();
};

// --- App setup -------------------------------------------------------------

const app = express();

// CORS — allow the deployed frontend origin to call this API.
// Set CORS_ORIGIN to your Vercel URL, or "*" for fully open (less safe).
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()),
    credentials: true,
  }),
);

app.use(express.json({ limit: "10mb" }));
app.use(auth);

// Health endpoint for Railway's readiness probe.
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- Multer for uploads ----------------------------------------------------

const logoStorage = multer.diskStorage({
  destination: PUBLIC_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    const stamp = Date.now();
    cb(null, `logo-${stamp}${ext}`);
  },
});
const logoUpload = multer({ storage: logoStorage });

const photoStorage = multer.diskStorage({
  destination: path.join(PUBLIC_DIR, "characters"),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    const rand = randomBytes(4).toString("hex");
    const stamp = Date.now();
    cb(null, `char-${stamp}-${rand}${ext}`);
  },
});
const photoUpload = multer({ storage: photoStorage });

// --- API: Brand ------------------------------------------------------------

app.get("/api/brand", async (_req, res) => {
  res.json(await readJson("brand-presets.json", []));
});
app.post("/api/brand", async (req, res) => {
  const preset = req.body;
  if (!preset?.id) return res.status(400).json({ error: "Missing id" });
  const presets = await readJson("brand-presets.json", []);
  const i = presets.findIndex((p) => p.id === preset.id);
  if (i === -1) presets.push(preset);
  else presets[i] = preset;
  await writeJson("brand-presets.json", presets);
  res.json(preset);
});
app.post("/api/brand/logo", logoUpload.single("logo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const presetId = req.body.presetId;
  const logoSrc = req.file.filename;
  if (presetId) {
    const presets = await readJson("brand-presets.json", []);
    const i = presets.findIndex((p) => p.id === presetId);
    if (i !== -1) {
      presets[i] = { ...presets[i], logoSrc };
      await writeJson("brand-presets.json", presets);
    }
  }
  res.json({ logoSrc });
});

// --- API: Briefs -----------------------------------------------------------

app.get("/api/briefs", async (_req, res) => {
  res.json(await readJson("briefs.json", []));
});
app.post("/api/briefs", async (req, res) => {
  const brief = req.body;
  if (!brief?.id) return res.status(400).json({ error: "Missing id" });
  const briefs = await readJson("briefs.json", []);
  const i = briefs.findIndex((b) => b.id === brief.id);
  if (i === -1) briefs.push(brief);
  else briefs[i] = brief;
  await writeJson("briefs.json", briefs);
  res.json(brief);
});
app.delete("/api/briefs/:id", async (req, res) => {
  const briefs = await readJson("briefs.json", []);
  await writeJson(
    "briefs.json",
    briefs.filter((b) => b.id !== req.params.id),
  );
  res.json({ ok: true });
});

// --- API: Characters -------------------------------------------------------

app.get("/api/characters", async (_req, res) => {
  res.json(await readJson("characters.json", []));
});
app.post("/api/characters", async (req, res) => {
  const c = req.body;
  if (!c?.id) return res.status(400).json({ error: "Missing id" });
  const chars = await readJson("characters.json", []);
  const i = chars.findIndex((x) => x.id === c.id);
  if (i === -1) chars.push(c);
  else chars[i] = c;
  await writeJson("characters.json", chars);
  res.json(c);
});
app.delete("/api/characters/:id", async (req, res) => {
  const chars = await readJson("characters.json", []);
  await writeJson(
    "characters.json",
    chars.filter((c) => c.id !== req.params.id),
  );
  res.json({ ok: true });
});
app.post(
  "/api/characters/photo",
  photoUpload.single("photo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const charId = req.body.charId;
    const photoRel = path.posix.join("characters", req.file.filename);
    if (charId) {
      const chars = await readJson("characters.json", []);
      const i = chars.findIndex((c) => c.id === charId);
      if (i !== -1) {
        chars[i] = { ...chars[i], photos: [...(chars[i].photos || []), photoRel] };
        await writeJson("characters.json", chars);
      }
    }
    res.json({ path: photoRel });
  },
);

// --- API: Batches ----------------------------------------------------------

const findQuotesForBatch = async (stamp) => {
  const files = await fs.readdir(OUT_DIR);
  const jsons = files
    .filter((f) => f.startsWith("quotes-") && f.endsWith(".json"))
    .sort();
  for (let i = jsons.length - 1; i >= 0; i--) {
    const quotesStem = jsons[i].slice(0, -5);
    const possibleStamp = quotesStem.replace("quotes-", "");
    if (possibleStamp <= stamp) return jsons[i];
  }
  return jsons[jsons.length - 1];
};

const loadBatchApproval = async (stamp) =>
  readJson(path.join("batches", `${stamp}.json`), {});

const saveBatchApproval = async (stamp, data) =>
  writeJson(path.join("batches", `${stamp}.json`), data);

app.get("/api/batches", async (_req, res) => {
  const cardsDir = path.join(OUT_DIR, "cards");
  if (!existsSync(cardsDir)) return res.json([]);
  const stamps = (await fs.readdir(cardsDir))
    .filter((n) => !n.startsWith("."))
    .sort()
    .reverse();
  const summaries = await Promise.all(
    stamps.map(async (stamp) => {
      const files = await fs.readdir(path.join(cardsDir, stamp));
      const cards = files.filter(
        (f) => f.endsWith(".png") || f.endsWith(".mp4"),
      );
      return { stamp, count: cards.length, cards: [] };
    }),
  );
  res.json(summaries);
});

app.get("/api/batches/:stamp", async (req, res) => {
  const { stamp } = req.params;
  const batchDir = path.join(OUT_DIR, "cards", stamp);
  if (!existsSync(batchDir)) {
    return res.status(404).json({ error: "Batch not found" });
  }
  const cardFiles = (await fs.readdir(batchDir))
    .filter((f) => f.endsWith(".png") || f.endsWith(".mp4"))
    .sort();
  const quotesFile = await findQuotesForBatch(stamp);
  let quotes = [];
  if (quotesFile) {
    try {
      quotes = JSON.parse(
        await fs.readFile(path.join(OUT_DIR, quotesFile), "utf-8"),
      );
    } catch {
      // ignore
    }
  }
  const approval = await loadBatchApproval(stamp);
  const cards = cardFiles.map((file, idx) => {
    const q = quotes[idx] || {};
    const a = approval[idx] || {};
    return {
      index: idx,
      file,
      quote: q.quote || "",
      caption: q.caption || "",
      theme: q.theme || "",
      variant: q.variant || "classic",
      aspectRatio: q.aspectRatio || "4:5",
      bgPrompt: q.bgPrompt,
      keyword: q.keyword,
      approved: a.status === "approved",
      rejected: a.status === "rejected",
      scheduled: a.status === "scheduled",
      posted: a.status === "posted",
      failed: a.status === "failed",
      scheduledAt: a.scheduledAt,
      postedAt: a.postedAt,
      fbPostId: a.fbPostId,
      fbUrl: a.fbUrl,
    };
  });
  res.json({ stamp, count: cards.length, cards });
});

app.post("/api/batches/:stamp/cards/:idx/approval", async (req, res) => {
  const { stamp, idx } = req.params;
  const { status } = req.body;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Bad status" });
  }
  const approval = await loadBatchApproval(stamp);
  if (status === "pending") delete approval[idx];
  else approval[idx] = { status, at: new Date().toISOString() };
  await saveBatchApproval(stamp, approval);
  res.json({ ok: true });
});

// --- API: Posting config + queue ------------------------------------------

app.get("/api/posting/config", async (_req, res) => {
  const cfg = await readJson("posting.json", {});
  // Don't ship the raw token to the client — just whether it's set.
  res.json({
    ...cfg,
    hasToken: !!cfg.token,
    token: cfg.token ? `${cfg.token.slice(0, 8)}…${cfg.token.slice(-4)}` : "",
  });
});

app.post("/api/posting/config", async (req, res) => {
  const body = req.body || {};
  const existing = await readJson("posting.json", {});
  // Only overwrite the token if a new one is provided (non-empty string).
  const token =
    typeof body.token === "string" && body.token.length > 50
      ? body.token
      : existing.token;
  const merged = {
    pageId: body.pageId ?? existing.pageId ?? "",
    token,
    pageName: existing.pageName || "",
    timezone: body.timezone ?? existing.timezone ?? "Asia/Manila",
    peakHours: Array.isArray(body.peakHours)
      ? body.peakHours
      : existing.peakHours || ["07:30", "12:30", "20:00"],
    dailyCap: Number.isFinite(body.dailyCap)
      ? body.dailyCap
      : existing.dailyCap || 3,
  };
  // Validate against FB if we have token + page
  if (merged.token && merged.pageId) {
    try {
      const page = await fbValidatePage(merged.pageId, merged.token);
      merged.pageName = page.name;
      merged.pageFans = page.fan_count;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  await writeJson("posting.json", merged);
  res.json({
    ...merged,
    hasToken: !!merged.token,
    token: merged.token
      ? `${merged.token.slice(0, 8)}…${merged.token.slice(-4)}`
      : "",
  });
});

// All approved cards across all batches that don't yet have a schedule/post.
app.get("/api/queue", async (_req, res) => {
  const cardsDir = path.join(OUT_DIR, "cards");
  if (!existsSync(cardsDir)) return res.json([]);
  const stamps = (await fs.readdir(cardsDir))
    .filter((n) => !n.startsWith("."))
    .sort();
  const approved = [];
  for (const stamp of stamps) {
    const batchPath = path.join(cardsDir, stamp);
    const stat = await fs.stat(batchPath);
    if (!stat.isDirectory()) continue;
    const approval = await loadBatchApproval(stamp);
    const cardFiles = (await fs.readdir(batchPath))
      .filter((f) => f.endsWith(".png") || f.endsWith(".mp4"))
      .sort();
    const quotesFile = await findQuotesForBatch(stamp);
    let quotes = [];
    if (quotesFile) {
      try {
        quotes = JSON.parse(
          await fs.readFile(path.join(OUT_DIR, quotesFile), "utf-8"),
        );
      } catch {
        /* ignore */
      }
    }
    cardFiles.forEach((file, idx) => {
      const entry = approval[idx];
      if (entry?.status === "approved") {
        const q = quotes[idx] || {};
        approved.push({
          stamp,
          index: idx,
          file,
          quote: q.quote || "",
          caption: q.caption || "",
          variant: q.variant || "classic",
          aspectRatio: q.aspectRatio || "4:5",
        });
      }
    });
  }
  res.json(approved);
});

// All scheduled / posted / failed cards.
app.get("/api/queue/history", async (_req, res) => {
  const cardsDir = path.join(OUT_DIR, "cards");
  if (!existsSync(cardsDir)) return res.json([]);
  const stamps = (await fs.readdir(cardsDir))
    .filter((n) => !n.startsWith("."))
    .sort();
  const history = [];
  for (const stamp of stamps) {
    const batchPath = path.join(cardsDir, stamp);
    const stat = await fs.stat(batchPath);
    if (!stat.isDirectory()) continue;
    const approval = await loadBatchApproval(stamp);
    const cardFiles = (await fs.readdir(batchPath))
      .filter((f) => f.endsWith(".png") || f.endsWith(".mp4"))
      .sort();
    const quotesFile = await findQuotesForBatch(stamp);
    let quotes = [];
    if (quotesFile) {
      try {
        quotes = JSON.parse(
          await fs.readFile(path.join(OUT_DIR, quotesFile), "utf-8"),
        );
      } catch {
        /* ignore */
      }
    }
    cardFiles.forEach((file, idx) => {
      const entry = approval[idx];
      if (
        entry?.status === "scheduled" ||
        entry?.status === "posted" ||
        entry?.status === "failed"
      ) {
        const q = quotes[idx] || {};
        history.push({
          stamp,
          index: idx,
          file,
          quote: q.quote || "",
          caption: q.caption || "",
          variant: q.variant || "classic",
          aspectRatio: q.aspectRatio || "4:5",
          status: entry.status,
          scheduledAt: entry.scheduledAt,
          postedAt: entry.postedAt,
          fbPostId: entry.fbPostId,
          fbUrl: entry.fbUrl,
          error: entry.error,
        });
      }
    });
  }
  // Sort by scheduledAt desc (most recent first)
  history.sort(
    (a, b) =>
      (b.scheduledAt || b.postedAt || "").localeCompare(
        a.scheduledAt || a.postedAt || "",
      ),
  );
  res.json(history);
});

// Schedule all currently-approved cards across the next available peak slots.
app.post("/api/queue/schedule-all", async (req, res) => {
  const cfg = await readJson("posting.json", {});
  if (!cfg.token || !cfg.pageId) {
    return res.status(400).json({
      error: "FB Page not connected. Configure in Posting Settings first.",
    });
  }
  const { startAt } = req.body || {};
  const startTime = startAt ? new Date(startAt) : new Date();

  // Collect approved cards
  const cardsDir = path.join(OUT_DIR, "cards");
  const stamps = (await fs.readdir(cardsDir))
    .filter((n) => !n.startsWith("."))
    .sort();
  const queue = [];
  for (const stamp of stamps) {
    const approval = await loadBatchApproval(stamp);
    const cardFiles = (await fs.readdir(path.join(cardsDir, stamp)))
      .filter((f) => f.endsWith(".png"))
      .sort();
    const quotesFile = await findQuotesForBatch(stamp);
    let quotes = [];
    if (quotesFile) {
      try {
        quotes = JSON.parse(
          await fs.readFile(path.join(OUT_DIR, quotesFile), "utf-8"),
        );
      } catch {
        /* ignore */
      }
    }
    cardFiles.forEach((file, idx) => {
      if (approval[idx]?.status === "approved") {
        queue.push({
          stamp,
          idx,
          file,
          caption: quotes[idx]?.caption || "",
        });
      }
    });
  }

  if (queue.length === 0) {
    return res.json({ scheduled: 0, message: "No approved cards in queue" });
  }

  // Compute slot times
  const slots = fbNextSlots({
    peakHours: cfg.peakHours,
    timezone: cfg.timezone,
    from: new Date(startTime.getTime() + 12 * 60 * 1000), // 12 min from start (>10 min FB min)
    count: queue.length,
    dailyCap: cfg.dailyCap,
  });

  const results = [];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const slot = slots[i];
    try {
      const result = await fbPostPhoto({
        pageId: cfg.pageId,
        token: cfg.token,
        imagePath: path.join(cardsDir, item.stamp, item.file),
        caption: item.caption,
        scheduledAt: slot,
      });
      const approval = await loadBatchApproval(item.stamp);
      approval[item.idx] = {
        status: "scheduled",
        scheduledAt: slot.toISOString(),
        fbPostId: result.id,
        fbUrl: result.fbUrl,
      };
      await saveBatchApproval(item.stamp, approval);
      results.push({
        stamp: item.stamp,
        idx: item.idx,
        scheduledAt: slot.toISOString(),
        fbPostId: result.id,
      });
    } catch (err) {
      const approval = await loadBatchApproval(item.stamp);
      approval[item.idx] = {
        status: "failed",
        scheduledAt: slot.toISOString(),
        error: err.message,
      };
      await saveBatchApproval(item.stamp, approval);
      results.push({
        stamp: item.stamp,
        idx: item.idx,
        error: err.message,
      });
    }
  }

  res.json({
    scheduled: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    results,
  });
});

// Post a single card immediately (for testing / manual one-off).
app.post("/api/queue/:stamp/:idx/post-now", async (req, res) => {
  const cfg = await readJson("posting.json", {});
  if (!cfg.token || !cfg.pageId) {
    return res.status(400).json({ error: "FB Page not connected" });
  }
  const { stamp, idx } = req.params;
  const batchPath = path.join(OUT_DIR, "cards", stamp);
  const cardFiles = (await fs.readdir(batchPath))
    .filter((f) => f.endsWith(".png"))
    .sort();
  const file = cardFiles[parseInt(idx, 10)];
  if (!file) return res.status(404).json({ error: "Card not found" });
  const quotesFile = await findQuotesForBatch(stamp);
  let caption = "";
  if (quotesFile) {
    try {
      const quotes = JSON.parse(
        await fs.readFile(path.join(OUT_DIR, quotesFile), "utf-8"),
      );
      caption = quotes[parseInt(idx, 10)]?.caption || "";
    } catch {
      /* ignore */
    }
  }
  try {
    const result = await fbPostPhoto({
      pageId: cfg.pageId,
      token: cfg.token,
      imagePath: path.join(batchPath, file),
      caption,
    });
    const approval = await loadBatchApproval(stamp);
    approval[idx] = {
      status: "posted",
      postedAt: new Date().toISOString(),
      fbPostId: result.id,
      fbUrl: result.fbUrl,
    };
    await saveBatchApproval(stamp, approval);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Generate (streaming) --------------------------------------------

const streamSpawn = (res, cmd, args, env = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd: projectRoot,
      env: { ...process.env, ...env },
    });
    p.stdout.on("data", (chunk) => res.write(chunk));
    p.stderr.on("data", (chunk) => res.write(chunk));
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    p.on("error", reject);
  });

app.post("/api/generate", async (req, res) => {
  const {
    count = 20,
    brandPresetId,
    briefId,
    useCharacters = false,
  } = req.body || {};
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Transfer-Encoding": "chunked",
  });

  const env = {
    DASHBOARD_BRAND_PRESET_ID: brandPresetId || "",
    DASHBOARD_BRIEF_ID: briefId || "",
    DASHBOARD_USE_CHARACTERS: useCharacters ? "1" : "",
  };

  try {
    await streamSpawn(res, "node", [
      "scripts/generate-quotes.mjs",
      String(count),
    ], env);

    const files = await fs.readdir(OUT_DIR);
    const latest = files
      .filter((f) => f.startsWith("quotes-") && f.endsWith(".json"))
      .sort()
      .pop();
    const latestPath = path.join(OUT_DIR, latest);

    await streamSpawn(
      res,
      "node",
      ["scripts/generate-backgrounds.mjs", latestPath],
      env,
    );
    await streamSpawn(
      res,
      "node",
      ["scripts/render-batch.mjs", latestPath, "png"],
      env,
    );
    res.end();
  } catch (err) {
    res.write("\n!! Error: " + err.message + "\n");
    res.end();
  }
});

// --- Static file serving ---------------------------------------------------

// Card images: /api/cards/:stamp/:file
app.get("/api/cards/:stamp/:file", (req, res) => {
  const { stamp, file } = req.params;
  const safe = path.basename(file);
  const filePath = path.join(OUT_DIR, "cards", stamp, safe);
  if (!existsSync(filePath)) return res.status(404).end();
  createReadStream(filePath).pipe(res);
});

// Generic public/ serving: /uploads/<filename> or /uploads/characters/<name>
app.use("/uploads", express.static(PUBLIC_DIR));
app.use("/api/static", express.static(PUBLIC_DIR));

// Legacy console (old simple-server HTML lives in a route now)
app.get("/console", (_req, res) => {
  res.redirect("/");
});

// --- Dashboard SPA serving -------------------------------------------------

if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback — anything not matched above serves index.html
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.send(`<!doctype html>
<html><body style="font-family:system-ui;max-width:640px;margin:60px auto;color:#333">
<h1>Dashboard not built yet</h1>
<p>Run:</p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px">cd dashboard && npm run build</pre>
<p>Then refresh.</p>
</body></html>`);
  });
}

// --- Start -----------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\n╭────────────────────────────────────────────╮`);
  console.log(`│  Yes to Success — Dashboard backend         │`);
  console.log(`│  http://localhost:${PORT}                        │`);
  console.log(`│  Dashboard:  ${existsSync(DIST_DIR) ? "served from dist/" : "NOT BUILT — run npm run dashboard:build"} │`);
  console.log(`│  Auth:       ${PASSWORD ? "enabled (DASHBOARD_PASSWORD set)" : "disabled"} │`);
  console.log(`╰────────────────────────────────────────────╯\n`);
});
