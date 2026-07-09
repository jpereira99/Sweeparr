import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { endpoints, unitSnapshot } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { StatusPill } from "../components/StatusPill";
import { Popover } from "../components/Popover";
import { Button, Chip, EmptyState, Poster, Skeleton } from "../components/ui";
import { useToast } from "../components/Toast";
import { countdown, gb } from "../lib/format";

export function Upcoming() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["schedule"],
    queryFn: endpoints.schedule,
  });

  const units = useMemo(() => {
    let u: any[] = data?.units ?? [];
    if (typeFilter === "tv") u = u.filter((x) => x.unit_type === "season");
    if (typeFilter === "movie") u = u.filter((x) => x.unit_type === "movie");
    return u;
  }, [data, typeFilter]);

  async function keep(u: any) {
    const before = unitSnapshot(u);
    await endpoints.keepUnit(u.unit_type, u.unit_id);
    toast(`Kept ${u.title}`, async () => {
      await endpoints.restore(u.unit_type, u.unit_id, before);
      qc.invalidateQueries();
    });
    qc.invalidateQueries();
  }
  async function delay(u: any) {
    const before = unitSnapshot(u);
    try {
      const r = await endpoints.delay(u.unit_type, u.unit_id);
      toast(
        `Delayed ${u.title}` +
          (r.delay_remaining != null ? ` · ${r.delay_remaining} left` : ""),
        async () => {
          await endpoints.restore(u.unit_type, u.unit_id, before);
          qc.invalidateQueries();
        },
      );
    } catch (e: any) {
      toast(e?.message?.includes("cap") ? "Delay cap reached" : "Cannot delay");
    }
    qc.invalidateQueries();
  }
  async function deleteNow(u: any) {
    if (!confirm(`Delete ${u.title} now? This executes immediately.`)) return;
    const r = await endpoints.deleteNow(u.unit_type, u.unit_id);
    toast(
      r.result?.skipped
        ? "System paused — nothing deleted"
        : `Deleted ${u.title}`,
    );
    qc.invalidateQueries();
  }

  return (
    <div>
      <PageHeader
        title="Upcoming Removals"
        subtitle="everything scheduled sits here for its whole grace window"
      />

      <div className="mb-4 flex items-center gap-3">
        <span className="font-mono text-[12px] text-state-scheduled-ink">
          {data?.scheduled_count ?? 0} scheduled · {gb(data?.total_gb)}
        </span>
        {data?.system_enabled === false && (
          <span className="font-mono text-[11px] text-state-error-ink">
            ■ system paused
          </span>
        )}
        <span className="ml-auto inline-flex overflow-hidden rounded border border-line">
          {(["calendar", "list"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3.5 py-1.5 text-[12.5px] capitalize ${
                view === v ? "bg-accent-subtle text-ink-hi" : "text-ink-mid"
              }`}
            >
              {v}
            </button>
          ))}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip
          active={typeFilter === "tv"}
          onClick={() => setTypeFilter(typeFilter === "tv" ? null : "tv")}
        >
          TV seasons {typeFilter === "tv" ? "✕" : ""}
        </Chip>
        <Chip
          active={typeFilter === "movie"}
          onClick={() => setTypeFilter(typeFilter === "movie" ? null : "movie")}
        >
          Movies {typeFilter === "movie" ? "✕" : ""}
        </Chip>
      </div>

      {isLoading ? (
        <Skeleton rows={6} />
      ) : units.length === 0 ? (
        <EmptyState title="Nothing is scheduled">
          When an enabled rule matches something, it appears here for the grace
          window before deletion.{" "}
          <button
            className="text-accent-hover"
            onClick={() => navigate("/rules")}
          >
            Review rules
          </button>
        </EmptyState>
      ) : view === "calendar" ? (
        <CalendarView units={units} />
      ) : (
        <ListView
          units={units}
          keep={keep}
          delay={delay}
          deleteNow={deleteNow}
          navigate={navigate}
        />
      )}
    </div>
  );
}

function CalendarView({ units }: { units: any[] }) {
  const today = new Date();
  const [month, setMonth] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );

  const byDay = new Map<string, any[]>();
  for (const u of units) {
    if (!u.delete_at) continue;
    const key = new Date(u.delete_at).toDateString();
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(u);
  }

  // Grid starts on the Monday on/before the 1st of the viewed month and spans
  // whole weeks so the month is always complete.
  const gridStart = new Date(month);
  gridStart.setDate(1 - ((month.getDay() + 6) % 7));
  gridStart.setHours(0, 0, 0, 0);
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const leadingDays = (month.getDay() + 6) % 7;
  const totalCells = Math.ceil((leadingDays + monthEnd.getDate()) / 7) * 7;

  const cells = Array.from({ length: totalCells }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const maxCount = Math.max(
    1,
    ...Array.from(byDay.values()).map((v) => v.length),
  );

  const shiftMonth = (delta: number) =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  const monthLabel = month.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="rounded-lg border border-line bg-bg p-4">
      <div className="mb-3 flex items-center gap-2">
        <button
          onClick={() => shiftMonth(-1)}
          aria-label="Previous month"
          className="flex h-7 w-7 items-center justify-center rounded border border-line text-ink-mid transition-colors hover:text-ink-hi"
        >
          ‹
        </button>
        <button
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
          className="flex h-7 w-7 items-center justify-center rounded border border-line text-ink-mid transition-colors hover:text-ink-hi"
        >
          ›
        </button>
        <span className="ml-1 text-[14px] font-semibold text-ink-hi">
          {monthLabel}
        </span>
        <button
          onClick={() =>
            setMonth(new Date(today.getFullYear(), today.getMonth(), 1))
          }
          className="ml-auto rounded border border-line px-3 py-1 text-[12px] text-ink-mid transition-colors hover:text-ink-hi"
        >
          Today
        </button>
      </div>
      <div className="mb-1 grid grid-cols-7 gap-1.5">
        {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => (
          <div
            key={d}
            className="px-1.5 py-1 text-[10.5px] font-semibold tracking-[0.08em] text-ink-faint"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((d, i) => {
          const items = byDay.get(d.toDateString()) ?? [];
          const isToday = d.toDateString() === today.toDateString();
          const inMonth = d.getMonth() === month.getMonth();
          const hasItems = items.length > 0;
          const heat = Math.round((items.length / maxCount) * 100);
          return (
            <div
              key={i}
              className={`relative flex h-40 flex-col gap-1 overflow-hidden rounded-lg p-2 ${inMonth ? "" : "opacity-40"}`}
              style={{
                background: hasItems ? "#0C0F16" : "#0A0D12",
                border: isToday
                  ? "1px solid rgba(91,141,239,0.55)"
                  : hasItems
                    ? "1px solid rgba(229,72,77,0.4)"
                    : "1px solid #141A26",
              }}
            >
              {hasItems && (
                <div
                  className="absolute left-0 top-0 h-[3px] bg-state-scheduled"
                  style={{ width: `${heat}%` }}
                />
              )}
              <div className="mt-0.5 flex justify-between">
                <span
                  className={`font-mono text-[11px] ${hasItems || isToday ? "text-ink-hi" : "text-ink-faint"}`}
                >
                  {d.getDate()}
                </span>
                {isToday ? (
                  <span className="text-[10px] text-ink-low">today</span>
                ) : (
                  items.length > 3 && (
                    <span className="font-mono text-[9.5px] text-state-scheduled-ink">
                      {items.length} leaving
                    </span>
                  )
                )}
              </div>
              {items.slice(0, 3).map((u) => (
                <div
                  key={u.key}
                  className="flex items-center gap-1 overflow-hidden rounded border border-line-subtle bg-bg-raised px-1.5 py-1 text-[10px] text-ink-hi"
                >
                  <span className="truncate">{u.title}</span>
                  {u.season_number ? (
                    <span className="flex-none font-mono text-[9px] text-ink-low">
                      S{u.season_number}
                    </span>
                  ) : null}
                </div>
              ))}
              {items.length > 3 && (
                <div className="mt-auto rounded bg-[rgba(229,72,77,0.1)] px-1 py-0.5 text-center font-mono text-[9.5px] text-state-scheduled-ink">
                  +{items.length - 3} more ·{" "}
                  {gb(items.reduce((a, x) => a + x.size_gb, 0))}
                </div>
              )}
              {hasItems && items.length <= 3 && (
                <div className="mt-auto font-mono text-[9.5px] text-ink-low">
                  {items.length} ·{" "}
                  {gb(items.reduce((a, x) => a + x.size_gb, 0))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ units, keep, delay, deleteNow, navigate }: any) {
  const cols = "grid-cols-[56px_minmax(180px,1.4fr)_220px_120px_1fr_90px_190px]";
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center gap-3 border-b border-line-subtle bg-bg-raised px-6 py-3.5 text-[12.5px] text-ink-mid">
        <span>List view · sorted by delete date (errors pinned)</span>
      </div>
      <div
        className={`grid ${cols} gap-x-3 border-b border-line-subtle px-6 py-2`}
      >
        {["", "TITLE", "STATUS", "DELETES", "RULE · WHY", "FREES", "ACTIONS"].map(
          (h, i) => (
            <span
              key={i}
              className={`text-[10.5px] font-semibold tracking-[0.08em] text-ink-low ${i >= 5 ? "text-right" : ""}`}
            >
              {h}
            </span>
          ),
        )}
      </div>
      {units.map((u: any) => {
        const cd = countdown(u.days_until);
        return (
          <div
            key={u.key}
            className={`grid ${cols} items-center gap-x-3 border-b border-[#141A26] px-6 py-2`}
          >
            <Poster size={40} src={u.poster_url} />
            <span>
              <button
                onClick={() => navigate("/library")}
                className="block text-left text-[13px] font-medium text-ink-hi"
              >
                {u.title}
                {u.season_number ? (
                  <span className="ml-1 rounded bg-accent-subtle px-1.5 py-0.5 font-mono text-[10.5px] text-accent-hover">
                    S{u.season_number}
                  </span>
                ) : null}
              </button>
              <span className="text-[11.5px] text-ink-low">
                {u.unit_type === "season" ? "TV" : "Movie"}
                {u.last_watched_days != null
                  ? ` · last watched ${u.last_watched_days}d ago`
                  : ""}
                {u.delay_count > 0 ? (
                  <span className="ml-1 text-state-candidate-ink">
                    · delayed x{u.delay_count}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <StatusPill
                state={u.state}
                size="sm"
                date={u.delete_at}
                delayCount={u.delay_count}
              />
              <Popover ruleName={u.rule_name} snapshot={u.snapshot} />
            </span>
            <span>
              {u.state === "ERROR" ? (
                <span className="font-mono text-[11.5px] text-state-error-ink">
                  held
                </span>
              ) : cd.urgent ? (
                <span className="rounded bg-state-scheduled px-2 py-0.5 font-mono text-[11.5px] font-semibold text-white">
                  {cd.label}
                </span>
              ) : (
                <span className="rounded bg-[rgba(229,72,77,0.12)] px-2 py-0.5 font-mono text-[11.5px] text-state-scheduled-ink">
                  {cd.label}
                </span>
              )}
            </span>
            <span className="text-[12px] text-ink-mid">
              {u.state === "ERROR" ? (
                <span className="text-state-error-ink">
                  Deletion failed — check the integration in Settings
                </span>
              ) : (
                <>
                  {u.rule_name} — {u.reason_public}
                </>
              )}
            </span>
            <span className="text-right font-mono text-[12px] text-ink-hi">
              {gb(u.size_gb)}
            </span>
            <span className="flex justify-end gap-1.5">
              {u.state === "ERROR" ? (
                <>
                  <Button size="sm" variant="warn" onClick={() => deleteNow(u)}>
                    Retry
                  </Button>
                  <Button size="sm" variant="keep" onClick={() => keep(u)}>
                    ✓ Keep
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="keep" onClick={() => keep(u)}>
                    ✓ Keep
                  </Button>
                  <Button size="sm" onClick={() => delay(u)}>
                    Delay
                  </Button>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
