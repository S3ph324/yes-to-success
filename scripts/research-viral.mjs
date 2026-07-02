#!/usr/bin/env node
// Viral Pattern Research Engine (CLI) — Jurie brand content intelligence.
//
// Researches PUBLIC viral-content sources (YouTube search + public transcripts),
// extracts transferable patterns (never copies), stores them in a persistent
// ranked JSON database, and generates an HTML report: top patterns → 10 content
// ideas → 5 sample scripts in the brand's direct/honest voice → b-roll → soft
// CTAs → a repeatable weekly content system.
//
// Usage:
//   npm run research                          # full run (collect 10 → analyze → report)
//   npm run research -- --count 5 --topic "freelancing"
//   npm run research -- --collect-only --count 3   # stage test: find sources only
//   npm run research -- --skip-report              # collect + analyze + save, no report
//   npm run research -- --report-only              # regenerate report from the DB
//
// Ethics: public data only, transcripts capped, patterns-not-plagiarism. The DB
// records source names for provenance; generated ideas/scripts never name anyone.

import { GoogleGenAI, Type } from "@google/genai";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyGcpEnv, projectRoot } from "./lib/client.mjs";

applyGcpEnv();
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const scriptsDir = path.join(projectRoot, "scripts");

// ── flags ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = "") => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const has = (name) => argv.includes(name);
const COUNT = Math.max(1, Math.min(25, parseInt(flag("--count", "10"), 10) || 10));
const TOPIC = flag("--topic", "").trim();
const REPORT_ONLY = has("--report-only");
const COLLECT_ONLY = has("--collect-only");
const SKIP_REPORT = has("--skip-report");
const NO_OPEN = has("--no-open") || process.env.JURIE_NO_OPEN === "1";

// ── paths ───────────────────────────────────────────────────────────────────
const DB_PATH =
  process.env.RESEARCH_DB ||
  path.join(projectRoot, "research-data", "patterns-db.json");
const EXPORT_BASE =
  process.env.RESEARCH_EXPORT_DIR ||
  path.join(os.homedir(), "claude_code", "research-reports");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadText = async (p) => {
  try { return await fs.readFile(p, "utf-8"); } catch { return ""; }
};

