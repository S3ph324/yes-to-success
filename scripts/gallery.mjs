#!/usr/bin/env node
// Generate a self-contained gallery.html for a batch of cards.
//
// Usage:
//   node scripts/gallery.mjs                       # uses latest batch
//   node scripts/gallery.mjs out/cards/<stamp>     # specific batch
//
// Output: gallery.html inside the batch folder. Open in browser.

import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const findLatestBatch = async () => {
  const cardsDir = path.join(projectRoot, "out", "cards");
  const entries = await fs.readdir(cardsDir);
  const sorted = entries
    .filter((n) => !n.startsWith("."))
    .sort()
    .reverse();
  if (sorted.length === 0) throw new Error("No batches found in out/cards/");
  return path.join(cardsDir, sorted[0]);
};

const batchArg = process.argv[2];
const batchDir = batchArg
  ? path.isAbsolute(batchArg)
    ? batchArg
    : path.join(process.cwd(), batchArg)
  : await findLatestBatch();

console.log(`Building gallery for: ${batchDir}`);

// Find the matching quotes JSON. Filenames: card-NN-<variant>-<aspect>-<slug>.png
// We need to map back to the quotes JSON entries to show metadata.
const stamp = path.basename(batchDir);
const quotesFiles = await fs.readdir(path.join(projectRoot, "out"));
// Pick the quotes JSON with the closest timestamp (or just the latest).
const quotesJsons = quotesFiles
  .filter((f) => f.startsWith("quotes-") && f.endsWith(".json"))
  .sort();
const quotesPath = path.join(
  projectRoot,
  "out",
  quotesJsons[quotesJsons.length - 1],
);
const quotes = JSON.parse(await fs.readFile(quotesPath, "utf-8"));

const cardFiles = (await fs.readdir(batchDir))
  .filter((f) => f.endsWith(".png") || f.endsWith(".mp4"))
  .sort();

// Pair each card file with its quote (by index — files are numbered 1..N).
const items = cardFiles.map((file, idx) => {
  const q = quotes[idx] || {};
  return {
    file,
    quote: q.quote || "",
    caption: q.caption || "",
    variant: q.variant || "classic",
    aspectRatio: q.aspectRatio || "4:5",
    theme: q.theme || "",
    keyword: q.keyword || "",
    bgPrompt: q.bgPrompt || "",
  };
});

