#!/usr/bin/env node
// Dead-simple demo server. One button → runs the full batch pipeline →
// streams progress over Server-Sent Events → links to the gallery when done.
//
// Usage:
//   GOOGLE_API_KEY=... GOOGLE_CLOUD_PROJECT=... node scripts/simple-server.mjs
//
// Then open http://localhost:8787

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 8787;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yes to Success — Batch Console</title>
<style>
  :root {
    --bg: #0a0a0c;
    --panel: #15151a;
    --border: #2a2a32;
    --text: #f5f5f7;
    --dim: #a1a1aa;
    --accent: #FFE17A;
    --accent-deep: #C9952B;
    --red: #C8001E;
    --green: #10B981;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: radial-gradient(ellipse at top, #2a0608 0%, var(--bg) 60%);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap {
    max-width: 720px;
    margin: 0 auto;
    padding: 60px 24px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 8px;
  }
  .brand-mark {
    font-size: 32px;
    font-weight: 900;
    font-style: italic;
    background: linear-gradient(180deg, #FFF1B8 0%, var(--accent) 40%, var(--accent-deep) 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.01em;
  }
  h1 {
    font-size: 36px;
    margin: 0 0 8px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .sub {
    color: var(--dim);
    margin: 0 0 32px;
    font-size: 16px;
    line-height: 1.5;
  }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px;
  }
  .row {
    display: flex;
    gap: 12px;
    margin-bottom: 16px;
  }
  label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--dim);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  input[type="number"] {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    font-size: 15px;
    width: 100%;
    font-family: inherit;
  }
  input[type="number"]:focus {
    outline: none;
    border-color: var(--accent);
  }
  .col { flex: 1; }
  button.primary {
    background: linear-gradient(180deg, #FFF1B8 0%, var(--accent) 40%, var(--accent-deep) 100%);
    color: #1a0a00;
    border: none;
    border-radius: 12px;
    padding: 18px 28px;
    font-size: 18px;
    font-weight: 700;
    font-style: italic;
    width: 100%;
    cursor: pointer;
    transition: transform 0.1s, box-shadow 0.2s;
    margin-top: 12px;
    font-family: inherit;
    letter-spacing: 0.01em;
  }
  button.primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 8px 24px rgba(255, 225, 122, 0.25);
  }
  button.primary:active:not(:disabled) {
    transform: translateY(0);
  }
  button.primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    background: var(--border);
    color: var(--dim);
  }
  .log {
    margin-top: 24px;
    background: #0c0c10;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    font-family: ui-monospace, "SF Mono", monospace;
    font-size: 12px;
    line-height: 1.55;
    max-height: 400px;
    overflow-y: auto;
    white-space: pre-wrap;
    color: #c8c8d0;
    display: none;
  }
  .log.active { display: block; }
  .log .step {
    color: var(--accent);
    font-weight: 600;
  }
  .log .ok { color: var(--green); }
  .log .err { color: #ef4444; }
  .gallery-link {
    margin-top: 24px;
    padding: 20px;
    background: linear-gradient(135deg, rgba(255,225,122,0.1), rgba(201,149,43,0.05));
    border: 1px solid var(--accent);
    border-radius: 12px;
    display: none;
  }
  .gallery-link.active { display: block; }
  .gallery-link a {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
    font-size: 16px;
  }
  .gallery-link a:hover { text-decoration: underline; }
  .gallery-link .desc {
    color: var(--dim);
    font-size: 13px;
    margin-top: 6px;
  }
  .stat-row {
    display: flex;
    gap: 16px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .stat {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    flex: 1;
    min-width: 100px;
  }
  .stat .label {
    font-size: 11px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
  }
  .stat .val {
    font-size: 22px;
    font-weight: 700;
    color: var(--accent);
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,225,122,0.3);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 8px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <span class="brand-mark">YES TO SUCCESS!</span>
    </div>
    <h1>Content Batch Console</h1>
    <p class="sub">
      Click <strong>Generate Batch</strong> to produce a fresh set of
      AI-generated quote cards in John Calub's voice. Mix of classic, AI-image, and bold-keyword
      layouts across 1:1, 4:5, 9:16 aspect ratios. Ready for FB feed.
    </p>

    <div class="panel">
      <div class="row">
        <div class="col">
          <label>How many cards?</label>
          <input type="number" id="count" value="20" min="5" max="50" />
        </div>
      </div>

      <button class="primary" id="go">⚡ Generate Batch</button>

      <div class="stat-row" id="stats" style="display:none">
        <div class="stat">
          <div class="label">Cards</div>
          <div class="val" id="stat-cards">—</div>
        </div>
        <div class="stat">
          <div class="label">AI Backgrounds</div>
          <div class="val" id="stat-bgs">—</div>
        </div>
        <div class="stat">
          <div class="label">Elapsed</div>
          <div class="val" id="stat-time">—</div>
        </div>
      </div>

      <div class="log" id="log"></div>

      <div class="gallery-link" id="gallery">
        <a href="#" id="gallery-link" target="_blank">→ Open the gallery to review all cards</a>
        <div class="desc">Filter by layout / aspect ratio. Click any card to enlarge with full quote text and the AI prompt.</div>
      </div>
    </div>
  </div>

  <script>
    const go = document.getElementById('go');
    const log = document.getElementById('log');
    const stats = document.getElementById('stats');
    const statCards = document.getElementById('stat-cards');
    const statBgs = document.getElementById('stat-bgs');
    const statTime = document.getElementById('stat-time');
    const gallery = document.getElementById('gallery');
    const galleryLink = document.getElementById('gallery-link');
    const countInput = document.getElementById('count');

    let startTime = 0;
    let timerInterval = null;

    const startTimer = () => {
      startTime = Date.now();
      statTime.textContent = '0s';
      timerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - startTime) / 1000);
        statTime.textContent = s + 's';
      }, 500);
    };
    const stopTimer = () => {
      if (timerInterval) clearInterval(timerInterval);
      timerInterval = null;
    };

    const appendLog = (line, cls) => {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = line + '\\n';
      log.appendChild(span);
      log.scrollTop = log.scrollHeight;
    };

    go.addEventListener('click', async () => {
      go.disabled = true;
      go.innerHTML = '<span class="spinner"></span>Generating…';
      log.classList.add('active');
      log.innerHTML = '';
      gallery.classList.remove('active');
      stats.style.display = 'flex';
      statCards.textContent = '—';
      statBgs.textContent = '—';
      startTimer();

      let cardsDone = 0;
      let bgsDone = 0;

      try {
        const resp = await fetch('/generate?count=' + encodeURIComponent(countInput.value), {
          method: 'POST',
        });
        if (!resp.ok || !resp.body) throw new Error('Generate request failed');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            // Highlight step headers
            if (line.includes('━━━')) {
              appendLog(line, 'step');
            } else if (line.startsWith('  [') && line.includes('bg-')) {
              bgsDone++;
              statBgs.textContent = bgsDone;
              appendLog(line);
            } else if (line.startsWith('  [') && line.includes('.png')) {
              cardsDone++;
              statCards.textContent = cardsDone;
              appendLog(line);
            } else if (line.startsWith('✓')) {
              appendLog(line, 'ok');
            } else if (line.includes('FAILED') || line.includes('Error')) {
              appendLog(line, 'err');
            } else {
              appendLog(line);
            }
            // Detect gallery URL
            const m = line.match(/Gallery written to: (\\S+)/);
            if (m) {
              const galleryPath = m[1];
              galleryLink.href = '/gallery?path=' + encodeURIComponent(galleryPath);
            }
          }
        }
        stopTimer();
        appendLog('\\nDone.', 'ok');
        gallery.classList.add('active');
      } catch (err) {
        stopTimer();
        appendLog('Error: ' + err.message, 'err');
      } finally {
        go.disabled = false;
        go.textContent = '⚡ Generate Another Batch';
      }
    });
  </script>