// ── DB (persistent + growing; dedupe by videoId/url) ───────────────────────
async function loadDb() {
  try {
    const d = JSON.parse(await fs.readFile(DB_PATH, "utf-8"));
    return Array.isArray(d.records) ? d : { records: [] };
  } catch {
    return { records: [] };
  }
}
async function saveDb(db) {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

// ── Stage A: COLLECT ────────────────────────────────────────────────────────
// Query bank spanning the 15 research dimensions; --topic prepends focused
// variants (same steering idea as the Format Hacker niche field).
const QUERY_BANK = [
  "viral video hooks that actually work",
  "first 3 seconds retention short form video",
  "storytelling structure viral short form content",
  "video retention techniques creators",
  "curiosity gap content strategy",
  "pain point marketing content creators",
  "contrarian content strategy personal brand",
  "educational content structure that goes viral",
  "personal brand positioning content creator",
  "call to action without hard selling content",
  "talking head video structure b-roll tips",
  "before and after transformation content format",
  "AI automation content trends for creators",
  "creator economy content strategy",
];
const topicQueries = (t) => [
  `${t} viral content breakdown`,
  `${t} content strategy that works`,
  `how to make ${t} content people watch`,
];

async function collectSources(db, count, topic) {
  const seen = new Set(db.records.map((r) => r.videoId).filter(Boolean));
  const queries = topic ? [...topicQueries(topic), ...QUERY_BANK] : QUERY_BANK;
  const found = [];
  let ytSearch, YoutubeTranscript;
  try {
    const [ytMod, txMod] = await Promise.all([
      import("yt-search"),
      import("youtube-transcript"),
    ]);
    ytSearch = ytMod.default || ytMod;
    YoutubeTranscript = txMod.YoutubeTranscript || txMod.default || txMod;
  } catch (e) {
    throw new Error("Scraping modules unavailable: " + (e?.message || e));
  }
  for (const q of queries) {
    if (found.length >= count) break;
    let vids = [];
    try {
      const r = await ytSearch(q);
      vids = ((r && r.videos) || []).slice(0, 6);
    } catch {
      continue; // this query failed — try the next
    }
    for (const v of vids) {
      if (found.length >= count) break;
      if (!v.videoId || seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      try {
        const parts = await YoutubeTranscript.fetchTranscript(v.videoId);
        // Patterns, not plagiarism: cap the excerpt; we never store transcripts.
        const transcript = parts.map((p) => p.text).join(" ").slice(0, 6000).trim();
        if (transcript.length < 300) continue; // too thin to learn from
        found.push({
          videoId: v.videoId,
          title: v.title || "",
          author: (v.author && v.author.name) || "",
          url: v.url || "https://www.youtube.com/watch?v=" + v.videoId,
          query: q,
          transcript,
        });
        console.log(`  + [${found.length}/${count}] ${String(v.title).slice(0, 70)}`);
      } catch {
        /* no public transcript — skip */
      }
    }
  }
  return found;
}

// ── Stage B+C: ANALYZE (record schema incl. self-check + ranking) ──────────
const S = Type.STRING;
const recordSchema = {
  type: Type.OBJECT,
  properties: {
    sourceName: { type: S },
    platform: { type: S },
    contentNiche: { type: S },
    viralFormat: { type: S },
    hookPattern: { type: S },
    first3Seconds: { type: S },
    emotionalTrigger: { type: S },
    audiencePainPoint: { type: S },
    curiosityLoop: { type: S },
    retentionTechnique: { type: S },
    storytellingFramework: { type: S },
    ctaStyle: { type: S },
    bRollIdeas: { type: Type.ARRAY, items: { type: S } },
    whyItWorked: { type: S },
    ethicalAdaptation: { type: S },
    sampleScriptIdea: { type: S },
    copycatWarning: { type: S },
    alignmentScore: { type: Type.NUMBER },
    selfCheck: {
      type: Type.OBJECT,
      properties: {
        useful: { type: Type.BOOLEAN },
        ethical: { type: Type.BOOLEAN },
        aligned: { type: Type.BOOLEAN },
        actionable: { type: Type.BOOLEAN },
        notCopying: { type: Type.BOOLEAN },
      },
      required: ["useful", "ethical", "aligned", "actionable", "notCopying"],
    },
  },
  required: [
    "sourceName", "platform", "contentNiche", "viralFormat", "hookPattern",
    "first3Seconds", "emotionalTrigger", "audiencePainPoint", "curiosityLoop",
    "retentionTechnique", "storytellingFramework", "ctaStyle", "bRollIdeas",
    "whyItWorked", "ethicalAdaptation", "sampleScriptIdea", "copycatWarning",
    "alignmentScore", "selfCheck",
  ],
};

async function analyzeSource(ai, director, voice, src, topic) {
  const sys =
    director +
    (topic ? `\n\n## RESEARCH FOCUS\nThe brand is currently researching: "${topic}". Weigh alignment with that focus.\n` : "") +
    "\n\n## THE BRAND'S VOICE PROFILE (adaptation fields must sound like this)\n\n" +
    voice +
    "\n\nIMPORTANT OVERRIDE: the voice profile above ends with poster-JSON " +
    "output instructions — IGNORE those. Your ONLY output is the research " +
    "record JSON per the system instruction. `sampleScriptIdea` is plain prose " +
    "(a working title + 1–2 sentence premise) — never poster tokens, arrays, " +
    "or code blocks.";
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [{
        text:
          `SOURCE METADATA\nTitle: ${src.title}\nChannel: ${src.author}\nFound via query: ${src.query}\n\n` +
          `TRANSCRIPT (capped excerpt):\n${src.transcript}\n\n` +
          "Extract the pattern record per the system instruction. Return ONLY the JSON object.",
      }],
    }],
    config: {
      systemInstruction: sys,
      responseMimeType: "application/json",
      responseSchema: recordSchema,
      temperature: 0.4, // analysis, not creativity — judge strictly
    },
  });
  const r = JSON.parse(resp.text);
  const sc = r.selfCheck || {};
  return {
    ...r,
    bRollIdeas: (Array.isArray(r.bRollIdeas) ? r.bRollIdeas : []).map(String).slice(0, 5),
    alignmentScore: Math.max(0, Math.min(100, Math.round(Number(r.alignmentScore) || 0))),
    // Hard gate: unethical-to-use or identity-copying patterns never feed reports.
    excluded: !(sc.ethical && sc.notCopying),
    url: src.url,
    videoId: src.videoId,
    query: src.query,
    collectedAt: new Date().toISOString().slice(0, 10),
  };
}

