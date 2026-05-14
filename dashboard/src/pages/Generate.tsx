import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Panel,
  PanelBody,
  Button,
  Label,
  Input,
  Select,
  PageHeader,
} from "../components/ui";
import { getBrand, getBriefs, generateBatch } from "../api";
import type { BrandPreset, Brief } from "../types";

export const Generate = () => {
  const navigate = useNavigate();
  const [presets, setPresets] = useState<BrandPreset[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [count, setCount] = useState(20);
  const [presetId, setPresetId] = useState<string>("");
  const [briefId, setBriefId] = useState<string>("");
  const [useChars, setUseChars] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [stats, setStats] = useState({ cards: 0, bgs: 0, elapsed: 0 });
  const [batchStamp, setBatchStamp] = useState<string | null>(null);
  const startRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([getBrand(), getBriefs()])
      .then(([p, b]) => {
        setPresets(p);
        setBriefs(b);
        if (p[0]) setPresetId(p[0].id);
        if (b[0]) setBriefId(b[0].id);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length]);

  const tickTimer = () => {
    setStats((s) => ({ ...s, elapsed: Math.floor((Date.now() - startRef.current) / 1000) }));
  };

  const start = async () => {
    setRunning(true);
    setLog([]);
    setStats({ cards: 0, bgs: 0, elapsed: 0 });
    setBatchStamp(null);
    startRef.current = Date.now();
    timerRef.current = window.setInterval(tickTimer, 500);
    abortRef.current = new AbortController();

    try {
      await generateBatch(
        {
          count,
          brandPresetId: presetId,
          briefId,
          useCharacters: useChars,
        },
        (line) => {
          setLog((prev) => [...prev, line]);
          if (/bg-\d+\.png/.test(line) && /\(\d/.test(line)) {
            setStats((s) => ({ ...s, bgs: s.bgs + 1 }));
          } else if (
            /card-\d+/.test(line) &&
            /\.png/.test(line) &&
            /\(\d/.test(line)
          ) {
            setStats((s) => ({ ...s, cards: s.cards + 1 }));
          }
          const m = line.match(/cards\/([^/]+?)["\s]*$/);
          if (m) setBatchStamp(m[1]);
        },
        abortRef.current.signal,
      );
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        setLog((prev) => [...prev, `\n!! Error: ${String((err as Error).message)}`]);
      }
    } finally {
      setRunning(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  const lineClass = (line: string) => {
    if (line.includes("━━━")) return "text-[#FFE17A] font-semibold";
    if (line.startsWith("✓")) return "text-emerald-400";
    if (line.includes("FAILED") || line.includes("Error") || line.startsWith("!!")) return "text-red-400";
    return "text-[#c8c8d0]";
  };

  return (
    <div>
      <PageHeader
        title="Generate Batch"
        description="Pick a brand preset and brief, set the count, and run the pipeline."
      />

      <div className="grid grid-cols-[1fr_1fr] gap-6">
        <Panel title="Settings">
          <PanelBody className="space-y-5">
            <div>
              <Label>Count</Label>
              <Input
                type="number"
                value={count}
                onChange={(e) => setCount(parseInt(e.target.value, 10) || 0)}
                min={5}
                max={50}
              />
            </div>

            <div>
              <Label>Brand Preset</Label>
              <Select
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label>Content Brief</Label>
              <Select
                value={briefId}
                onChange={(e) => setBriefId(e.target.value)}
              >
                {briefs.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex items-center gap-3 p-3 bg-[#0a0a0c] border border-[#2a2a32] rounded-lg">
              <input
                type="checkbox"
                id="useChars"
                checked={useChars}
                onChange={(e) => setUseChars(e.target.checked)}
                className="w-4 h-4 accent-[#FFE17A]"
              />
              <label htmlFor="useChars" className="text-sm flex-1">
                Use character references in image-variant cards
              </label>
            </div>

            <div className="pt-2">
              {!running ? (
                <Button onClick={start} className="w-full text-base py-3.5">
                  ⚡ Generate Batch
                </Button>
              ) : (
                <Button onClick={cancel} variant="danger" className="w-full text-base py-3.5">
                  Cancel
                </Button>
              )}
            </div>
          </PanelBody>
        </Panel>

        <Panel title="Progress">
          <PanelBody>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Stat label="Cards" value={stats.cards} />
              <Stat label="AI Backgrounds" value={stats.bgs} />
              <Stat label="Elapsed" value={`${stats.elapsed}s`} />
            </div>
            <div
              className="bg-[#0a0a0c] border border-[#2a2a32] rounded-lg p-4 font-mono text-[11px] leading-relaxed h-72 overflow-y-auto"
              style={{ whiteSpace: "pre-wrap" }}
            >
              {log.length === 0 && (
                <div className="text-[#a1a1aa] italic">
                  Idle. Click Generate to run the pipeline.
                </div>
              )}
              {log.map((line, i) => (
                <div key={i} className={lineClass(line)}>
                  {line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>

            {batchStamp && !running && (
              <div className="mt-4 p-4 bg-gradient-to-br from-[#FFE17A]/10 to-[#C9952B]/5 border border-[#FFE17A]/30 rounded-lg flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-[#FFE17A]">
                    Batch ready
                  </div>
                  <div className="text-xs text-[#a1a1aa] mt-0.5 font-mono">
                    {batchStamp}
                  </div>
                </div>
                <Button onClick={() => navigate(`/gallery?batch=${batchStamp}`)}>
                  Open Gallery →
                </Button>
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
};

const Stat = ({ label, value }: { label: string; value: number | string }) => (
  <div className="bg-[#0a0a0c] border border-[#2a2a32] rounded-lg px-4 py-3">
    <div className="text-[10px] uppercase tracking-[0.08em] text-[#a1a1aa] mb-1">
      {label}
    </div>
    <div className="text-2xl font-bold text-[#FFE17A]">{value}</div>
  </div>
);