const variantColors = {
  classic: "#C8001E",
  image: "#7C3AED",
  bold: "#F59E0B",
};
const aspectColors = {
  "1:1": "#10B981",
  "4:5": "#3B82F6",
  "9:16": "#EC4899",
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yes to Success — Batch ${stamp}</title>
<style>
  :root {
    --bg: #0a0a0c;
    --bg-card: #15151a;
    --bg-elev: #1f1f26;
    --text: #f5f5f7;
    --text-dim: #a1a1aa;
    --border: #2a2a32;
    --accent: #FFE17A;
    --red: #C8001E;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(12px);
    background: rgba(10, 10, 12, 0.85);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
  }
  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  h1 .accent { color: var(--accent); }
  .meta {
    color: var(--text-dim);
    font-size: 13px;
  }
  .filters {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .chip {
    background: var(--bg-elev);
    color: var(--text-dim);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    user-select: none;
  }
  .chip:hover { background: var(--bg-card); color: var(--text); }
  .chip.active {
    background: var(--accent);
    color: #000;
    border-color: var(--accent);
    font-weight: 600;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 20px;
    padding: 24px;
    max-width: 1600px;
    margin: 0 auto;
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    transition: transform 0.18s, border-color 0.18s, box-shadow 0.18s;
    cursor: pointer;
  }
  .card:hover {
    transform: translateY(-2px);
    border-color: var(--accent);
    box-shadow: 0 10px 30px rgba(0,0,0,0.4);
  }
  .card img {
    display: block;
    width: 100%;
    height: auto;
    background: #000;
  }
  .card-body {
    padding: 14px 16px;
  }
  .badges {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .badge {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 8px;
    border-radius: 4px;
    color: #fff;
  }
  .quote-text {
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .caption-block {
    margin-top: 12px;
    padding: 10px 12px;
    background: var(--bg-elev);
    border-left: 2px solid var(--accent);
    border-radius: 4px;
  }
  .caption-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .caption-label {
    font-size: 10px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .caption-text {
    font-size: 12px;
    line-height: 1.55;
    color: #d4d4d8;
    white-space: pre-wrap;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .copy-btn {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 10px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .copy-btn:hover {
    background: var(--accent);
    color: #000;
  }
  .copy-btn.copied {
    background: var(--accent);
    color: #000;
  }
  .card-footer {
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 11px;
    font-family: ui-monospace, "SF Mono", monospace;
    word-break: break-all;
  }
  /* Modal */
  .modal {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.92);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 32px;
    cursor: zoom-out;
  }
  .modal.open { display: flex; }
  .modal-inner {
    max-width: 100%;
    max-height: 100%;
    display: flex;
    gap: 24px;
    align-items: flex-start;
    cursor: default;
  }
  .modal img {
    max-width: 60vw;
    max-height: 85vh;
    border-radius: 8px;
  }
  .modal-meta {
    color: var(--text);
    max-width: 380px;
    padding: 24px;
    background: var(--bg-card);
    border-radius: 12px;
    border: 1px solid var(--border);
  }
  .modal-meta h2 { font-size: 18px; margin: 0 0 12px; }
  .modal-meta p {
    font-size: 15px;
    line-height: 1.5;
    color: var(--text);
    margin: 0 0 16px;
  }
  .modal-meta .bg-prompt {
    font-size: 12px;
    color: var(--text-dim);
    font-style: italic;
    padding: 12px;
    background: var(--bg-elev);
    border-radius: 6px;
    border-left: 2px solid var(--accent);
  }
  .modal-meta .filename {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 12px;
    word-break: break-all;
  }
  .empty {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--text-dim);
    padding: 80px 0;
    font-size: 14px;
  }
</style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <h1>Yes to <span class="accent">Success</span> — Batch Gallery</h1>
        <div class="meta">${items.length} cards · ${stamp}</div>
      </div>
      <div class="meta" id="count">Showing ${items.length} / ${items.length}</div>
    </div>
    <div class="filters" id="filters">
      <div class="chip active" data-filter="all">All (${items.length})</div>
      ${["classic", "image", "bold"]
        .map((v) => {
          const n = items.filter((i) => i.variant === v).length;
          return n
            ? `<div class="chip" data-filter="variant:${v}" style="border-color:${variantColors[v]}40">${v} (${n})</div>`
            : "";
        })
        .join("")}
      ${["1:1", "4:5", "9:16"]
        .map((a) => {
          const n = items.filter((i) => i.aspectRatio === a).length;
          return n
            ? `<div class="chip" data-filter="aspect:${a}" style="border-color:${aspectColors[a]}40">${a} (${n})</div>`
            : "";
        })
        .join("")}
    </div>
  </header>

  <div class="grid" id="grid">
${items
  .map(
    (item, idx) => `    <div class="card" data-variant="${item.variant}" data-aspect="${item.aspectRatio}" data-idx="${idx}">
      <img src="${encodeURI(item.file)}" alt="" loading="lazy" data-action="enlarge" />
      <div class="card-body">
        <div class="badges">
          <span class="badge" style="background:${variantColors[item.variant]}">${item.variant}</span>
          <span class="badge" style="background:${aspectColors[item.aspectRatio]}">${item.aspectRatio}</span>
          ${item.theme ? `<span class="badge" style="background:#374151">${item.theme}</span>` : ""}
        </div>
        <p class="quote-text">${item.quote.replace(/</g, "&lt;")}</p>
        ${
          item.caption
            ? `<div class="caption-block">
          <div class="caption-label-row">
            <span class="caption-label">FB Caption</span>
            <button class="copy-btn" data-action="copy" data-idx="${idx}">Copy</button>
          </div>
          <div class="caption-text">${item.caption.replace(/</g, "&lt;")}</div>
        </div>`
            : ""
        }
      </div>
      <div class="card-footer">${item.file}</div>
    </div>`,
  )
  .join("\n")}
  </div>

  <div class="modal" id="modal">
    <div class="modal-inner" onclick="event.stopPropagation()">
      <img id="modal-img" src="" />
      <div class="modal-meta">
        <div class="badges" id="modal-badges"></div>
        <h2 id="modal-title">Quote</h2>
        <p id="modal-quote"></p>
        <div id="modal-caption-wrap" style="display:none;margin-bottom:16px">
          <div class="caption-label-row">
            <span class="caption-label">FB Caption</span>
            <button class="copy-btn" id="modal-copy-btn">Copy</button>
          </div>
          <div class="caption-text" id="modal-caption" style="white-space:pre-wrap;-webkit-line-clamp:unset;font-size:13px;line-height:1.6;color:var(--text);padding:12px;background:var(--bg-elev);border-left:2px solid var(--accent);border-radius:4px;margin-top:4px"></div>
        </div>
        <div id="modal-bg-prompt-wrap" style="display:none">
          <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">BG Prompt</div>
          <div class="bg-prompt" id="modal-bg-prompt"></div>
        </div>
        <div class="filename" id="modal-filename"></div>
      </div>
    </div>
  </div>

  <script>
    const items = ${JSON.stringify(items)};
    const variantColors = ${JSON.stringify(variantColors)};
    const aspectColors = ${JSON.stringify(aspectColors)};
    const grid = document.getElementById('grid');
    const count = document.getElementById('count');
    const modal = document.getElementById('modal');

    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const filter = chip.dataset.filter;
        let visible = 0;
        document.querySelectorAll('.card').forEach(card => {
          let show = filter === 'all';
          if (filter.startsWith('variant:')) show = card.dataset.variant === filter.slice(8);
          if (filter.startsWith('aspect:')) show = card.dataset.aspect === filter.slice(7);
          card.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        count.textContent = 'Showing ' + visible + ' / ' + items.length;
      });
    });

    const copyToClipboard = async (text, btn) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1500);
      }
    };

    // Card grid: image click → modal; copy button → clipboard (don't open modal)
    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', (e) => {
        const action = e.target.dataset && e.target.dataset.action;
        const idx = parseInt(card.dataset.idx, 10);
        const item = items[idx];

        if (action === 'copy') {
          e.stopPropagation();
          copyToClipboard(item.caption || '', e.target);
          return;
        }

        // Otherwise open modal
        document.getElementById('modal-img').src = encodeURI(item.file);
        document.getElementById('modal-quote').textContent = item.quote;
        document.getElementById('modal-filename').textContent = item.file;
        document.getElementById('modal-badges').innerHTML = [
          '<span class="badge" style="background:' + variantColors[item.variant] + '">' + item.variant + '</span>',
          '<span class="badge" style="background:' + aspectColors[item.aspectRatio] + '">' + item.aspectRatio + '</span>',
          item.theme ? '<span class="badge" style="background:#374151">' + item.theme + '</span>' : '',
        ].join('');
        const capWrap = document.getElementById('modal-caption-wrap');
        if (item.caption) {
          capWrap.style.display = 'block';
          document.getElementById('modal-caption').textContent = item.caption;
        } else {
          capWrap.style.display = 'none';
        }
        const bgWrap = document.getElementById('modal-bg-prompt-wrap');
        if (item.bgPrompt) {
          bgWrap.style.display = 'block';
          document.getElementById('modal-bg-prompt').textContent = item.bgPrompt;
        } else {
          bgWrap.style.display = 'none';
        }
        modal.classList.add('open');
      });
    });

    // Modal copy button
    const modalCopyBtn = document.getElementById('modal-copy-btn');
    if (modalCopyBtn) {
      modalCopyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(document.getElementById('modal-caption').textContent, modalCopyBtn);
      });
    }

    modal.addEventListener('click', () => modal.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') modal.classList.remove('open');
    });
  </script>
</body>
</html>
`;

const outPath = path.join(batchDir, "gallery.html");
await fs.writeFile(outPath, html);
console.log(`\n✓ Gallery written to: ${outPath}`);
console.log(`  Open it: open "${outPath}"`);
