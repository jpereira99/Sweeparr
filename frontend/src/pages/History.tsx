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
        <div className="flex flex-col gap-1">
          {entries.map((e: any, i: number) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded border border-line-subtle bg-bg px-3 py-2 font-mono text-[11px] text-ink-mid"
            >
              <span className="text-ink-low">{fmtDateTime(e.ts)}</span>
              <span
                className={`font-semibold ${ACTION_COLOR[e.action] ?? "text-ink-mid"}`}
              >
                {e.action}
              </span>
              <span className="text-ink-hi">
                {e.detail?.title ??
                  e.detail?.rule ??
                  `#${e.unit_id ?? e.media_item_id ?? ""}`}
              </span>
              {e.detail?.bytes_freed != null && (
                <span className="text-ink-hi">
                  {gb(e.detail.bytes_freed / 1024 ** 3)}
                </span>
              )}
              {e.detail?.rule && (
                <span className="text-ink-low">· rule: {e.detail.rule}</span>
              )}
              {e.detail?.by && (
                <span className="text-ink-low">· by {e.detail.by}</span>
              )}
              <span className="ml-auto text-ink-faint">
                {e.actor === "system" ? "system" : `user ${e.actor}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
