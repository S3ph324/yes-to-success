import type { ReactNode, HTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from "react";

export const Panel = ({
  children,
  className = "",
  title,
  description,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { title?: string; description?: string }) => (
  <div
    className={`bg-[#15151a] border border-[#2a2a32] rounded-xl ${className}`}
    {...rest}
  >
    {(title || description) && (
      <div className="px-6 py-5 border-b border-[#2a2a32]">
        {title && <h2 className="text-lg font-semibold tracking-tight">{title}</h2>}
        {description && (
          <p className="text-sm text-[#a1a1aa] mt-1">{description}</p>
        )}
      </div>
    )}
    {children}
  </div>
);

export const PanelBody = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`px-6 py-5 ${className}`}>{children}</div>
);

export const Button = ({
  variant = "primary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) => {
  const base =
    "inline-flex items-center justify-center gap-2 font-medium rounded-lg px-4 py-2.5 text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed";
  const styles = {
    primary:
      "text-black hover:brightness-105 active:brightness-95 shadow",
    secondary:
      "bg-[#1f1f26] text-[#f5f5f7] hover:bg-[#2a2a32] border border-[#2a2a32]",
    ghost:
      "bg-transparent text-[#a1a1aa] hover:text-[#f5f5f7] hover:bg-[#1f1f26]",
    danger:
      "bg-red-900/30 text-red-300 hover:bg-red-900/50 border border-red-900/60",
  };
  const primaryBg =
    variant === "primary"
      ? "linear-gradient(180deg, #FFF1B8 0%, #FFE17A 40%, #C9952B 100%)"
      : undefined;
  return (
    <button
      className={`${base} ${styles[variant]} ${className}`}
      style={primaryBg ? { background: primaryBg } : undefined}
      {...rest}
    >
      {children}
    </button>
  );
};

export const Label = ({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) => (
  <label
    htmlFor={htmlFor}
    className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a1a1aa] mb-2"
  >
    {children}
  </label>
);

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    className={`w-full bg-[#0a0a0c] border border-[#2a2a32] rounded-lg px-4 py-2.5 text-sm text-[#f5f5f7] focus:outline-none focus:border-[#FFE17A] transition-colors ${props.className || ""}`}
  />
);

export const Textarea = (props: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    {...props}
    className={`w-full bg-[#0a0a0c] border border-[#2a2a32] rounded-lg px-4 py-3 text-sm text-[#f5f5f7] focus:outline-none focus:border-[#FFE17A] transition-colors font-mono leading-relaxed ${props.className || ""}`}
  />
);

export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select
    {...props}
    className={`w-full bg-[#0a0a0c] border border-[#2a2a32] rounded-lg px-4 py-2.5 text-sm text-[#f5f5f7] focus:outline-none focus:border-[#FFE17A] transition-colors ${props.className || ""}`}
  />
);

export const Badge = ({
  color,
  children,
}: {
  color?: string;
  children: ReactNode;
}) => (
  <span
    className="inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase tracking-[0.06em] font-semibold text-white"
    style={{ background: color || "#374151" }}
  >
    {children}
  </span>
);

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <div className="flex items-end justify-between mb-6">
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {description && (
        <p className="text-sm text-[#a1a1aa] mt-1.5 max-w-2xl">{description}</p>
      )}
    </div>
    {actions && <div className="flex gap-2">{actions}</div>}
  </div>
);
