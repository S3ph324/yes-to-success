#!/usr/bin/env node
// Build the dark, click-to-copy B-Roll HTML deliverable (brolls house style)
// + an export folder with the HTML, first-frame images, and the manifest.
//
// Usage: node scripts/broll-deliverable.mjs out/broll-<stamp>.json

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./lib/client.mjs";

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/broll-deliverable.mjs <broll.json>");
  process.exit(1);
}
const jsonPath = path.isAbsolute(arg) ? arg : path.join(process.cwd(), arg);
const data = JSON.parse(await fs.readFile(jsonPath, "utf-8"));
const shots = data.shots || [];
const meta = data.meta || {};
const stem = path.basename(jsonPath, ".json");

const EXPORT_BASE =
  process.env.BROLL_EXPORT_DIR ||
  path.join(os.homedir(), "claude_code", "brolls", "generated");
const exportDir = path.join(EXPORT_BASE, meta.createdAt || stem);
await fs.mkdir(exportDir, { recursive: true });

// Copy first-frame images in so the HTML is self-contained.
for (const s of shots) {
  if (!s.framePath) continue;
  const src = path.join(projectRoot, "public", s.framePath);
  try {
    await fs.copyFile(src, path.join(exportDir, `shot-${String(s.n).padStart(2, "0")}.png`));
  } catch {
    /* frame missing — skip */
  }
}

