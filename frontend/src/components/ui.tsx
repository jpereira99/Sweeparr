import { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-line-subtle bg-bg p-5 ${className}`}>{children}</div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
      {children}
    </div>
  );
}

export function Poster({ size = 40 }: { size?: number }) {
  return (
    <span
      className="poster-placeholder inline-block flex-none rounded border border-line"
      style={{ width: size, height: size * 1.5 }}
    />
  );
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>;
}

type BtnProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "keep" | "danger" | "warn";
  disabled?: boolean;
  size?: "sm" | "md";
  title?: string;
};

export function Button({ children, onClick, variant = "ghost", disabled, size = "md", title }: BtnProps) {
  const h = size === "sm" ? "h-[26px] text-[11.5px] px-2.5" : "h-8 px-3.5 text-[12.5px]";
  const styles: Record<string, string> = {
    primary: "bg-accent text-bg font-semibold hover:bg-accent-hover",
    ghost: "border border-line text-ink-mid hover:text-ink-hi hover:border-ink-low",
    keep: "bg-[rgba(63,162,111,0.16)] border border-[rgba(63,162,111,0.45)] text-state-kept-ink font-semibold",
    danger: "bg-[rgba(229,72,77,0.14)] border border-[rgba(229,72,77,0.45)] text-state-scheduled-ink font-semibold",
    warn: "border border-[rgba(247,104,8,0.5)] text-state-error-ink font-semibold",
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded ${h} ${styles[variant]} transition-colors disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-pill border px-3 py-1 text-[12px] transition-colors ${
        active
          ? "border-[rgba(91,141,239,0.4)] bg-accent-subtle text-ink-hi"
          : "border-line text-ink-mid hover:text-ink-hi"
      }`}
    >
      {children}
    </button>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="relative h-[18px] w-[34px] rounded-pill transition-colors"
      style={{ background: on ? "#D9A83C" : "#232B3D" }}
    >
      <span
        className="absolute top-[2px] h-[14px] w-[14px] rounded-pill transition-all"
        style={{ background: on ? "#0C0F16" : "#5E6A80", left: on ? "18px" : "2px" }}
      />
    </button>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line p-5 text-center">
      <div className="mb-1 text-[13px] font-medium text-ink-hi">{title}</div>
      <div className="text-[12px] leading-relaxed text-ink-mid">{children}</div>
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-10 rounded animate-swp-shimmer"
          style={{
            background: "linear-gradient(90deg,#121722 25%,#1A2130 50%,#121722 75%)",
            backgroundSize: "400px 100%",
          }}
        />
      ))}
    </div>
  );
}
