import { useEffect, useState } from "react";
import {
  Panel,
  PanelBody,
  Button,
  Label,
  Input,
  PageHeader,
} from "../components/ui";
import { getPostingConfig, savePostingConfig } from "../api";
import type { PostingConfig } from "../api";

export const Posting = () => {
  const [cfg, setCfg] = useState<PostingConfig | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [pageIdInput, setPageIdInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peakHours, setPeakHours] = useState<string[]>([]);
  const [timezone, setTimezone] = useState("Asia/Manila");
  const [dailyCap, setDailyCap] = useState(3);

  useEffect(() => {
    getPostingConfig()
      .then((c) => {
        setCfg(c);
        setPageIdInput(c.pageId || "");
        setPeakHours(c.peakHours || []);
        setTimezone(c.timezone || "Asia/Manila");
        setDailyCap(c.dailyCap || 3);
      })
      .catch((e) => setError(e.message));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await savePostingConfig({
        pageId: pageIdInput,
        token: tokenInput || undefined,
        timezone,
        peakHours: peakHours.filter(Boolean),
        dailyCap,
      });
      setCfg(next);
      setTokenInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const updateSlot = (i: number, v: string) => {
    setPeakHours((prev) => prev.map((s, j) => (j === i ? v : s)));
  };
  const addSlot = () => setPeakHours((prev) => [...prev, "12:00"]);
  const removeSlot = (i: number) =>
    setPeakHours((prev) => prev.filter((_, j) => j !== i));

  return (
    <div>
      <PageHeader
        title="Posting Settings"
        description="Connect your Facebook Page and configure when posts go out."
      />

      <div className="grid grid-cols-2 gap-6">
        <Panel title="Facebook Page">
          <PanelBody className="space-y-5">
            {cfg?.hasToken && cfg.pageName ? (
              <div className="flex items-center gap-3 p-4 bg-emerald-900/20 border border-emerald-600/40 rounded-lg">
                <div className="text-2xl">✓</div>
                <div className="flex-1">
                  <div className="font-semibold text-emerald-300">
                    Connected to {cfg.pageName}
                  </div>
                  <div className="text-xs text-[#a1a1aa] mt-0.5">
                    Page ID {cfg.pageId}
                    {typeof cfg.pageFans === "number" &&
                      ` · ${cfg.pageFans.toLocaleString()} followers`}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-amber-900/20 border border-amber-600/40 rounded-lg text-sm text-amber-200">
                Not connected. Fill in the Page ID and a long-lived Page
                Access Token below to enable scheduling.
              </div>
            )}

            <div>
              <Label>Page ID</Label>
              <Input
                value={pageIdInput}
                onChange={(e) => setPageIdInput(e.target.value)}
                placeholder="e.g. 123456789012345"
              />
              <p className="text-xs text-[#a1a1aa] mt-1.5">
                Find this in your FB Page → About → Page Transparency → Page ID
                (numeric).
              </p>
            </div>

            <div>
              <Label>Page Access Token</Label>
              <Input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={
                  cfg?.hasToken ? `(saved: ${cfg.token})` : "Paste EAAB…"
                }
              />
              <p className="text-xs text-[#a1a1aa] mt-1.5">
                Long-lived token from Business Manager → System Users → Generate
                Token. Needs <code className="text-[#FFE17A]">pages_manage_posts</code> +{" "}
                <code className="text-[#FFE17A]">pages_read_engagement</code>.
                Leave empty to keep the existing one.
              </p>
            </div>

            {error && (
              <div className="p-3 bg-red-900/30 border border-red-700/50 rounded text-sm text-red-300">
                {error}
              </div>
            )}

            <Button onClick={save} disabled={saving} className="w-full">
              {saving ? "Validating with FB…" : "Save & Connect"}
            </Button>
          </PanelBody>
        </Panel>

        <Panel title="Schedule">
          <PanelBody className="space-y-5">
            <div>
              <Label>Timezone</Label>
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Manila"
              />
            </div>

            <div>
              <Label>Peak Hour Slots</Label>
              <div className="space-y-2">
                {peakHours.map((h, i) => {
                  // Display as AM/PM for readability — input stores HH:MM (24h)
                  const [hStr, mStr] = (h || "00:00").split(":");
                  const H = parseInt(hStr, 10) || 0;
                  const M = parseInt(mStr, 10) || 0;
                  const ampm = H >= 12 ? "PM" : "AM";
                  const hour12 = ((H + 11) % 12) + 1;
                  const display = `${hour12}:${String(M).padStart(2, "0")} ${ampm}`;
                  return (
                    <div key={i} className="flex gap-2 items-center">
                      <input
                        type="time"
                        value={h}
                        onChange={(e) => updateSlot(i, e.target.value)}
                        className="flex-1 bg-[#0a0a0c] border border-[#2a2a32] rounded-lg px-4 py-2.5 text-sm text-[#f5f5f7] font-mono focus:outline-none focus:border-[#FFE17A] transition-colors"
                        step={300}
                      />
                      <div className="text-sm text-[#a1a1aa] font-mono w-20 text-right">
                        {display}
                      </div>
                      <button
                        onClick={() => removeSlot(i)}
                        className="px-3 text-[#a1a1aa] hover:text-red-400 transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button
                  onClick={addSlot}
                  className="text-xs text-[#FFE17A] hover:underline"
                >
                  + Add slot
                </button>
              </div>
              <p className="text-xs text-[#a1a1aa] mt-2">
                Posts are distributed across these slots, one card per slot,
                chronologically within each day, capped at <span className="text-[#FFE17A] font-semibold">{dailyCap}</span> per day.
              </p>
            </div>

            <div>
              <Label>Daily Cap</Label>
              <Input
                type="number"
                value={dailyCap}
                onChange={(e) =>
                  setDailyCap(parseInt(e.target.value, 10) || 0)
                }
                min={1}
                max={10}
              />
              <p className="text-xs text-[#a1a1aa] mt-1.5">
                Max posts per day. Should match the number of peak slots.
              </p>
            </div>

            <Button
              onClick={save}
              disabled={saving}
              variant="secondary"
              className="w-full"
            >
              Save Schedule
            </Button>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
};
