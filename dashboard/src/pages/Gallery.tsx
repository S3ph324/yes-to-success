import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Panel, PanelBody, Label, Select, Badge, PageHeader } from "../components/ui";
import {
  getBatches,
  getBatch,
  setCardApproval,
  deleteCard,
  unpostCard,
  refreshPostStatus,
  assetUrl,
} from "../api";
import type { Batch, BatchCard, Variant, Aspect } from "../types";

const variantColors: Record<Variant, string> = {
  classic: "#C8001E",
  image: "#7C3AED",
  bold: "#F59E0B",
};
const aspectColors: Record<Aspect, string> = {
  "1:1": "#10B981",
  "4:5": "#3B82F6",
  "9:16": "#EC4899",
};

export const Gallery = () => {
  const [search, setSearch] = useSearchParams();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">(
    "all",
  );
  const [openCard, setOpenCard] = useState<BatchCard | null>(null);

  useEffect(() => {
    getBatches().then((bs) => {
      setBatches(bs);
      const requested = search.get("batch");
      const target = requested || bs[0]?.stamp;
      if (target) {
        getBatch(target).then(setBatch);
        if (!requested && target) setSearch({ batch: target });
      }
    });
  }, []);

  const loadBatch = (stamp: string) => {
    setSearch({ batch: stamp });
    getBatch(stamp).then(setBatch);
    setOpenCard(null);
  };

  const setApproval = async (
    card: BatchCard,
    status: "approved" | "rejected" | "pending",
  ) => {
    if (!batch) return;
    await setCardApproval(batch.stamp, card.index, status);
    setBatch({
      ...batch,
      cards: batch.cards.map((c) =>
        c.index === card.index
          ? {
              ...c,
              approved: status === "approved",
              rejected: status === "rejected",
            }
          : c,
      ),
    });
  };

  const cards = batch?.cards || [];
  const visible = cards.filter((c) => {
    if (filter !== "all") {
      if (filter.startsWith("v:") && c.variant !== filter.slice(2)) return false;
      if (filter.startsWith("a:") && c.aspectRatio !== filter.slice(2)) return false;
    }
    if (statusFilter === "approved" && !c.approved) return false;
    if (statusFilter === "rejected" && !c.rejected) return false;
    if (statusFilter === "pending" && (c.approved || c.rejected)) return false;
    return true;
  });

  const approvedCount = cards.filter((c) => c.approved).length;
  const rejectedCount = cards.filter((c) => c.rejected).length;
  const pendingCount = cards.length - approvedCount - rejectedCount;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  };

  const handleDelete = async (card: BatchCard) => {
    if (!batch) return;
    const reallyDelete = confirm(
      `Delete card ${card.cardId || `#${card.index + 1}`}? This will also remove it from Facebook if it was scheduled or posted.`,
    );
    if (!reallyDelete) return;
    await deleteCard(batch.stamp, card.index);
    setBatch({
      ...batch,
      cards: batch.cards.filter((c) => c.index !== card.index),
      count: batch.count - 1,
    });
  };

  const handleUnpost = async (card: BatchCard) => {
    if (!batch) return;
    if (!confirm(`Delete this post from Facebook? The card stays in your gallery and can be re-scheduled.`)) return;
    await unpostCard(batch.stamp, card.index);
    setBatch({
      ...batch,
      cards: batch.cards.map((c) =>
        c.index === card.index
          ? { ...c, scheduled: false, posted: false, approved: true, fbPostId: undefined, fbUrl: undefined, scheduledAt: undefined, postedAt: undefined }
          : c,
      ),
    });
  };

  const handleRefreshStatus = async () => {
    const r = await refreshPostStatus();
    if (batch) {
      const fresh = await getBatch(batch.stamp);
      setBatch(fresh);
    }
    alert(`Refreshed — ${r.updated} card${r.updated === 1 ? "" : "s"} flipped from scheduled to posted.`);
  };

  return (
    <div>
      <PageHeader
        title="Gallery"
        description="Review the cards, approve or reject each, copy the FB caption to post."
        actions={
          <div className="flex gap-2 items-center">
            <button
              onClick={handleRefreshStatus}
              className="text-xs text-[#FFE17A] border border-[#FFE17A]/40 px-3 py-2 rounded hover:bg-[#FFE17A] hover:text-black transition-colors"
              title="Re-check FB to see if scheduled posts have published"
            >
              ↻ Refresh FB status
            </button>
            <div className="w-64">
              <Select
                value={batch?.stamp || ""}
                onChange={(e) => loadBatch(e.target.value)}
              >
                {batches.map((b) => (
                  <option key={b.stamp} value={b.stamp}>
                    {b.stamp} ({b.count})
                  </option>
                ))}
              </Select>
            </div>
          </div>
        }
      />

      {!batch ? (
        <Panel>
          <PanelBody>
            <div className="text-sm text-[#a1a1aa] italic text-center py-12">
              No batches yet. Generate one to see it here.
            </div>
          </PanelBody>
        </Panel>
      ) : (
        <>
          <Panel className="mb-4">
            <PanelBody>
              <div className="flex items-center gap-2 flex-wrap">
                <Label>Status</Label>
                {(
                  [
                    ["all", `All (${cards.length})`, "#374151"],
                    ["pending", `Pending (${pendingCount})`, "#a1a1aa"],
                    ["approved", `Approved (${approvedCount})`, "#10B981"],
                    ["rejected", `Rejected (${rejectedCount})`, "#EF4444"],
                  ] as const
                ).map(([key, label, color]) => (
                  <button
                    key={key}
                    onClick={() => setStatusFilter(key as typeof statusFilter)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                      statusFilter === key
                        ? "bg-[#FFE17A] text-black border-[#FFE17A]"
                        : "bg-[#1f1f26] text-[#a1a1aa] hover:text-white"
                    }`}
                    style={
                      statusFilter !== key
                        ? { borderColor: `${color}40` }
                        : undefined
                    }
                  >
                    {label}
                  </button>
                ))}
                <div className="border-l border-[#2a2a32] mx-2 h-6" />
                <Label>Type</Label>
                {(
                  [
                    ["all", `All`],
                    ["v:classic", "Classic"],
                    ["v:image", "Image"],
                    ["v:bold", "Bold"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                      filter === key
                        ? "bg-[#FFE17A] text-black border-[#FFE17A]"
                        : "bg-[#1f1f26] text-[#a1a1aa] hover:text-white border-[#2a2a32]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <div className="border-l border-[#2a2a32] mx-2 h-6" />
                <Label>Aspect</Label>
                {(["1:1", "4:5", "9:16"] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => setFilter(`a:${a}`)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                      filter === `a:${a}`
                        ? "bg-[#FFE17A] text-black border-[#FFE17A]"
                        : "bg-[#1f1f26] text-[#a1a1aa] hover:text-white border-[#2a2a32]"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </PanelBody>
          </Panel>

          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {visible.map((card) => (
              <div
                key={card.index}
                className={`bg-[#15151a] border rounded-xl overflow-hidden transition-all relative ${
                  card.posted
                    ? "border-emerald-500/80"
                    : card.scheduled
                      ? "border-blue-500/60"
                      : card.failed
                        ? "border-red-500/60"
                        : card.approved
                          ? "border-emerald-600/40"
                          : card.rejected
                            ? "border-red-500/40 opacity-60"
                            : "border-[#2a2a32] hover:border-[#FFE17A]/50"
                }`}
              >
                {/* Status corner badge */}
                {(card.posted || card.scheduled || card.failed) && (
                  <div
                    className={`absolute top-2 right-2 z-10 px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider ${
                      card.posted
                        ? "bg-emerald-600 text-white"
                        : card.scheduled
                          ? "bg-blue-600 text-white"
                          : "bg-red-600 text-white"
                    }`}
                  >
                    {card.posted ? "✅ Posted" : card.scheduled ? "⏰ Scheduled" : "❌ Failed"}
                  </div>
                )}
                <img
                  src={assetUrl(`/api/cards/${batch.stamp}/${encodeURIComponent(card.file)}`)}
                  alt=""
                  loading="lazy"
                  className="w-full bg-black cursor-zoom-in"
                  onClick={() => setOpenCard(card)}
                />
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-mono text-[#FFE17A]/70">
                      {card.cardId || `#${card.index + 1}`}
                    </span>
                    {card.scheduledAt && card.scheduled && (
                      <span className="text-[10px] font-mono text-blue-300">
                        ⏰ {new Date(card.scheduledAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </span>
                    )}
                    {card.postedAt && card.posted && (
                      <span className="text-[10px] font-mono text-emerald-300">
                        ✅ {new Date(card.postedAt).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1.5 flex-wrap mb-2">
                    <Badge color={variantColors[card.variant]}>{card.variant}</Badge>
                    <Badge color={aspectColors[card.aspectRatio]}>{card.aspectRatio}</Badge>
                    {card.theme && <Badge>{card.theme}</Badge>}
                    {card.approved && !card.rejected && (
                      <Badge color="#059669">✓ Approved</Badge>
                    )}
                  </div>
                  <p className="text-[13px] text-[#f5f5f7] leading-snug line-clamp-3 mb-3">
                    {card.quote}
                  </p>
                  {card.caption && (
                    <div className="bg-[#0a0a0c] border-l-2 border-[#FFE17A] rounded p-2.5 mb-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[9px] uppercase tracking-[0.1em] text-[#a1a1aa] font-semibold">FB Caption</span>
                        <button
                          onClick={() => copy(card.caption)}
                          className="text-[10px] font-bold uppercase tracking-wider text-[#FFE17A] border border-[#FFE17A] px-2 py-0.5 rounded hover:bg-[#FFE17A] hover:text-black transition-colors"
                        >
                          Copy
                        </button>
                      </div>
                      <p className="text-[11px] text-[#c8c8d0] leading-snug line-clamp-4 whitespace-pre-wrap">
                        {card.caption}
                      </p>
                    </div>
                  )}
                  <div className="flex gap-2">
                    {/* Approve toggle disabled once a card is scheduled/posted —
                        you'd unpost first to revert. */}
                    <button
                      onClick={() =>
                        setApproval(
                          card,
                          card.status === "approved" ? "pending" : "approved",
                        )
                      }
                      disabled={card.scheduled || card.posted}
                      className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
                        card.approved
                          ? "bg-emerald-600 text-white"
                          : "bg-[#1f1f26] text-[#a1a1aa] hover:bg-emerald-900/50 hover:text-emerald-300 border border-[#2a2a32]"
                      } ${card.scheduled || card.posted ? "opacity-60 cursor-not-allowed" : ""}`}
                      title={card.scheduled || card.posted ? "Already scheduled/posted — unpost first to change approval" : ""}
                    >
                      ✓ {card.approved ? "Approved" : "Approve"}
                    </button>
                    {!(card.scheduled || card.posted) && (
                      <button
                        onClick={() =>
                          setApproval(card, card.rejected ? "pending" : "rejected")
                        }
                        className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
                          card.rejected
                            ? "bg-red-700 text-white"
                            : "bg-[#1f1f26] text-[#a1a1aa] hover:bg-red-900/40 hover:text-red-300 border border-[#2a2a32]"
                        }`}
                      >
                        ✕ {card.rejected ? "Rejected" : "Reject"}
                      </button>
                    )}
                    {/* Unpost button only on posted/scheduled cards */}
                    {(card.posted || card.scheduled) && (
                      <button
                        onClick={() => handleUnpost(card)}
                        className="flex-1 py-2 text-xs font-medium rounded-lg bg-[#1f1f26] text-amber-300 hover:bg-amber-900/30 border border-amber-700/40 transition-colors"
                        title="Delete the post from Facebook (keep card)"
                      >
                        ↶ Unpost
                      </button>
                    )}
                  </div>
                  {/* Always-available delete button (with confirm) */}
                  <button
                    onClick={() => handleDelete(card)}
                    className="w-full mt-2 py-1.5 text-[11px] text-[#a1a1aa] hover:text-red-300 hover:bg-red-900/20 rounded transition-colors"
                  >
                    🗑 Delete card
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Modal */}
      {openCard && batch && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-8 cursor-zoom-out"
          onClick={() => setOpenCard(null)}
        >
          <div
            className="flex gap-6 max-w-full max-h-full"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={assetUrl(`/api/cards/${batch.stamp}/${encodeURIComponent(openCard.file)}`)}
              className="max-w-[60vw] max-h-[88vh] rounded-lg"
            />
            <div className="bg-[#15151a] border border-[#2a2a32] rounded-xl p-6 max-w-sm">
              <div className="flex gap-1.5 mb-3">
                <Badge color={variantColors[openCard.variant]}>{openCard.variant}</Badge>
                <Badge color={aspectColors[openCard.aspectRatio]}>{openCard.aspectRatio}</Badge>
                {openCard.theme && <Badge>{openCard.theme}</Badge>}
              </div>
              <h3 className="font-semibold mb-2">On-card Quote</h3>
              <p className="text-sm text-[#f5f5f7] leading-relaxed mb-4">
                {openCard.quote}
              </p>
              {openCard.caption && (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold">FB Caption</h3>
                    <button
                      onClick={() => copy(openCard.caption)}
                      className="text-[11px] font-bold uppercase tracking-wider text-[#FFE17A] border border-[#FFE17A] px-3 py-1 rounded hover:bg-[#FFE17A] hover:text-black transition-colors"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="text-sm text-[#c8c8d0] leading-relaxed whitespace-pre-wrap bg-[#0a0a0c] border-l-2 border-[#FFE17A] rounded p-3 mb-4">
                    {openCard.caption}
                  </p>
                </>
              )}
              {openCard.bgPrompt && (
                <>
                  <h3 className="font-semibold mb-2 text-xs uppercase tracking-wider text-[#a1a1aa]">
                    BG Prompt
                  </h3>
                  <p className="text-xs text-[#a1a1aa] italic bg-[#1f1f26] rounded p-3 mb-4 leading-relaxed">
                    {openCard.bgPrompt}
                  </p>
                </>
              )}
              <div className="font-mono text-[10px] text-[#a1a1aa] break-all">
                {openCard.file}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
