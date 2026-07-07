import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Skeleton, EmptyState } from "../components/ui";
import { StatusPill } from "../components/StatusPill";
import { gb, relDays } from "../lib/format";
import { Drawer } from "../components/Drawer";

type SortKey =
  | "title"
  | "type"
  | "last_watched"
  | "total_plays"
  | "distinct_watchers"
  | "completion"
  | "size"
  | "gb_per_hour";
type TypeFilter = "all" | "movie" | "series";

const COLUMNS: {
  id: SortKey | "state";
  label: string;
  sort?: SortKey;
  align?: "left" | "right";
  filterType?: boolean;
}[] = [
  { id: "type", label: "TYPE", filterType: true },
  { id: "title", label: "TITLE", sort: "title" },
  {
    id: "last_watched",
    label: "LAST WATCHED",
    sort: "last_watched",
    align: "right",
  },
  { id: "total_plays", label: "PLAYS", sort: "total_plays", align: "right" },
  {
    id: "distinct_watchers",
    label: "WHO",
    sort: "distinct_watchers",
    align: "right",
  },
  { id: "completion", label: "COMPL.", sort: "completion", align: "right" },
  { id: "size", label: "SIZE", sort: "size", align: "right" },
  { id: "gb_per_hour", label: "GB/HR", sort: "gb_per_hour", align: "right" },
  { id: "state", label: "STATE · SEASONS" },
];

const cols =
  "grid-cols-[52px_minmax(160px,1.5fr)_minmax(96px,1fr)_minmax(56px,0.65fr)_minmax(52px,0.6fr)_minmax(64px,0.7fr)_minmax(72px,0.75fr)_minmax(72px,0.8fr)_minmax(100px,1.1fr)]";
const row = `col-span-full grid grid-cols-subgrid ${cols} gap-x-3 px-6`;