// ── Stage E: REPORT (the 8 deliverables from the WHOLE DB) ─────────────────
const sceneSchema = {
  type: Type.OBJECT,
  properties: {
    shot: { type: S }, duration: { type: S }, onScreenText: { type: S },
    voiceover: { type: S }, bRoll: { type: S },
  },
  required: ["shot", "onScreenText", "voiceover"],
};
const reportSchema = {
  type: Type.OBJECT,
  properties: {
    topPatterns: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { name: { type: S }, whyItWorks: { type: S }, howToUseForBrand: { type: S } },
        required: ["name", "whyItWorks", "howToUseForBrand"],
      },
    },
    synthesis: { type: S },
    contentIdeas: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { title: { type: S }, angle: { type: S }, format: { type: S } },
        required: ["title", "angle", "format"],
      },
    },
    scripts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: S }, premise: { type: S }, hook: { type: S },
          scenes: { type: Type.ARRAY, items: sceneSchema },
          caption: { type: S }, softCta: { type: S },
        },
        required: ["title", "premise", "hook", "scenes", "caption", "softCta"],
      },
    },
    ctaSuggestions: { type: Type.ARRAY, items: { type: S } },
    weeklySystem: {
      type: Type.OBJECT,
      properties: {
        overview: { type: S },
        schedule: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { day: { type: S }, activity: { type: S } },
            required: ["day", "activity"],
          },
        },
      },
      required: ["overview", "schedule"],
    },
  },
  required: ["topPatterns", "synthesis", "contentIdeas", "scripts", "ctaSuggestions", "weeklySystem"],
};

async function buildReport(ai, db, voice) {
  const top = db.records
    .filter((r) => !r.excluded)
    .sort((a, b) => (b.alignmentScore || 0) - (a.alignmentScore || 0))
    .slice(0, 15);
  if (top.length === 0) throw new Error("No usable patterns in the DB yet — run a collection first.");
  // Compact records for the prompt: patterns only, no provenance noise.
  const compact = top.map((r, i) => ({
    n: i + 1, score: r.alignmentScore, niche: r.contentNiche,
    format: r.viralFormat, hook: r.hookPattern, first3s: r.first3Seconds,
    trigger: r.emotionalTrigger, pain: r.audiencePainPoint,
    curiosity: r.curiosityLoop, retention: r.retentionTechnique,
    story: r.storytellingFramework, cta: r.ctaStyle,
    why: r.whyItWorked, adaptation: r.ethicalAdaptation, idea: r.sampleScriptIdea,
  }));
  const sys =
    "You are the brand's creative director. From the ranked pattern database " +
    "below, produce the brand's content playbook. The brand: a Filipino AI " +
    "mentor — direct, honest, value-based, practical; knowledge has value (no " +
    "fake-free, no 'FREE SECRET' bait, transparent that deep guidance is paid); " +
    "never shames the audience; audience = business owners, freelancers, VAs, " +
    "networkers, people afraid of being left behind by AI. HARD RULE: never " +
    "name, quote, tag, or reference any real person, brand, or creator.\n\n" +
    "Content shape: strong first-3-seconds hook; ~3 main value points; a " +
    "curiosity loop every 3–4 seconds; talking head + B-roll; include at least " +
    "one before/after (manual grind vs AI-systemized) script.\n\n" +
    "Produce EXACTLY: 5–8 topPatterns (name each pattern yourself — generic, " +
    "reusable names), a synthesis paragraph, 10 contentIdeas, 5 scripts " +
    "(Taglish voiceover, 4–7 scenes each: shot type, rough duration, literal " +
    "on-screen text, the ACTUAL spoken lines, optional bRoll per scene; plus a " +
    "ready-to-post caption and a soft CTA), 5 ctaSuggestions (soft, no " +
    "hard-sell), and a weeklySystem the brand can repeat (overview + day-by-day " +
    "schedule mixing the formats).\n\n## THE BRAND'S VOICE PROFILE\n\n" + voice +
    "\n\nIMPORTANT OVERRIDE: the voice profile above ends with poster-JSON " +
    "output instructions — IGNORE those. Output ONLY the playbook JSON per the " +
    "provided schema; every string field is plain prose (Taglish welcome), " +
    "never poster tokens or code blocks.";
  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [{ text: "RANKED PATTERN DATABASE (top " + compact.length + "):\n\n" + JSON.stringify(compact, null, 1) + "\n\nBuild the playbook. Return ONLY the JSON object." }],
    }],
    config: {
      systemInstruction: sys,
      responseMimeType: "application/json",
      responseSchema: reportSchema,
      temperature: 0.8,
    },
  });
  return JSON.parse(resp.text);
}

