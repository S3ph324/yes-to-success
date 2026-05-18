import { useEffect, useState } from "react";
import {
  Panel,
  PanelBody,
  Button,
  Badge,
  Label,
  PageHeader,
} from "../components/ui";
import {
  getQueue,
  getHistory,
  scheduleAll,
  scheduleAt,
  postNow,
  assetUrl,
} from "../api";
import type { QueueItem, HistoryItem } from "../api";

const variantColors: Record<string, string> = {
  classic: "#C8001E",
  image: "#7C3AED",
  bold: "#F59E0B",
};
const aspectColors: Record<string, string> = {
  "1:1": "#10B981",
  "4:5": "#3B82F6",
  "9:16": "#EC4899",
};

const statusColors = {
  scheduled: { bg: "bg-blue-900/30", border: "border-blue-600/50", text: "text-blue-300", label: "⏰ Scheduled" },
  posted: { bg: "bg-emerald-900/30", border: "border-emerald-600/50", text: "text-emerald-300", label: "✅ Posted" },
  failed: { bg: "bg-red-900/30", border: "border-red-700/50", text: "text-red-300", label: "❌ Failed" },
};

const fmtLocal = (iso?: string) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

// Build a default "start from" string in local-time form for <input type="datetime-local">.
// Adds 15 minutes to "now" so we're past FB's 10-min minimum by default.
const defaultStartAt = () => {
  const d = new Date(Date.now() + 15 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
};

export const Queue = () => {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [startAt, setStartAt] = useState<string>(defaultStartAt());
  const [cardTimes, setCardTimes] = useState<Record<string, string>>({});

  const refresh = async () => {
    const [q, h] = await Promise.all([getQueue(), getHistory()]);
    setQueue(q);
    setHistory(h);
  };

  useEffect(() => {
    refresh().catch(console.error);
  }, []);

  const handleScheduleAll = async () => {
    if (queue.length === 0) return;
    // Convert the local-time string to an ISO instant.
    const startIso = new Date(startAt).toISOString();
    const startDisplay = new Date(startAt).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    if (
      !confirm(
        `Schedule all ${queue.length} approved cards starting from ${startDisplay}? They'll post automatically on Facebook at your configured peak hours — no need to keep your Mac on.`,
      )
    )
      return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await scheduleAll(startIso);
      setFeedback(
        `✅ Scheduled ${result.scheduled} cards${result.failed ? ` (${result.failed} failed)` : ""}.`,
      );
      await refresh();
    } catch (e) {
      setFeedback(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handlePostNow = async (item: QueueItem) => {
    if (!confirm(`Post this card to Facebook RIGHT NOW?`)) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await postNow(item.stamp, item.index);
      setFeedback(`✅ Posted! ${result.fbUrl}`);
      await refresh();
    } catch (e) {
      setFeedback(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleScheduleAt = async (item: QueueItem) => {
    const key = `${item.stamp}-${item.index}`;
    const local = cardTimes[key];
    if (!local) {
      setFeedback("❌ Pick a date & time for this card first.");
      return;
    }
    const iso = new Date(local).toISOString();
    const disp = new Date(local).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
    if (
      !confirm(
        `Schedule this card to post on Facebook at ${disp}? (Must be at least ~10 minutes from now.)`,
      )
    )
      return;
    setBusy(true);
    setFeedback(null);
    try {
      await scheduleAt(item.stamp, item.index, iso);
      setFeedback(`✅ Scheduled for ${disp}.`);
      await refresh();
    } catch (e) {
      setFeedback(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Queue & Schedule"
        description="Approved cards waiting for slots. Pick a start date/time, then schedule all — they'll auto-post at your configured peak hours."
      />

      <Panel className="mb-6">
        <PanelBody>
          <div className="flex gap-4 items-end flex-wrap">
            <div className="flex-1 min-w-[260px]">
              <Label>Start scheduling from</Label>
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                step={60}
                className="w-full bg-[#0a0a0c] border border-[#2a2a32] rounded-lg px-4 py-2.5 text-sm text-[#f5f5f7] font-mono focus:outline-none focus:border-[#FFE17A] transition-colors"
              />
              <p className="text-xs text-[#a1a1aa] mt-1.5">
                First slot ≥ 10 minutes after this moment (Facebook's minimum
                scheduling lead time). Defaults to ~15 min from now.
              </p>
            </div>
            <Button
              onClick={handleScheduleAll}
              disabled={busy || queue.length === 0}
            >
              {busy ? "Scheduling…" : `⚡ Schedule ${queue.length} Approved`}
            </Button>
          </div>
        </PanelBody>
      </Panel>

      {feedback && (
        <div className="mb-4 p-3 bg-[#1f1f26] border border-[#FFE17A]/40 rounded-lg text-sm font-mono">
          {feedback}
        </div>
      )}

      <Panel title={`Pending in queue (${queue.length})`} className="mb-6">
        <PanelBody>
          {queue.length === 0 ? (
            <div className="text-sm text-[#a1a1aa] italic text-center py-8">
              No approved cards waiting. Approve cards in the Gallery first.
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {queue.map((item) => (
                <div
                  key={`${item.stamp}-${item.index}`}
                  className="flex gap-3 p-3 bg-[#0a0a0c] border border-[#2a2a32] rounded-lg"
                >
                  <img
                    src={assetUrl(`/api/cards/${item.stamp}/${encodeURIComponent(item.file)}`)}
                    className="w-20 h-25 object-cover rounded bg-black flex-shrink-0"
                    style={{ aspectRatio: "4/5" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-mono text-[#FFE17A]/80">
                        {item.cardId || `${item.stamp.slice(-5)}#${String(item.index + 1).padStart(2, "0")}`}
                      </span>
                    </div>
                    <div className="flex gap-1 mb-1.5 flex-wrap">
                      <Badge color={variantColors[item.variant]}>{item.variant}</Badge>
                      <Badge color={aspectColors[item.aspectRatio]}>{item.aspectRatio}</Badge>
                    </div>
                    <p className="text-xs text-[#c8c8d0] line-clamp-2 mb-2 leading-snug">
                      {item.quote}
                    </p>
                    <div className="space-y-1.5">
                      <button
                        onClick={() => handlePostNow(item)}
                        disabled={busy}
                        className="text-[10px] uppercase tracking-wider text-[#FFE17A] border border-[#FFE17A]/40 px-2 py-1 rounded hover:bg-[#FFE17A] hover:text-black transition-colors disabled:opacity-50"
                      >
                        Post Now
                      </button>
                      <input
                        type="datetime-local"
                        value={cardTimes[`${item.stamp}-${item.index}`] || ""}
                        min={defaultStartAt()}
                        step={60}
                        onChange={(e) =>
                          setCardTimes((m) => ({
                            ...m,
                            [`${item.stamp}-${item.index}`]: e.target.value,
                          }))
                        }
                        className="w-full bg-[#0a0a0c] border border-[#2a2a32] rounded px-2 py-1 text-[10px] text-[#f5f5f7] font-mono focus:outline-none focus:border-[#FFE17A] transition-colors"
                      />
                      <button
                        onClick={() => handleScheduleAt(item)}
                        disabled={busy}
                        className="w-full text-[10px] uppercase tracking-wider text-[#3B82F6] border border-[#3B82F6]/40 px-2 py-1 rounded hover:bg-[#3B82F6] hover:text-white transition-colors disabled:opacity-50"
                      >
                        Schedule at this time
                      </button>
                      <p className="text-[9px] text-[#a1a1aa] leading-tight">
                        Optional: post this one card at an exact time. Leave
                        blank to use “Schedule {queue.length} Approved” above.
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel title={`Scheduled & posted history (${history.length})`}>
        <PanelBody>
          {history.length === 0 ? (
            <div className="text-sm text-[#a1a1aa] italic text-center py-8">
              No scheduled or posted cards yet.
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((item) => {
                const colors = statusColors[item.status];
                return (
                  <div
                    key={`${item.stamp}-${item.index}`}
                    className={`flex gap-3 p-3 rounded-lg border ${colors.bg} ${colors.border}`}
                  >
                    <img
                      src={assetUrl(`/api/cards/${item.stamp}/${encodeURIComponent(item.file)}`)}
                      className="w-16 h-20 object-cover rounded bg-black flex-shrink-0"
                      style={{ aspectRatio: "4/5" }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex gap-1.5 items-center mb-1 flex-wrap">
                        <span className={`text-xs font-semibold ${colors.text}`}>
                          {colors.label}
                        </span>
                        <span className="text-[10px] font-mono text-[#FFE17A]/80">
                          {item.cardId || `${item.stamp.slice(-5)}#${String(item.index + 1).padStart(2, "0")}`}
                        </span>
                        <Badge color={variantColors[item.variant]}>{item.variant}</Badge>
                        <Badge color={aspectColors[item.aspectRatio]}>{item.aspectRatio}</Badge>
                        <span className="text-[10px] text-[#a1a1aa] ml-auto font-mono">
                          {fmtLocal(item.scheduledAt || item.postedAt)}
                        </span>
                      </div>
                      <p className="text-xs text-[#c8c8d0] line-clamp-2 leading-snug mb-1">
                        {item.quote}
                      </p>
                      {item.fbUrl && (
                        <a
                          href={item.fbUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-[#FFE17A] hover:underline font-mono"
                        >
                          {item.fbUrl} ↗
                        </a>
                      )}
                      {item.error && (
                        <div className="text-[11px] text-red-400 font-mono mt-1">
                          {item.error}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
};