export function Explorer() {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<SortKey>("gb_per_hour");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [drawerId, setDrawerId] = useState<number | null>(null);

  const params = new URLSearchParams({ sort, order });
  if (typeFilter !== "all") params.set("type", typeFilter);
  const { data, isLoading } = useQuery({
    queryKey: ["media", params.toString()],
    queryFn: () => endpoints.media(`?${params}`),
  });
  const items = data?.items ?? [];

  function toggleSort(next: SortKey) {
    if (sort === next) {
      setOrder((o) => (o === "desc" ? "asc" : "desc"));
    } else {
      setSort(next);
      setOrder(next === "title" || next === "type" ? "asc" : "desc");
    }
  }

  function cycleTypeFilter() {
    setTypeFilter((t) =>
      t === "all" ? "movie" : t === "movie" ? "series" : "all",
    );
  }

  return (
    <div>
      <PageHeader
        title="Media Explorer"
        subtitle={`the whole library, sortable by "is it worth its disk?"`}
      />

      {isLoading ? (
        <Skeleton rows={8} />
      ) : items.length === 0 ? (
        <EmptyState title="No items match">
          {typeFilter !== "all"
            ? "Clear the type filter or try a different sort."
            : "Nothing in the library yet."}
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-bg">
          <div className={`grid w-full ${cols}`}>
            <div className={`${row} border-b border-line-subtle py-2`}>
              {COLUMNS.map((col) => (
                <ColumnHeader
                  key={col.id}
                  col={col}
                  sort={sort}
                  order={order}
                  typeFilter={typeFilter}
                  onSort={toggleSort}
                  onTypeFilter={cycleTypeFilter}
                />
              ))}
            </div>
            {items.map((it: any) => (
              <div
                key={it.media_item_id}
                role="button"
                tabIndex={0}
                onClick={() => setDrawerId(it.media_item_id)}
                onKeyDown={(e) =>
                  e.key === "Enter" && setDrawerId(it.media_item_id)
                }
                className={`${row} cursor-pointer items-center border-b border-[#141A26] py-1.5 hover:bg-accent-subtle`}
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-mid">
                  {it.type === "series" ? "TV" : "MOV"}
                </span>
                <span className="truncate text-[12.5px] font-medium text-ink-hi">
                  {it.title}
                  {it.unmanaged && (
                    <span className="ml-1 rounded bg-line px-1 text-[9px] text-ink-low">
                      unmanaged
                    </span>
                  )}
                </span>
                <span className="font-mono text-[11.5px] text-ink-mid">
                  {relDays(it.last_watched_days)}
                </span>
                <span className="text-right font-mono text-[11.5px] text-ink-mid">
                  {it.total_plays}
                </span>
                <span className="text-right font-mono text-[11.5px] text-ink-mid">
                  {it.distinct_watchers}
                </span>
                <span className="text-right font-mono text-[11.5px] text-ink-mid">
                  {it.max_completion_pct
                    ? `${Math.round(it.max_completion_pct)}%`
                    : "—"}
                </span>
                <span className="text-right font-mono text-[11.5px] text-ink-hi">
                  {gb(it.size_gb)}
                </span>
                <span
                  className={`text-right font-mono text-[11.5px] ${it.gb_per_hour == null || it.gb_per_hour > 3 ? "text-state-error-ink" : "text-ink-mid"}`}
                >
                  {it.gb_per_hour == null ? "∞" : it.gb_per_hour}
                </span>
                <span className="flex min-w-0 items-center">
                  {it.type === "series" ? (
                    <span className="flex h-4 w-full gap-0.5">
                      {it.seasons.map((s: any) => (
                        <span
                          key={s.season_number}
                          title={`S${s.season_number} · ${s.state}`}
                          className="min-w-0 flex-1 rounded-sm"
                          style={{ background: seasonColor(s.state) }}
                        />
                      ))}
                    </span>
                  ) : (
                    <StatusPill state={it.state} size="sm" />
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {drawerId != null && (
        <Drawer itemId={drawerId} onClose={() => setDrawerId(null)} />
      )}
    </div>
  );
}

function ColumnHeader({
  col,
  sort,
  order,
  typeFilter,
  onSort,
  onTypeFilter,
}: {
  col: (typeof COLUMNS)[number];
  sort: SortKey;
  order: "asc" | "desc";
  typeFilter: TypeFilter;
  onSort: (key: SortKey) => void;
  onTypeFilter: () => void;
}) {
  const active = col.sort === sort;
  const align = col.align === "right" ? "justify-end text-right" : "text-left";

  if (col.filterType) {
    const label =
      typeFilter === "all" ? "All" : typeFilter === "movie" ? "MOV" : "TV";
    return (
      <button
        type="button"
        onClick={onTypeFilter}
        title="Filter: All → Movies → TV"
        className={`flex flex-col items-start gap-0.5 text-left transition-colors hover:text-ink-hi ${typeFilter !== "all" ? "text-accent" : "text-ink-low"}`}
      >
        <span className="text-[10.5px] font-semibold tracking-[0.08em]">
          TYPE
        </span>
        <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.04em]">
          {label} ▾
        </span>
      </button>
    );
  }

  if (!col.sort) {
    return (
      <span
        className={`text-[10.5px] font-semibold tracking-[0.08em] text-ink-low ${col.align === "right" ? "text-right" : ""}`}
      >
        {col.label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSort(col.sort!)}
      className={`flex w-full items-center gap-1 text-[10.5px] font-semibold tracking-[0.08em] transition-colors hover:text-ink-hi ${align} ${active ? "text-accent" : "text-ink-low"}`}
    >
      <span>{col.label}</span>
      {active && (
        <span className="font-mono text-[9px]">
          {order === "desc" ? "↓" : "↑"}
        </span>
      )}
    </button>
  );
}

function seasonColor(state: string) {
  switch (state) {
    case "SCHEDULED":
      return "rgba(229,72,77,0.4)";
    case "KEPT":
      return "rgba(63,162,111,0.3)";
    case "ERROR":
      return "rgba(247,104,8,0.4)";
    default:
      return "rgba(139,150,168,0.15)";
  }
}