// ── HTML rendering (dark, click-to-copy, self-contained) ───────────────────
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function scriptText(sc) {
  const L = [sc.title, "Premise: " + sc.premise, "Hook: " + sc.hook];
  (sc.scenes || []).forEach((s, i) => {
    L.push("", `Scene ${i + 1}${s.shot ? ` (${s.shot}${s.duration ? ", " + s.duration : ""})` : ""}`);
    if (s.onScreenText) L.push("On-screen: " + s.onScreenText);
    if (s.voiceover) L.push("Voiceover: " + s.voiceover);
    if (s.bRoll) L.push("B-roll: " + s.bRoll);
  });
  if (sc.caption) L.push("", "Caption: " + sc.caption);
  if (sc.softCta) L.push("CTA: " + sc.softCta);
  return L.join("\n");
}

function renderHtml(rep, db, stamp) {
  const usable = db.records.filter((r) => !r.excluded).length;
  const sec = (title, body) =>
    `<section><h2>${esc(title)}</h2>${body}</section>`;
  const pats = rep.topPatterns.map((p, i) =>
    `<div class="card"><h3>${i + 1}. ${esc(p.name)}</h3>
     <p><b>Why it works:</b> ${esc(p.whyItWorks)}</p>
     <p><b>For this brand:</b> ${esc(p.howToUseForBrand)}</p></div>`).join("");
  const ideas = rep.contentIdeas.map((c, i) =>
    `<div class="idea"><b>${i + 1}. ${esc(c.title)}</b><br>${esc(c.angle)} <span class="tag">${esc(c.format)}</span></div>`).join("");
  const scripts = rep.scripts.map((sc, i) => {
    const scenes = (sc.scenes || []).map((s, j) =>
      `<div class="scene"><div class="sh">Scene ${j + 1}${s.shot ? " · " + esc(s.shot) : ""}${s.duration ? " · " + esc(s.duration) : ""}</div>
       ${s.onScreenText ? `<div><b>On-screen</b> — ${esc(s.onScreenText)}</div>` : ""}
       ${s.voiceover ? `<div><b>VO</b> — ${esc(s.voiceover)}</div>` : ""}
       ${s.bRoll ? `<div><b>B-roll</b> — ${esc(s.bRoll)}</div>` : ""}</div>`).join("");
    return `<div class="card"><h3>Script ${i + 1} — ${esc(sc.title)}</h3>
      <p class="mut">${esc(sc.premise)}</p>
      <div class="hook"><b>Hook:</b> ${esc(sc.hook)}</div>${scenes}
      <p><b>Caption:</b> ${esc(sc.caption)}</p><p><b>Soft CTA:</b> ${esc(sc.softCta)}</p>
      <button data-copy="${esc(Buffer.from(scriptText(sc)).toString("base64"))}">Copy full script</button></div>`;
  }).join("");
  const ctas = "<ul>" + rep.ctaSuggestions.map((c) => `<li>${esc(c)}</li>`).join("") + "</ul>";
  const week = `<p class="mut">${esc(rep.weeklySystem.overview)}</p><table><tr><th>Day</th><th>Activity</th></tr>` +
    rep.weeklySystem.schedule.map((d) => `<tr><td>${esc(d.day)}</td><td>${esc(d.activity)}</td></tr>`).join("") + "</table>";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Content Intelligence — ${esc(stamp)}</title><style>
body{background:#0b0b0d;color:#f3f3f5;font-family:system-ui,Arial,sans-serif;max-width:880px;margin:0 auto;padding:28px 20px;line-height:1.55}
h1{font-size:22px}h2{color:#F5C13B;font-size:16px;letter-spacing:.05em;text-transform:uppercase;margin:34px 0 12px;border-bottom:1px solid #26262b;padding-bottom:8px}
h3{font-size:15px;margin:0 0 8px}.mut{color:#9a9aa2}.card{background:#141417;border:1px solid #26262b;border-radius:12px;padding:16px 18px;margin:12px 0}
.idea{border-left:2px solid #F5C13B;padding:6px 0 6px 12px;margin:10px 0}.tag{color:#7fb2ff;font-size:12px}
.scene{border-left:2px solid #F5C13B;padding:6px 0 6px 12px;margin:10px 0;font-size:14px}.sh{color:#F5C13B;font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.hook{background:rgba(245,193,59,.08);border:1px solid #26262b;border-radius:8px;padding:8px 12px;margin:10px 0}
button{background:#F5C13B;color:#15120a;border:0;font-weight:700;padding:9px 14px;border-radius:8px;cursor:pointer;margin-top:8px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #26262b;padding:8px 10px;text-align:left;font-size:14px}th{color:#9a9aa2}
ul{padding-left:20px}li{margin:6px 0}</style></head><body>
<h1>🧠 Content Intelligence Report</h1>
<p class="mut">${esc(stamp)} · database: ${db.records.length} patterns (${usable} usable) · patterns extracted, never copied — no creator is named in any idea or script.</p>
${sec("1 · Top viral patterns (ranked for this brand)", pats)}
${sec("2 · Synthesis — why these work", `<p>${esc(rep.synthesis)}</p>`)}
${sec("3 · 10 original content ideas", ideas)}
${sec("4 · 5 sample scripts (direct, honest positioning)", scripts)}
${sec("5 · Soft CTA suggestions", ctas)}
${sec("6 · Weekly content system", week)}
<script>document.querySelectorAll("button[data-copy]").forEach(function(b){b.onclick=function(){
navigator.clipboard.writeText(atob(b.dataset.copy)).then(function(){var o=b.textContent;b.textContent="Copied ✓";setTimeout(function(){b.textContent=o;},1500);});};});</scr` + `ipt></body></html>`;
}

// ── main ────────────────────────────────────────────────────────────────────
const ai = new GoogleGenAI({ vertexai: true, project, location });
const db = await loadDb();
console.log(`Pattern DB: ${DB_PATH} (${db.records.length} records)`);

if (!REPORT_ONLY) {
  console.log(`\n▶ COLLECT — up to ${COUNT} new sources${TOPIC ? ` · focus "${TOPIC}"` : ""}…`);
  const sources = await collectSources(db, COUNT, TOPIC);
  if (sources.length === 0) {
    console.error("No new sources with public transcripts found. Try --topic or run again later.");
    process.exit(COLLECT_ONLY ? 0 : 1);
  }
  console.log(`✓ ${sources.length} source(s) collected.`);
  if (COLLECT_ONLY) process.exit(0);

  console.log(`\n▶ ANALYZE — extracting patterns (1 call/source, throttled)…`);
  const director = await loadText(path.join(scriptsDir, "research-director.md"));
  const voice = await loadText(path.join(scriptsDir, "voice-profile-jurie.md"));
  let added = 0;
  for (const src of sources) {
    try {
      const rec = await analyzeSource(ai, director, voice, src, TOPIC);
      db.records.push(rec);
      added += 1;
      console.log(`  ✓ ${String(src.title).slice(0, 56)} → score ${rec.alignmentScore}${rec.excluded ? " (excluded)" : ""}${rec.copycatWarning ? " ⚠" : ""}`);
    } catch (e) {
      console.warn(`  ✗ ${String(src.title).slice(0, 56)} — ${e?.message || e}`);
    }
    await sleep(2000); // shared Vertex quota — be gentle
  }
  await saveDb(db);
  console.log(`✓ DB saved — ${db.records.length} total (${added} new).`);
  if (SKIP_REPORT) process.exit(0);
}

console.log(`\n▶ REPORT — building the playbook from the whole DB…`);
const voice = await loadText(path.join(scriptsDir, "voice-profile-jurie.md"));
const rep = await buildReport(ai, db, voice);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const outDir = path.join(EXPORT_BASE, stamp);
await fs.mkdir(outDir, { recursive: true });
const htmlPath = path.join(outDir, "report.html");
await fs.writeFile(htmlPath, renderHtml(rep, db, stamp));
await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(rep, null, 2));
console.log(`✓ Report → ${htmlPath}`);
if (!NO_OPEN) spawn("open", [htmlPath], { stdio: "ignore" });
