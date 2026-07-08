import { fmtDate } from "../lib/format";

type Props = {
  state: string;
  size?: "sm" | "md";
  date?: string | null;
  reason?: string | null;
  /** Number of times this unit's deletion has been postponed by a user. */
  delayCount?: number;
};

const ICON: Record<string, string> = {
  ACTIVE: "●",
  SCHEDULED: "⏱",
  KEPT: "✓",
  DELETING: "◍",
  DELETED: "✓",
  ERROR: "▲",
};

export function StatusPill({
  state,
  size = "md",
  date,
  reason,
  delayCount = 0,
}: Props) {
  const h = size === "sm" ? "h-[18px] text-[9.5px]" : "h-[22px] text-[11px]";
  const base = `inline-flex items-center gap-1.5 rounded-pill px-2.5 font-semibold leading-none tracking-[0.05em] ${h}`;
  // A delayed item is still SCHEDULED under the hood, but it's the result of
  // a human stepping in — call that out separately from the naturally
  // flowing (red) automated countdown so the two read differently at a glance.
  const isDelayed = state === "SCHEDULED" && delayCount > 0;
  const icon = isDelayed ? "⏸" : (ICON[state] ?? "●");

  let cls = "";
  let label: string = state;

  switch (state) {
    case "ACTIVE":
      cls =
        "bg-[rgba(139,150,168,0.12)] border border-[rgba(139,150,168,0.28)] text-ink-mid";
      break;
    case "SCHEDULED":
      if (isDelayed) {
        cls =
          "bg-[rgba(217,168,60,0.14)] border border-[rgba(217,168,60,0.4)] text-state-candidate-ink";
        label = date ? `DELAYED · ${fmtDate(date).toUpperCase()}` : "DELAYED";
      } else {
        cls =
          "bg-[rgba(229,72,77,0.14)] border border-[rgba(229,72,77,0.4)] text-state-scheduled-ink";
        label = date
          ? `SCHEDULED · ${fmtDate(date).toUpperCase()}`
          : "SCHEDULED";
      }
      break;
    case "KEPT":
      cls =
        "bg-[rgba(63,162,111,0.13)] border border-[rgba(63,162,111,0.38)] text-state-kept-ink";
      label = reason ? `KEPT · ${reason.toUpperCase()}` : "KEPT";
      break;
    case "DELETING":
      cls =
        "bg-[rgba(107,116,135,0.1)] border border-[rgba(107,116,135,0.25)] text-state-muted";
      label = "DELETING…";
      break;
    case "DELETED":
      cls =
        "bg-[rgba(107,116,135,0.1)] border border-[rgba(107,116,135,0.25)] text-state-muted";
      break;
    case "ERROR":
      cls =
        "bg-[rgba(247,104,8,0.16)] border border-[rgba(247,104,8,0.5)] text-state-error-ink animate-swp-pulse";
      break;
    default:
      cls =
        "bg-[rgba(139,150,168,0.12)] border border-[rgba(139,150,168,0.28)] text-ink-mid";
  }

  const aria =
    state === "SCHEDULED" && date
      ? `${isDelayed ? "Delayed" : "Scheduled"} for deletion on ${fmtDate(date)}`
      : state.toLowerCase();

  return (
    <span className={`${base} ${cls}`} aria-label={aria}>
      <span aria-hidden className="inline-flex leading-none">
        {icon}
      </span>
      <span className="leading-none">{label}</span>
    </span>
  );
}
