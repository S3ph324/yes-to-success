import { useEffect, useRef, useState } from "react";
import { Panel, PanelBody, Button, Label, Input, PageHeader } from "../components/ui";
import {
  getCharacters,
  saveCharacter,
  deleteCharacter,
  uploadCharacterPhoto,
  assetUrl,
} from "../api";
import type { Character } from "../types";

const newCharacter = (): Character => ({
  id: `char_${Date.now()}`,
  name: "New Character",
  role: "",
  tags: [],
  photos: [],
  enabled: true,
});

export const Characters = () => {
  const [chars, setChars] = useState<Character[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getCharacters()
      .then((c) => {
        setChars(c);
        if (c.length > 0) setActiveId(c[0].id);
      })
      .catch(console.error);
  }, []);

  const active = chars.find((c) => c.id === activeId);

  const update = (patch: Partial<Character>) => {
    if (!active) return;
    const updated = { ...active, ...patch };
    setChars((prev) =>
      prev.map((c) => (c.id === active.id ? updated : c)),
    );
    saveCharacter(updated).catch(console.error);
  };

  const addChar = async () => {
    const nc = newCharacter();
    await saveCharacter(nc);
    setChars((prev) => [...prev, nc]);
    setActiveId(nc.id);
  };

  const remove = async (id: string) => {
    await deleteCharacter(id);
    setChars((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(chars[0]?.id || null);
  };

  const uploadPhoto = async (file: File) => {
    if (!active) return;
    const { path } = await uploadCharacterPhoto(active.id, file);
    update({ photos: [...active.photos, path] });
  };

  return (
    <div>
      <PageHeader
        title="Characters"
        description="Reference photos of people you want to appear in AI-generated backgrounds. Tag as enabled to make available for image gen."
        actions={
          <Button variant="secondary" onClick={addChar}>
            + New Character
          </Button>
        }
      />

      <div className="grid grid-cols-[240px_1fr] gap-6">
        <Panel>
          <PanelBody>
            <Label>Library</Label>
            <div className="space-y-1">
              {chars.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors flex items-center gap-3 ${
                    c.id === activeId
                      ? "bg-[#FFE17A]/10 text-[#FFE17A] font-medium"
                      : "text-[#a1a1aa] hover:bg-[#1f1f26] hover:text-[#f5f5f7]"
                  }`}
                >
                  <div className="w-9 h-9 rounded-full bg-[#1f1f26] border border-[#2a2a32] overflow-hidden flex items-center justify-center text-xs">
                    {c.photos[0] ? (
                      <img src={assetUrl(`/uploads/${c.photos[0]}`)} className="w-full h-full object-cover" />
                    ) : (
                      "👤"
                    )}
                  </div>
                  <div className="flex-1 truncate">{c.name}</div>
                  {c.enabled && (
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                  )}
                </button>
              ))}
              {chars.length === 0 && (
                <div className="text-sm text-[#a1a1aa] italic py-4 text-center">
                  No characters yet
                </div>
              )}
            </div>
          </PanelBody>
        </Panel>

        <Panel title="Character">
          <PanelBody className="space-y-5">
            {!active && (
              <div className="text-sm text-[#a1a1aa] italic">
                Select a character to edit.
              </div>
            )}
            {active && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Name</Label>
                    <Input
                      value={active.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Role</Label>
                    <Input
                      value={active.role}
                      onChange={(e) => update({ role: e.target.value })}
                      placeholder="e.g. Coach, Student testimonial, Family"
                    />
                  </div>
                </div>

                <div>
                  <Label>Tags (comma-separated)</Label>
                  <Input
                    value={active.tags.join(", ")}
                    onChange={(e) =>
                      update({
                        tags: e.target.value
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="trading, biohacking, hero"
                  />
                </div>

                <div className="flex items-center gap-3 p-3 bg-[#0a0a0c] border border-[#2a2a32] rounded-lg">
                  <input
                    type="checkbox"
                    id="enabled"
                    checked={active.enabled}
                    onChange={(e) => update({ enabled: e.target.checked })}
                    className="w-4 h-4 accent-[#FFE17A]"
                  />
                  <label htmlFor="enabled" className="text-sm flex-1">
                    Available for image generation
                  </label>
                </div>

                <div>
                  <Label>Reference Photos</Label>
                  <div className="grid grid-cols-4 gap-3">
                    {active.photos.map((p, i) => (
                      <div
                        key={i}
                        className="aspect-square bg-[#0a0a0c] border border-[#2a2a32] rounded-lg overflow-hidden relative group"
                      >
                        <img
                          src={assetUrl(`/uploads/${p}`)}
                          className="w-full h-full object-cover"
                        />
                        <button
                          onClick={() => {
                            update({
                              photos: active.photos.filter((_, j) => j !== i),
                            });
                          }}
                          className="absolute top-1 right-1 bg-red-900/80 hover:bg-red-900 text-white text-xs w-6 h-6 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="aspect-square bg-[#0a0a0c] border-2 border-dashed border-[#2a2a32] rounded-lg flex flex-col items-center justify-center text-[#a1a1aa] hover:border-[#FFE17A] hover:text-[#FFE17A] transition-colors"
                    >
                      <span className="text-2xl">+</span>
                      <span className="text-xs mt-1">Add photo</span>
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadPhoto(f);
                    }}
                  />
                </div>

                <div className="pt-4 border-t border-[#2a2a32]">
                  <Button
                    variant="danger"
                    onClick={() => active && remove(active.id)}
                  >
                    Delete Character
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
