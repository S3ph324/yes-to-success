import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getVersion } from "../api";

const items = [
  { to: "/generate", label: "Generate", icon: "⚡" },
  { to: "/gallery", label: "Gallery", icon: "🖼" },
  { to: "/queue", label: "Queue", icon: "📅" },
  { to: "/brand", label: "Brand Kit", icon: "🎨" },
  { to: "/briefs", label: "Content Briefs", icon: "📝" },
  { to: "/characters", label: "Characters", icon: "👥" },
  { to: "/posting", label: "Posting Settings", icon: "📡" },
];

export const Sidebar = () => {
  const [version, setVersion] = useState<string>("…");
  useEffect(() => {
    getVersion()
      .then((v) => setVersion(v.version))
      .catch(() => setVersion("?"));
  }, []);
  return (
    <aside className="w-60 border-r border-[#2a2a32] bg-[#0d0d10] flex flex-col">
      <div className="px-6 py-7 border-b border-[#2a2a32]">
        <div
          className="text-xl font-black italic"
          style={{
            background:
              "linear-gradient(180deg, #FFF1B8 0%, #FFE17A 40%, #C9952B 100%)",
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            letterSpacing: "-0.01em",
            lineHeight: 1,
          }}
        >
          YES TO SUCCESS!
        </div>
        <div className="text-[10px] uppercase tracking-[0.22em] text-[#a1a1aa] mt-2">
          Content Console
        </div>
      </div>

      <nav className="flex-1 p-3">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-3 rounded-lg mb-1 transition-colors text-[14px] ${
                isActive
                  ? "bg-[#FFE17A]/10 text-[#FFE17A] font-medium"
                  : "text-[#a1a1aa] hover:bg-[#1f1f26] hover:text-[#f5f5f7]"
              }`
            }
          >
            <span className="text-base w-5 text-center">{it.icon}</span>
            <span>{it.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-[#2a2a32] text-[11px] text-[#a1a1aa]">
        <div className="mb-1">John Calub Training</div>
        <div className="text-[#FFE17A]/70 font-mono">v{version}</div>
      </div>
    </aside>
  );
};