</body>
</html>`;

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
  });

const findLatestGallery = async () => {
  const cardsDir = path.join(projectRoot, "out", "cards");
  try {
    const entries = await fs.readdir(cardsDir);
    const latest = entries
      .filter((n) => !n.startsWith("."))
      .sort()
      .pop();
    if (!latest) return null;
    return path.join(cardsDir, latest, "gallery.html");
  } catch {
    return null;
  }
};

const sendFile = async (res, filePath, type) => {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch (err) {
    res.writeHead(404);
    res.end("Not found");
  }
};

const guessType = (p) => {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".mp4")) return "video/mp4";
  if (p.endsWith(".css")) return "text/css";
  if (p.endsWith(".js")) return "text/javascript";
  return "application/octet-stream";
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/", true);
  const pathname = parsed.pathname || "/";

  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  if (pathname === "/generate" && req.method === "POST") {
    const count = String(parsed.query.count || "20");
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    });
    try {
      await streamSpawn(res, "node", ["scripts/generate-quotes.mjs", count]);
      // Find latest quotes JSON and continue.
      const outDir = path.join(projectRoot, "out");
      const files = await fs.readdir(outDir);
      const latestQuotes = files
        .filter((f) => f.startsWith("quotes-") && f.endsWith(".json"))
        .sort()
        .pop();
      const latestPath = path.join(outDir, latestQuotes);
      await streamSpawn(res, "node", [
        "scripts/generate-backgrounds.mjs",
        latestPath,
      ]);
      await streamSpawn(res, "node", [
        "scripts/render-batch.mjs",
        latestPath,
        "png",
      ]);
      await streamSpawn(res, "node", ["scripts/gallery.mjs"]);
      res.end();
    } catch (err) {
      res.write("\nError: " + err.message + "\n");
      res.end();
    }
    return;
  }

  if (pathname === "/gallery") {
    const galleryPath = parsed.query.path || (await findLatestGallery());
    if (!galleryPath) {
      res.writeHead(404);
      res.end("No gallery available — generate a batch first.");
      return;
    }
    await sendFile(res, galleryPath, "text/html; charset=utf-8");
    return;
  }

  // Serve any file inside the out/cards/ tree (for gallery images).
  if (pathname.startsWith("/out/")) {
    const filePath = path.join(projectRoot, pathname);
    const rel = path.relative(projectRoot, filePath);
    if (rel.startsWith("..")) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    await sendFile(res, filePath, guessType(filePath));
    return;
  }

  // Gallery references images by filename only — serve from the latest batch dir.
  if (pathname.endsWith(".png") || pathname.endsWith(".mp4")) {
    const latestGallery = await findLatestGallery();
    if (latestGallery) {
      const batchDir = path.dirname(latestGallery);
      const filePath = path.join(batchDir, path.basename(pathname));
      await sendFile(res, filePath, guessType(filePath));
      return;
    }
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n╭──────────────────────────────────────────────╮`);
  console.log(`│  Yes to Success — Batch Console               │`);
  console.log(`│  http://localhost:${PORT}                          │`);
  console.log(`╰──────────────────────────────────────────────╯\n`);
});
