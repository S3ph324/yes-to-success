import { useEffect, useState } from "react";
import { Panel, PanelBody, Button, Label, Input, Textarea, PageHeader } from "../components/ui";
import { getBriefs, saveBrief, deleteBrief } from "../api";
import type { Brief } from "../types";

const newBrief = (): Brief => ({
  id: `brief_${Date.now()}`,
  name: "New Brief",
  topics: ["trading", "yes-to-success", "biohacking"],
  voiceNotes: "",
  bannedPhrases: [],
  activeCampaigns: "",
});

export const Briefs = () => {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getBriefs()
      .then((b) => {
        setBriefs(b);
        if (b.length > 0) setActiveId(b[0].id);
      })
      .catch(console.error);
  }, []);

  const active = briefs.find((b) => b.id === activeId);

  const update = (patch: Partial<Brief>) => {
    if (!active) return;
    setBriefs((prev) =>
      prev.map((b) => (b.id === active.id ? { ...b, ...patch } : b)),
    );
  };

  const save = async () => {
    if (!active) return;
    setSaving(true);
    try {
      await saveBrief(active);
    } finally {
      setSaving(false);
    }
  };

  const addBrief = () => {
    const nb = newBrief();
    setBriefs((prev) => [...prev, nb]);
    setActiveId(nb.id);
  };

  const remove = async (id: string) => {
    await deleteBrief(id);
    setBriefs((prev) => prev.filter((b) => b.id !== id));
    if (activeId === id) setActiveId(briefs[0]?.id || null);
  };

  return (
    <div>
      <PageHeader
        title="Content Briefs"
        description="Topics, voice notes, and banned phrases. The active brief is injected into Gemini's system prompt for the next batch."
        actions={
          <>
            <Button variant="secondary" onClick={addBrief}>
              + New Brief
            </Button>
            <Button onClick={save} disabled={!active || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-[240px_1fr] gap-6">
        <Panel>
          <PanelBody>
            <Label>Briefs</Label>
            <div className="space-y-1">
              {briefs.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setActiveId(b.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    b.id === activeId
                      ? "bg-[#FFE17A]/10 text-[#FFE17A] font-medium"
                      : "text-[#a1a1aa] hover:bg-[#1f1f26] hover:text-[#f5f5f7]"
                  }`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </PanelBody>
        </Panel>

        <Panel title="Brief">
          <PanelBody className="space-y-5">
            {!active && (
              <div className="text-sm text-[#a1a1aa] italic">
                Select a brief to edit.
              </div>
            )}
            {active && (
              <>
                <div>
                  <Label>Name</Label>
                  <Input
                    value={active.name}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                </div>

                <div>
                  <Label>Topics / Pillars (comma-separated)</Label>
                  <Input
                    value={active.topics.join(", ")}
                    onChange={(e) =>
                      update({
                        topics: e.target.value
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="trading, yes-to-success, biohacking"
                  />
                  <p className="text-xs text-[#a1a1aa] mt-1.5">
                    Themes Gemini rotates across when generating quotes.
                  </p>
                </div>

                <div>
                  <Label>Voice Notes (free-form, fed into system prompt)</Label>
                  <Textarea
                    rows={8}
                    value={active.voiceNotes}
                    onChange={(e) => update({ voiceNotes: e.target.value })}
                    placeholder="E.g. Lean heavier on trading content this week. Mention the Master Your Mind workshop on May 25 in 1 in 5 captions."
                  />
                </div>

                <div>
                  <Label>Banned Phrases (one per line, hard rules)</Label>
                  <Textarea
                    rows={5}
                    value={active.bannedPhrases.join("\n")}
                    onChange={(e) =>
                      update({
                        bannedPhrases: e.target.value
                          .split("\n")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder={"walang kwentang trabaho\ntamad ka\nguaranteed income"}
                  />
                </div>

                <div>
                  <Label>Active Campaigns (occasional CTA targets)</Label>
                  <Textarea
                    rows={3}
                    value={active.activeCampaigns}
                    onChange={(e) =>
                      update({ activeCampaigns: e.target.value })
                    }
                    placeholder="E.g. Master Your Mind workshop, May 25 — link in bio"
                  />
                </div>

                <div className="pt-4 border-t border-[#2a2a32]">
                  <Button
                    variant="danger"
                    onClick={() => active && remove(active.id)}
                  >
                    Delete Brief
                  </Button>
                </div>
              </>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
};
