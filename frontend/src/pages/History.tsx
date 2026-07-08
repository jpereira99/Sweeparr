import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Chip, Skeleton, EmptyState } from "../components/ui";
import { fmtDateTime, gb } from "../lib/format";

const FILTERS: { id?: string; label: string }[] = [
  { id: undefined, label: "all" },
  { id: "deleted", label: "deletions" },
  { id: "kept", label: "keeps" },
  { id: "delayed", label: "delays" },
  { id: "scheduled", label: "scheduled" },
  { id: "rule_disabled", label: "rule changes" },
];

const ACTION_COLOR: Record<string, string> = {
  deleted: "text-state-muted",
  kept: "text-state-kept-ink",
  delayed: "text-state-scheduled-ink",
  scheduled: "text-state-scheduled-ink",
  rule_disabled: "text-ink-mid",
  error: "text-state-error-ink",
};

export function History() {
  const [action, setAction] = useState<string | undefined>(undefined);
  const { data, isLoading } = useQuery({
    queryKey: ["history", action],
    queryFn: () => endpoints.history(action),
  });
  const entries = data?.entries ?? [];

  return (
    <div>
      <PageHeader
        title="History"
        subtitle="immutable audit log + deleted-items ledger — the 'wait, where did X go?' answer"
      />
      <div className="mb-3 flex items-center gap-2">
        {FILTERS.map((f) => (
          <Chip
            key={f.label}
            active={action === f.id}
            onClick={() => setAction(f.id)}
          >
            {f.label}
          </Chip>
        ))}
        <span className="ml-auto font-mono text-[12px] text-chart-2">
          {gb(data?.total_freed_gb)} freed (shown)
        </span>
      </div>
      {isLoading ? (
        <Skeleton rows={8} />
      ) : entries.length === 0 ? (
        <EmptyState title="No history yet">
          Actions taken by rules and admins are logged here.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-bg">
          <div
            className={`grid ${COLS} items-center gap-x-3 border-b border-line-subtle bg-bg-raised px-6 py-2`}
          >
            {["WHEN", "ACTION", "TITLE", "TYPE", "DETAIL", "ACTOR"].map(
              (h, i) => (
                <span
                  key={h}
                  className={`text-[10.5px] font-semibold tracking-[0.08em] text-ink-low ${i === 5 ? "text-right" : ""}`}
                >
                  {h}
                </span>
              ),
            )}
          </div>
          {entries.map((e: any, i: number) => (
            <div
              key={i}
              className={`grid ${COLS} items-center gap-x-3 border-b border-[#141A26] px-6 py-2 text-[11.5px]`}
            >
              <span className="font-mono text-[11px] text-ink-low">
                {fmtDateTime(e.ts)}
              </span>
              <span
                className={`font-mono font-semibold ${ACTION_COLOR[e.action] ?? "text-ink-mid"}`}
              >
                {e.action}
              </span>
              <span className="truncate text-ink-hi">
                {e.title ?? `#${e.unit_id ?? e.media_item_id ?? ""}`}
              </span>
              <span className="font-mono text-[11px] uppercase text-ink-mid">
                {e.unit_type === "season"
                  ? "TV"
                  : e.unit_type === "movie"
                    ? "MOV"
                    : "—"}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ink-mid">
                {e.detail?.bytes_freed != null && (
                  <span className="font-mono text-ink-hi">
                    {gb(e.detail.bytes_freed / 1024 ** 3)}
                  </span>
                )}
                {e.detail?.rule && (
                  <span className="text-ink-low">rule: {e.detail.rule}</span>
                )}
                {e.detail?.days != null && (
                  <span className="text-ink-low">+{e.detail.days}d</span>
                )}
                {e.detail?.by && (
                  <span className="text-ink-low">by {e.detail.by}</span>
                )}
                {e.detail?.error && (
                  <span className="truncate text-state-error-ink">
                    {e.detail.error}
                  </span>
                )}
              </span>
              <span className="text-right font-mono text-[11px] text-ink-faint">
                {e.actor === "system" ? "system" : `user ${e.actor}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const COLS =
  "grid-cols-[150px_100px_minmax(160px,1.4fr)_56px_minmax(140px,1.2fr)_120px]";