const esc = (x) =>
  String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const shotHtml = shots
  .map((s) => {
    const n2 = String(s.n).padStart(2, "0");
    const fname = `shot-${n2}.png`;
    const frameBlock = s.framePath
      ? `<div class="frame-wrap">
    <img class="frame" src="./${fname}" alt="first frame ${s.n}" loading="lazy">
    <a class="download-btn" href="./${fname}" download="${fname}" title="Save shot ${s.n} as PNG">
      <span class="dl-icon">↓</span> Download PNG
    </a>
  </div>`
      : `<div class="frame ph">no first frame</div>`;
    const badge = s.usesCharacter
      ? ` <span class="charbadge">character</span>`
      : "";
    const tc = s.timecode
      ? `<span class="timecode">${esc(s.timecode)}</span>`
      : "";
    return `<div class="shot">
  <h2>B-Roll ${s.n} — ${esc(s.title)}${badge}</h2>
  <div class="beat">${tc}Beat: ${esc(s.beat)}</div>
  ${frameBlock}
  <div class="block image"><div class="label"><span class="dot"></span>Nano Banana — image prompt (first frame)</div>
  <div class="prompt"><button class="copy">Copy</button>${esc(s.imagePrompt)}</div></div>
  <div class="block video"><div class="label"><span class="dot"></span>Veo 3.1 — video prompt</div>
  <div class="prompt"><button class="copy">Copy</button>${esc(s.videoPrompt)}</div></div>
</div>`;
  })
  .join("\n");

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>B-Roll — ${esc(meta.createdAt || stem)} (${shots.length} shots, ${esc(meta.aspect)})</title>
<style>
:root{--bg:#0e0f12;--panel:#15171c;--line:#262932;--text:#e8e9ec;--muted:#8a8f9a;
--accent:#f4c95d;--img:#7cc4ff;--vid:#b48bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
header{padding:40px 28px 24px;border-bottom:1px solid var(--line);max-width:980px;margin:0 auto}
header h1{margin:0 0 8px;font-size:26px;letter-spacing:-.01em}
header p{margin:4px 0;color:var(--muted);font-size:14px}
header .meta span{display:inline-block;margin-right:14px;color:var(--accent)}
main{max-width:980px;margin:0 auto;padding:24px 28px 80px}
.shot{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin:18px 0}
.shot h2{margin:0 0 4px;font-size:18px}
.shot .beat{color:var(--muted);font-size:13px;margin-bottom:16px;font-style:italic}
.timecode{display:inline-block;background:#0a0b0e;color:var(--accent);font-size:11px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 8px;border-radius:4px;
margin-right:8px;border:1px solid var(--line)}
.charbadge{display:inline-block;background:#1c1f26;color:var(--vid);font-size:10px;font-weight:600;
letter-spacing:.06em;padding:2px 8px;border-radius:4px;margin-left:6px;border:1px solid var(--line);
text-transform:uppercase}
.frame-wrap{position:relative;display:inline-block;max-width:340px;margin:0 0 16px}
.frame{display:block;width:100%;max-width:340px;border:1px solid var(--line);border-radius:8px;
background:#0a0b0e}
.frame.ph{padding:40px;text-align:center;color:var(--muted);font-size:12px;max-width:340px}
.download-btn{display:inline-flex;align-items:center;gap:8px;margin-top:10px;
padding:10px 18px;background:var(--accent);color:#1a1306;text-decoration:none;
border-radius:8px;font-weight:700;font-size:13px;letter-spacing:.01em;
border:1px solid rgba(0,0,0,.18);
box-shadow:0 1px 0 rgba(255,255,255,.32) inset,0 -1px 0 rgba(0,0,0,.18) inset,
  0 6px 14px -6px rgba(244,201,93,.5);
transition:transform .14s,box-shadow .14s,opacity .14s}
.download-btn:hover{transform:translateY(-1px);
box-shadow:0 1px 0 rgba(255,255,255,.42) inset,0 -1px 0 rgba(0,0,0,.18) inset,
  0 10px 22px -8px rgba(244,201,93,.65)}
.download-btn:active{transform:translateY(0)}
.dl-icon{font-size:16px;font-weight:800;line-height:1}
.dl-all{display:inline-flex;align-items:center;gap:9px;margin-top:18px;padding:11px 22px;
background:var(--accent);color:#1a1306;text-decoration:none;border-radius:10px;
font-weight:700;font-size:14px;letter-spacing:.012em;border:1px solid rgba(0,0,0,.18);
box-shadow:0 1px 0 rgba(255,255,255,.34) inset,0 -1px 0 rgba(0,0,0,.18) inset,
  0 10px 24px -10px rgba(244,201,93,.55)}
.dl-all:hover{transform:translateY(-1px);
box-shadow:0 1px 0 rgba(255,255,255,.46) inset,0 -1px 0 rgba(0,0,0,.18) inset,
  0 14px 30px -10px rgba(244,201,93,.7)}
.dl-all .dl-icon{font-size:18px}
.block{margin:12px 0}
.block .label{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;
letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px}
.block.image .label{color:var(--img)}.block.video .label{color:var(--vid)}
.block .dot{width:8px;height:8px;border-radius:50%;background:currentColor;display:inline-block}
.prompt{background:#0a0b0e;border:1px solid var(--line);border-radius:8px;padding:14px 16px;
font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6;
white-space:pre-wrap;color:#dde0e6;position:relative}
.copy{position:absolute;top:8px;right:8px;background:#1c1f26;border:1px solid var(--line);
color:var(--muted);font-size:11px;padding:4px 10px;border-radius:6px;cursor:pointer;font-family:inherit}
.copy:hover{color:var(--text)}.copy.copied{color:var(--accent);border-color:var(--accent)}
.howto{background:#15171c;border:1px solid var(--line);border-left:3px solid var(--accent);
border-radius:6px;padding:16px 20px;margin-top:30px;font-size:14px}
.howto h3{margin:0 0 8px;color:var(--accent);font-size:13px;letter-spacing:.04em;text-transform:uppercase}
.howto ol{margin:6px 0 0 18px;padding:0}.howto li{margin:5px 0}
</style></head><body>
<header><h1>B-Roll Sequence</h1>
<p class="meta"><span>${shots.length} shots</span><span>${esc(meta.aspect)}</span>
<span>${meta.charMode === "reference-image" ? "Character via reference image" : "No character"}</span>
<span>${esc(meta.sourceKind || "")}</span></p>
<p>First frame + paired prompts for each shot. Generate the Nano Banana image (already
rendered above each pair), then feed it as the start frame to Veo 3.1 with the video prompt.</p>
<a class="dl-all" href="./broll-frames.zip" download="broll-${esc(meta.createdAt || stem)}.zip">
  <span class="dl-icon">↓</span> Download all ${shots.length} PNGs (.zip)
</a></header>
<main>
${shotHtml}
<div class="howto"><h3>How to use</h3><ol>
<li>For each shot, the first frame is already generated (shown above the prompts).</li>
<li>Refine it if needed with the Nano Banana image prompt (click Copy).</li>
<li>Feed that image to Veo 3.1 as the start frame with the Veo video prompt (click Copy).</li>
<li>Veo auto-animation from the dashboard is wired but OFF for now — animate the picks you want manually until Veo access/budget is confirmed.</li>
</ol></div>
</main>
<script>
document.querySelectorAll('.copy').forEach(function(b){b.addEventListener('click',function(){
var t=b.parentNode.textContent.replace(/^Copy/,'').trim();
navigator.clipboard.writeText(t).then(function(){b.textContent='Copied';b.classList.add('copied');
setTimeout(function(){b.textContent='Copy';b.classList.remove('copied');},1400);});});});
</script></body></html>`;

await fs.writeFile(path.join(exportDir, "broll.html"), html);
await fs.copyFile(jsonPath, path.join(exportDir, "manifest.json"));

// Bundle all the shot-NN.png frames into broll-frames.zip so the
// "Download all" header button in the HTML works with one click.
const zipPath = path.join(exportDir, "broll-frames.zip");
try {
  await fs.unlink(zipPath).catch(() => {});
  const z = spawnSync(
    "zip",
    ["-q", "-j", "broll-frames.zip", ...shots
      .filter((s) => s.framePath)
      .map((s) => `shot-${String(s.n).padStart(2, "0")}.png`)],
    { cwd: exportDir },
  );
  if (z.status !== 0) {
    console.warn("  zip step skipped (zip exited " + z.status + ")");
  }
} catch (e) {
  console.warn("  zip step skipped:", e?.message || e);
}

console.log(
  `\n✓ Deliverable ready\n  HTML     : ${path.join(exportDir, "broll.html")}\n` +
    `  Frames   : ${shots.filter((s) => s.framePath).length}/${shots.length}\n` +
    `  Folder   : ${exportDir}`,
);
