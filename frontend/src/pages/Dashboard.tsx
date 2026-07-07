import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { endpoints } from "../lib/api";
import { Card, SectionLabel, Skeleton } from "../components/ui";
import { fmtDate, gb } from "../lib/format";

export function Dashboard() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: endpoints.dashboard,
  });

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="the morning glance: disk, what's leaving, is everything healthy"
      />
      {isLoading || !data ? (
        <Skeleton rows={5} />
      ) : (
        <div className="grid grid-cols-[1.1fr_1fr] gap-4">
          <div className="flex flex-col gap-3">
            <Card className="!p-3">
              <SectionLabel>Disk by root folder</SectionLabel>
              {data.disk_gauges.length === 0 ? (
                <div className="text-[12px] text-ink-mid">
                  No disk data yet — save Sonarr/Radarr in Settings to sync, or
                  run <span className="font-mono">sync_radarr</span> /{" "}
                  <span className="font-mono">sync_sonarr</span> from Job
                  schedules.
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {data.disk_gauges.map((g: any) => (
                    <div key={g.root}>
                      <div className="mb-1 flex justify-between text-[11.5px]">
                        <span className="font-mono text-ink-hi">{g.root}</span>
                        <span
                          className={`font-mono ${g.over_tier ? "text-state-error-ink" : "text-ink-mid"}`}
                        >
                          {g.used_tb} / {g.capacity_tb} TB
                          {g.over_tier ? ` · over tier ${g.over_tier}` : ""}
                        </span>
                      </div>
                      <div className="relative h-2 rounded bg-bg-raised">
                        <span
                          className="absolute inset-y-0 left-0 rounded"
                          style={{
                            width: `${g.pct}%`,
                            background: g.over_tier ? "#F76808" : "#5B8DEF",
                          }}
                        />
                        <span
                          className="absolute -bottom-1 -top-1 w-0.5 bg-state-candidate"
                          style={{ left: `${g.warn_pct}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card className="!p-3">
              <div className="mb-2 flex justify-between">
                <SectionLabel>Bytes freed · cumulative</SectionLabel>
                <span className="font-mono text-[12px] text-chart-2">
                  {data.total_freed_tb} TB all-time
                </span>
              </div>
              <div className="h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.bytes_freed_series}>
                    <defs>
                      <linearGradient id="freed" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor="#2FB8A6"
                          stopOpacity={0.5}
                        />
                        <stop
                          offset="100%"
                          stopColor="#2FB8A6"
                          stopOpacity={0.05}
                        />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="ts" hide />
                    <Tooltip
                      contentStyle={{
                        background: "#1A2130",
                        border: "1px solid #2A3448",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelFormatter={(v) => fmtDate(v as string)}
                      formatter={(v) => [gb(v as number), "freed"]}
                    />
                    <Area
                      type="monotone"
                      dataKey="cumulative_gb"
                      stroke="#2FB8A6"
                      fill="url(#freed)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="flex flex-col gap-3">
            <Card className="!p-3">
              <SectionLabel>
                Leaving this week · {data.leaving_week.length} items ·{" "}
                {gb(data.leaving_week_gb)}
              </SectionLabel>
              {data.leaving_week.length === 0 ? (
                <div className="text-[12px] text-ink-mid">
                  Nothing leaves in the next 7 days.
                </div>
              ) : (
                <div className="flex gap-2 overflow-x-auto">
                  {data.leaving_week.slice(0, 6).map((u: any) => {
                    const d = Math.max(0, Math.round(u.days_until));
                    return (
                      <button
                        key={u.key}
                        onClick={() => navigate("/upcoming")}
                        className="w-16 flex-none text-left"
                      >
                        <div className="poster-placeholder relative h-24 w-16 rounded border border-line">
                          <span
                            className={`absolute bottom-1 left-1 rounded px-1.5 py-0.5 font-mono text-[9.5px] ${
                              d <= 1
                                ? "bg-state-scheduled font-semibold text-white"
                                : "bg-[rgba(229,72,77,0.25)] text-state-scheduled-ink"
                            }`}
                          >
                            {d}d
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[10px] text-ink-mid">
                          {u.title}
                          {u.season_number ? ` S${u.season_number}` : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Card className="!p-3">
                <SectionLabel>Integrations</SectionLabel>
                <div className="flex flex-col gap-1.5 text-[12px]">
                  {data.integrations.map((i: any) => (
                    <div key={i.name} className="flex justify-between">
                      <span className="capitalize text-ink-hi">{i.name}</span>
                      {!i.configured ? (
                        <span className="text-ink-low">◦ not set</span>
                      ) : i.ok ? (
                        <span className="text-state-kept-ink">
                          ● {i.latency_ms}ms
                        </span>
                      ) : (
                        <span className="animate-swp-pulse text-state-error-ink">
                          ▲ {i.detail}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="!p-3">
                <SectionLabel>Recent jobs</SectionLabel>
                <div className="flex flex-col gap-1.5 font-mono text-[11px] text-ink-mid">
                  {data.recent_jobs.slice(0, 4).map((j: any, idx: number) => (
                    <div key={idx}>
                      {j.job}{" "}
                      <span
                        className={
                          j.status === "ok"
                            ? "text-state-kept-ink"
                            : "text-state-error-ink"
                        }
                      >
                        {j.status === "ok" ? "✓" : "▲"}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-display">{title}</h1>
      {subtitle && (
        <p className="mt-1 text-[13.5px] text-ink-mid">{subtitle}</p>
      )}
    </div>
  );
}
