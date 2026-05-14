import { useEffect, useRef, useState } from "react";
import { Panel, PanelBody, Button, Label, Input, PageHeader } from "../components/ui";
import { getBrand, saveBrand, uploadLogo, assetUrl } from "../api";
import type { BrandPreset } from "../types";

const newPresetTemplate = (): BrandPreset => ({
  id: `preset_${Date.now()}`,
  name: "New Brand",
  logoSrc: "yes-to-success-logo.png",
  brandPrimary: "#C8001E",
  brandDeep: "#3A0008",
  brandAccent: "#FFE17A",
  brandAccentDeep: "#C9952B",
  url: "JOHNCALUBTRAINING.COM",
  signoff: "— John Calub",
  subtitle: "Philippines' #1 Success Coach",
});

const Swatch = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) => (
  <div>
    <Label>{label}</Label>
    <div className="flex items-center gap-3">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-12 h-10 rounded border border-[#2a2a32] cursor-pointer bg-transparent"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono uppercase"
        maxLength={7}
      />
    </div>
  </div>
);

export const BrandKit = () => {
  const [presets, setPresets] = useState<BrandPreset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getBrand()
      .then((p) => {
        setPresets(p);
        if (p.length > 0) setActiveId(p[0].id);
      })
      .catch(console.error);
  }, []);

  const active = presets.find((p) => p.id === activeId);

  const updateActive = (patch: Partial<BrandPreset>) => {
    if (!active) return;
    setPresets((prev) =>
      prev.map((p) => (p.id === active.id ? { ...p, ...patch } : p)),
    );
  };

  const handleSave = async () => {
    if (!active) return;
    setSaving(true);
    try {
      await saveBrand(active);
    } finally {
      setSaving(false);
    }
  };

  const handleAddPreset = () => {
    const np = newPresetTemplate();
    setPresets((prev) => [...prev, np]);
    setActiveId(np.id);
  };

  const handleLogoUpload = async (file: File) => {
    if (!active) return;
    const { logoSrc } = await uploadLogo(active.id, file);
    updateActive({ logoSrc });
  };

  return (
    <div>
      <PageHeader
        title="Brand Kit"
        description="Manage logo, colors, signoff per account. The active preset is used for the next batch."
        actions={
          <>
            <Button variant="secondary" onClick={handleAddPreset}>
              + New Preset
            </Button>
            <Button onClick={handleSave} disabled={!active || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-[240px_1fr_320px] gap-6">
        {/* Preset list */}
        <Panel>
          <PanelBody>
            <Label>Presets</Label>
            <div className="space-y-1">
              {presets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setActiveId(p.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    p.id === activeId
                      ? "bg-[#FFE17A]/10 text-[#FFE17A] font-medium"
                      : "text-[#a1a1aa] hover:bg-[#1f1f26] hover:text-[#f5f5f7]"
                  }`}
                >
                  {p.name}
                </button>
              ))}
              {presets.length === 0 && (
                <div className="text-sm text-[#a1a1aa] italic py-4 text-center">
                  No presets yet
                </div>
              )}
            </div>
          </PanelBody>
        </Panel>

        {/* Edit form */}
        <Panel title="Settings">
          <PanelBody className="space-y-5">
            {!active && (
              <div className="text-sm text-[#a1a1aa] italic">
                Select a preset to edit.
              </div>
            )}
            {active && (
              <>
                <div>
                  <Label>Preset Name</Label>
                  <Input
                    value={active.name}
                    onChange={(e) => updateActive({ name: e.target.value })}
                  />
                </div>

                <div>
                  <Label>Logo</Label>
                  <div className="flex items-center gap-3">
                    <div className="w-28 h-28 bg-[#0a0a0c] border border-[#2a2a32] rounded-lg flex items-center justify-center p-2">
                      {active.logoSrc ? (
                        <img
                          src={assetUrl(`/uploads/${active.logoSrc}`)}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = assetUrl(`/api/static/${active.logoSrc}`);
                          }}
                          alt=""
                          className="max-w-full max-h-full object-contain"
                        />
                      ) : (
                        <div className="text-[10px] text-[#a1a1aa]">No logo</div>
                      )}
                    </div>
                    <div className="flex-1">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleLogoUpload(f);
                        }}
                      />
                      <Button
                        variant="secondary"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Upload Logo
                      </Button>
                      <div className="text-xs text-[#a1a1aa] mt-2 font-mono">
                        {active.logoSrc}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <Swatch
                    label="Brand Primary (Red)"
                    value={active.brandPrimary}
                    onChange={(v) => updateActive({ brandPrimary: v })}
                  />
                  <Swatch
                    label="Brand Deep"
                    value={active.brandDeep}
                    onChange={(v) => updateActive({ brandDeep: v })}
                  />
                  <Swatch
                    label="Accent (Gold)"
                    value={active.brandAccent}
                    onChange={(v) => updateActive({ brandAccent: v })}
                  />
                  <Swatch
                    label="Accent Deep"
                    value={active.brandAccentDeep}
                    onChange={(v) => updateActive({ brandAccentDeep: v })}
                  />
                </div>

                <div>
                  <Label>URL / Handle (shown at bottom of card)</Label>
                  <Input
                    value={active.url}
                    onChange={(e) => updateActive({ url: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Signoff</Label>
                    <Input
                      value={active.signoff}
                      onChange={(e) => updateActive({ signoff: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Subtitle</Label>
                    <Input
                      value={active.subtitle}
                      onChange={(e) => updateActive({ subtitle: e.target.value })}
                    />
                  </div>
                </div>
              </>
            )}
          </PanelBody>
        </Panel>

        {/* Live preview */}
        <Panel title="Preview">
          <PanelBody>
            {active && (
              <div
                className="rounded-lg overflow-hidden border border-[#2a2a32]"
                style={{
                  background: `radial-gradient(ellipse at 50% 35%, ${active.brandPrimary} 0%, ${active.brandDeep} 100%)`,
                  aspectRatio: "4/5",
                  padding: 24,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "space-between",
                  position: "relative",
                }}
              >
                <div style={{ height: 60, display: "flex", alignItems: "center" }}>
                  {active.logoSrc ? (
                    <img
                      src={assetUrl(`/uploads/${active.logoSrc}`)}
                      onError={(e) => {
                        (e.target as HTMLImageElement).src = assetUrl(`/api/static/${active.logoSrc}`);
                      }}
                      alt=""
                      style={{ maxHeight: 56, maxWidth: 200, objectFit: "contain" }}
                    />
                  ) : (
                    <span
                      style={{
                        fontFamily: "Georgia, serif",
                        fontWeight: 900,
                        fontStyle: "italic",
                        fontSize: 22,
                        color: active.brandAccent,
                      }}
                    >
                      YES TO SUCCESS!
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontFamily: "Georgia, serif",
                    color: "#FFF8E7",
                    textAlign: "center",
                    fontSize: 16,
                    fontWeight: 700,
                    lineHeight: 1.3,
                  }}
                >
                  Love is the most powerful money magnet in the world!
                </div>
                <div style={{ textAlign: "center" }}>
                  <div
                    style={{
                      fontFamily: "Georgia, serif",
                      fontStyle: "italic",
                      fontWeight: 700,
                      color: active.brandAccent,
                      fontSize: 14,
                    }}
                  >
                    {active.signoff}
                  </div>
                  <div
                    style={{
                      fontSize: 8,
                      letterSpacing: "0.2em",
                      color: "#FFF8E7",
                      textTransform: "uppercase",
                      marginTop: 4,
                    }}
                  >
                    {active.subtitle}
                  </div>
                  <div
                    style={{
                      fontSize: 7,
                      letterSpacing: "0.3em",
                      color: `${active.brandAccent}80`,
                      marginTop: 8,
                    }}
                  >
                    {active.url}
                  </div>
                </div>
              </div>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
};
