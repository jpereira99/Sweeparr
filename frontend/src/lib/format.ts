export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Countdown urgency is also worded — "TONIGHT", not just filled-red (§09). */
export function countdown(daysUntil?: number | null): { label: string; urgent: boolean } {
  if (daysUntil == null) return { label: "held", urgent: false };
  if (daysUntil <= 0.7) return { label: "TONIGHT", urgent: true };
  const d = Math.round(daysUntil);
  return { label: `in ${d}d`, urgent: d <= 2 };
}

export function gb(n?: number | null): string {
  if (n == null) return "—";
  if (n >= 1024) return `${(n / 1024).toFixed(1)} TB`;
  return `${n.toFixed(1)} GB`;
}

export function relDays(days?: number | null): string {
  if (days == null) return "never";
  if (days === 0) return "today";
  return `${Math.round(days)}d ago`;
}
