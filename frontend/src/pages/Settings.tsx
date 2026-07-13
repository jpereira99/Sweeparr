import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Card, SectionLabel, Button, Toggle, Skeleton } from "../components/ui";
import { Popover } from "../components/Popover";
import { useToast } from "../components/Toast";

const SERVICES = [
  "jellyfin",
  "jellyseerr",
  "sonarr",
  "radarr",
  "ntfy",
] as const;

const JOB_HINTS: Record<string, string> = {
  sync_radarr:
    "Pulls your movie library from Radarr — titles, files, sizes, and disk usage.",
  sync_sonarr:
    "Pulls your series library from Sonarr — shows, seasons, episode counts, and disk usage.",
  sync_jellyfin:
    "Matches library items to Jellyfin and pulls watch history (plays, favorites, completion).",
  sync_jellyseerr:
    "Imports Jellyseerr requests and requesters, linking each to the matching media item.",
  aggregate_playback:
    "Rolls raw playback sessions up into per-item and per-season watch statistics.",
  evaluate_rules:
    "Runs your cleanup rules against the library and schedules matching items for removal.",
  execute_deletions:
    "Deletes items whose grace period has expired and that weren't kept.",
  lift_protections:
    "Re-checks auto-protected items and releases any whose protection no longer applies.",
  notify: "Sends pending reminder notifications about upcoming removals.",
  sync_leaving_collection:
    'Keeps the "Leaving soon" collection in sync with items scheduled for removal.',
  housekeeping:
    "Prunes old playback events and records periodic health snapshots.",
};

type Schedule =
  { kind: "interval"; minutes: number } | { kind: "cron"; expr: string };

// APScheduler crontab day-of-week is 0=Mon .. 6=Sun.
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const inputCls =
  "h-7 rounded border border-line bg-bg px-1.5 font-mono text-[11px] text-ink-hi outline-none focus:border-accent";

function splitInterval(minutes: number): { value: number; unit: "m" | "h" } {
  if (minutes >= 60 && minutes % 60 === 0)
    return { value: minutes / 60, unit: "h" };
  return { value: minutes, unit: "m" };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

type Mode = "interval" | "hourly" | "daily" | "weekly" | "cron";
type EditorState = {
  mode: Mode;
  value: number; // interval value
  unit: "m" | "h"; // interval unit
  minute: number; // hourly/daily/weekly
  hour: number; // daily/weekly
  dow: number; // weekly (0=Mon)
  expr: string; // custom cron
};

// Recognize the friendly cron shapes our builder emits so re-opening the editor
// lands on the right mode; anything else falls back to raw "custom cron".
function scheduleToState(s: Schedule): EditorState {
  const base: EditorState = {
    mode: "interval",
    value: 45,
    unit: "m",
    minute: 0,
    hour: 4,
    dow: 0,
    expr: "0 4 * * *",
  };
  if (s.kind === "interval") {
    const { value, unit } = splitInterval(s.minutes);
    return { ...base, mode: "interval", value, unit };
  }
  const p = s.expr.trim().split(/\s+/);
  if (p.length === 5) {
    const [m, h, dom, mon, dow] = p;
    const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
    const mN = num(m);
    if (mN !== null && dom === "*" && mon === "*") {
      if (h === "*" && dow === "*")
        return { ...base, mode: "hourly", minute: mN, expr: s.expr };
      const hN = num(h);
      if (hN !== null && dow === "*")
        return { ...base, mode: "daily", hour: hN, minute: mN, expr: s.expr };
      const dN = num(dow);
      if (hN !== null && dN !== null)
        return {
          ...base,
          mode: "weekly",
          dow: dN,
          hour: hN,
          minute: mN,
          expr: s.expr,
        };
    }
  }
  return { ...base, mode: "cron", expr: s.expr };
}

function stateToSchedule(st: EditorState): Schedule {
  switch (st.mode) {
    case "interval":
      return {
        kind: "interval",
        minutes: Math.max(
          1,
          Math.round(st.unit === "h" ? st.value * 60 : st.value),
        ),
      };
    case "hourly":
      return { kind: "cron", expr: `${st.minute} * * * *` };
    case "daily":
      return { kind: "cron", expr: `${st.minute} ${st.hour} * * *` };
    case "weekly":
      return { kind: "cron", expr: `${st.minute} ${st.hour} * * ${st.dow}` };
    case "cron":
      return { kind: "cron", expr: st.expr.trim() };
  }
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === "interval") {
    const { value, unit } = splitInterval(s.minutes);
    return `every ${value} ${unit === "h" ? "hour" : "min"}${value === 1 ? "" : "s"}`;
  }
  const st = scheduleToState(s);
  const at = `${pad2(st.hour)}:${pad2(st.minute)}`;
  if (st.mode === "hourly") return `hourly at :${pad2(st.minute)}`;
  if (st.mode === "daily") return `daily at ${at}`;
  if (st.mode === "weekly") return `weekly · ${DOW[st.dow]} ${at}`;
  return `cron: ${s.expr}`;
}

function JobScheduleEditor({
  schedule,
  onSave,
}: {
  schedule: Schedule;
  onSave: (s: Schedule) => void;
}) {
  const [st, setSt] = useState<EditorState>(() => scheduleToState(schedule));
  const set = (patch: Partial<EditorState>) =>
    setSt((s) => ({ ...s, ...patch }));
  const timeValue = `${pad2(st.hour)}:${pad2(st.minute)}`;
  const onTime = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    set({ hour: h || 0, minute: m || 0 });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-mid">
      <select
        value={st.mode}
        onChange={(e) => set({ mode: e.target.value as Mode })}
        className={inputCls}
      >
        <option value="interval">Every…</option>
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="cron">Custom cron</option>
      </select>

      {st.mode === "interval" && (
        <>
          <input
            type="number"
            min={1}
            value={st.value}
            onChange={(e) => set({ value: Number(e.target.value) })}
            className={`${inputCls} w-12 text-center`}
          />
          <select
            value={st.unit}
            onChange={(e) => set({ unit: e.target.value as "m" | "h" })}
            className={inputCls}
          >
            <option value="m">min</option>
            <option value="h">hr</option>
          </select>
        </>
      )}

      {st.mode === "hourly" && (
        <span className="flex items-center gap-1">
          at :
          <input
            type="number"
            min={0}
            max={59}
            value={st.minute}
            onChange={(e) => set({ minute: Number(e.target.value) })}
            className={`${inputCls} w-12 text-center`}
          />
        </span>
      )}

      {(st.mode === "daily" || st.mode === "weekly") && (
        <>
          {st.mode === "weekly" && (
            <select
              value={st.dow}
              onChange={(e) => set({ dow: Number(e.target.value) })}
              className={inputCls}
            >
              {DOW.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          )}
          <span className="flex items-center gap-1">
            at
            <input
              type="time"
              value={timeValue}
              onChange={(e) => onTime(e.target.value)}
              className={inputCls}
            />
          </span>
        </>
      )}

      {st.mode === "cron" && (
        <input
          type="text"
          value={st.expr}
          onChange={(e) => set({ expr: e.target.value })}
          placeholder="m h dom mon dow"
          title="Standard 5-field crontab. Day-of-week: 0=Mon … 6=Sun."
          className={`${inputCls} w-36`}
        />
      )}

      <Button
        size="sm"
        variant="primary"
        onClick={() => onSave(stateToSchedule(st))}
      >
        Save
      </Button>
    </div>
  );
}

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: endpoints.me });
  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: endpoints.settings,
  });
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});
  const [drafts, setDrafts] = useState<
    Record<string, { url: string; api_key: string; topic?: string }>
  >({});
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [runningAll, setRunningAll] = useState(false);
  const [delayDraft, setDelayDraft] = useState<{
    days?: number;
    max?: number;
  }>({});
  const [requestWindowDraft, setRequestWindowDraft] = useState<
    number | undefined
  >(undefined);

  async function test(svc: string) {
    setTesting(svc);
    try {
      const r = await endpoints.testConnection(svc);
      setResults((s) => ({ ...s, [svc]: r }));
    } finally {
      setTesting(null);
    }
  }

  async function saveIntegration(svc: string) {
    const d = drafts[svc] ?? {};
    const patch: any = { url: d.url ?? data?.connections?.[svc]?.url ?? "" };
    if (d.api_key) patch.api_key = d.api_key;
    if (svc === "ntfy")
      patch.topic = d.topic ?? data?.connections?.ntfy?.topic ?? "";
    const updated = await endpoints.updateSettings({
      integrations: { [svc]: patch },
    });
    const h = (updated.integration_health ?? []).find(
      (x: any) => x.name === svc,
    );
    if (h)
      setResults((s) => ({
        ...s,
        [svc]: { ok: h.ok, detail: h.detail, latency_ms: h.latency_ms },
      }));
    setDrafts((s) => {
      const next = { ...s };
      delete next[svc];
      return next;
    });
    const sync = updated.sync_summary;
    const upserted =
      (sync?.sync_radarr?.upserted ?? 0) + (sync?.sync_sonarr?.upserted ?? 0);
    toast(
      upserted
        ? `Saved ${svc} — synced ${upserted} items from library`
        : `Saved ${svc} settings`,
    );
    qc.invalidateQueries();
  }

  async function toggleSystem(on: boolean) {
    await endpoints.updateSettings({ system_enabled: on });
    toast(on ? "System running" : "System paused");
    qc.invalidateQueries();
  }

  async function runAllJobs() {
    const jobs = data?.jobs ?? [];
    if (!jobs.length || runningAll) return;
    setRunningAll(true);
    let ok = 0;
    let failed = 0;
    try {
      for (const j of jobs) {
        try {
          await endpoints.runJob(j.name);
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      toast(
        failed === 0
          ? `Ran all ${ok} jobs`
          : `Ran ${ok} jobs · ${failed} failed`,
      );
      qc.invalidateQueries();
    } finally {
      setRunningAll(false);
    }
  }

  async function saveValues(patch: Record<string, unknown>, msg: string) {
    await endpoints.updateSettings({ values: patch });
    toast(msg);
    qc.invalidateQueries();
  }

  async function changePassword() {
    if (pw.next !== pw.confirm) {
      toast("Passwords do not match");
      return;
    }
    await endpoints.changePassword(pw.current, pw.next);
    setPw({ current: "", next: "", confirm: "" });
    toast("Password updated");
  }

  if (isLoading || !data) return <Skeleton rows={6} />;

  const health: Record<string, any> = {};
  (data.integration_health ?? []).forEach((h: any) => (health[h.name] = h));

  function draftFor(svc: string) {
    const conn = data.connections[svc] ?? {};
    return (
      drafts[svc] ?? {
        url: conn.url ?? "",
        api_key: "",
        topic: conn.topic ?? "",
      }
    );
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="connections, system control, and account"
      />
      <div className="grid grid-cols-[1.2fr_0.8fr] gap-4">
        <Card>
          <SectionLabel>Connections</SectionLabel>
          <div className="flex flex-col gap-3">
            {SERVICES.map((svc) => {
              const c = data.connections[svc] ?? {};
              const d = draftFor(svc);
              const h = health[svc] || {};
              const r = results[svc];
              return (
                <div
                  key={svc}
                  className="rounded border border-line-subtle bg-bg-inset p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[12px] font-medium capitalize text-ink-hi">
                      {svc}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={testing === svc}
                        onClick={() => test(svc)}
                      >
                        {testing === svc ? "Testing…" : "Test"}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => saveIntegration(svc)}
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                  <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                    URL
                  </label>
                  <input
                    value={d.url}
                    onChange={(e) =>
                      setDrafts((s) => ({
                        ...s,
                        [svc]: { ...draftFor(svc), url: e.target.value },
                      }))
                    }
                    className="mb-2 h-8 w-full rounded border border-line bg-bg px-2 font-mono text-[11px] text-ink-hi outline-none focus:border-accent"
                    placeholder={`https://${svc}.example.com`}
                  />
                  {svc !== "ntfy" ? (
                    <>
                      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                        API key{" "}
                        {c.has_key ? "(leave blank to keep current)" : ""}
                      </label>
                      <input
                        type="password"
                        value={d.api_key}
                        onChange={(e) =>
                          setDrafts((s) => ({
                            ...s,
                            [svc]: {
                              ...draftFor(svc),
                              api_key: e.target.value,
                            },
                          }))
                        }
                        className="mb-1 h-8 w-full rounded border border-line bg-bg px-2 font-mono text-[11px] text-ink-hi outline-none focus:border-accent"
                        placeholder={c.has_key ? "••••••••" : "API key"}
                      />
                    </>
                  ) : (
                    <>
                      <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                        Topic
                      </label>
                      <input
                        value={d.topic ?? ""}
                        onChange={(e) =>
                          setDrafts((s) => ({
                            ...s,
                            [svc]: { ...draftFor(svc), topic: e.target.value },
                          }))
                        }
                        className="mb-1 h-8 w-full rounded border border-line bg-bg px-2 font-mono text-[11px] text-ink-hi outline-none focus:border-accent"
                        placeholder="sweeparr"
                      />
                    </>
                  )}
                  {(r || h.configured || c.has_key || c.url) && (
                    <div
                      className={`mt-1 font-mono text-[10.5px] ${(r?.ok ?? h.ok) ? "text-state-kept-ink" : "text-state-error-ink"}`}
                    >
                      {(r?.ok ?? h.ok)
                        ? `● ${r?.latency_ms ?? h.latency_ms ?? ""}ms`
                        : `▲ ${r?.detail ?? h.detail ?? (c.url || c.has_key ? "connection failed" : "not configured")}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="border-[rgba(91,141,239,0.35)]">
            <div className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent-hover">
              System
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[12px] font-medium text-ink-hi">
                  {data.system_enabled ? "Running" : "Paused"}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-low">
                  When paused, no rules evaluate and nothing deletes.
                </p>
              </div>
              <Toggle on={data.system_enabled} onChange={toggleSystem} />
            </div>
          </Card>

          {me?.is_local && (
            <Card>
              <SectionLabel>Local admin account</SectionLabel>
              <div className="flex flex-col gap-2">
                <input
                  type="password"
                  placeholder="Current password"
                  value={pw.current}
                  onChange={(e) =>
                    setPw((p) => ({ ...p, current: e.target.value }))
                  }
                  className="h-8 rounded border border-line bg-bg px-2 text-[12px] text-ink-hi outline-none focus:border-accent"
                />
                <input
                  type="password"
                  placeholder="New password (min 8 chars)"
                  value={pw.next}
                  onChange={(e) =>
                    setPw((p) => ({ ...p, next: e.target.value }))
                  }
                  className="h-8 rounded border border-line bg-bg px-2 text-[12px] text-ink-hi outline-none focus:border-accent"
                />
                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={pw.confirm}
                  onChange={(e) =>
                    setPw((p) => ({ ...p, confirm: e.target.value }))
                  }
                  className="h-8 rounded border border-line bg-bg px-2 text-[12px] text-ink-hi outline-none focus:border-accent"
                />
                <Button size="sm" onClick={changePassword}>
                  Change password
                </Button>
              </div>
            </Card>
          )}

          <Card className="overflow-hidden !p-0">
            <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 pt-4">
              <SectionLabel>Job schedules</SectionLabel>
              <div className="mb-3">
                <Button
                  size="sm"
                  disabled={runningAll || !(data.jobs ?? []).length}
                  onClick={runAllJobs}
                >
                  {runningAll ? "Running…" : "Run All"}
                </Button>
              </div>
            </div>
            <div className="divide-y divide-line-subtle">
              {(data.jobs ?? []).map((j: any) => (
                <div key={j.name} className="px-5 py-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-[12px] text-ink-hi">
                        {j.name}
                      </span>
                      {JOB_HINTS[j.name] && (
                        <Popover title="WHAT THIS JOB DOES">
                          <p className="text-[12.5px] leading-relaxed text-ink-mid">
                            {JOB_HINTS[j.name]}
                          </p>
                        </Popover>
                      )}
                    </span>
                    <div className="flex flex-none items-center gap-2">
                      <span className="font-mono text-[10.5px] text-ink-mid">
                        Next run:{" "}
                        {j.paused
                          ? "paused"
                          : j.next_run
                            ? new Date(j.next_run).toLocaleString([], {
                                weekday: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                      </span>
                      <Button
                        size="sm"
                        disabled={runningAll}
                        onClick={async () => {
                          await endpoints.runJob(j.name);
                          toast(`Ran ${j.name}`);
                          qc.invalidateQueries();
                        }}
                      >
                        Run
                      </Button>
                    </div>
                  </div>
                  <JobScheduleEditor
                    key={`${j.name}-${JSON.stringify(j.schedule)}`}
                    schedule={j.schedule ?? j.default_schedule}
                    onSave={async (schedule) => {
                      try {
                        await endpoints.setJobSchedule(j.name, schedule);
                        toast(`${j.name}: ${describeSchedule(schedule)}`);
                        qc.invalidateQueries();
                      } catch (e: any) {
                        toast(e?.message ?? "Invalid schedule");
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-4">
        <SectionLabel>Keep &amp; delay options (§8)</SectionLabel>
        <p className="mb-3 text-[12px] leading-relaxed text-ink-mid">
          Choose what Jellyfin users can do from the &quot;Leaving soon&quot;
          banner. A keep request waits for your approval on the Keep Requests
          page; a delay is automatic and simply pushes the removal date out.
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded border border-line-subtle bg-bg-inset p-3">
            <div>
              <div className="text-[12px] font-medium text-ink-hi">
                Allow keep requests
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-low">
                Users can ask an admin to keep an item; deletion pauses until
                you decide.
              </p>
            </div>
            <Toggle
              on={data.values?.keep_requests_enabled ?? true}
              onChange={(on) =>
                saveValues(
                  { keep_requests_enabled: on },
                  on ? "Keep requests enabled" : "Keep requests disabled",
                )
              }
            />
          </div>
          <div className="flex items-center justify-between rounded border border-line-subtle bg-bg-inset p-3">
            <div>
              <div className="text-[12px] font-medium text-ink-hi">
                Allow self-service delay
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-low">
                Users can push the removal date out themselves, no approval
                needed.
              </p>
            </div>
            <Toggle
              on={data.values?.delay_enabled ?? false}
              onChange={(on) =>
                saveValues(
                  { delay_enabled: on },
                  on ? "Delay enabled" : "Delay disabled",
                )
              }
            />
          </div>
          <div className="rounded border border-line-subtle bg-bg-inset p-3">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                  Days per delay
                </label>
                <input
                  type="number"
                  min={1}
                  value={delayDraft.days ?? data.values?.delay_days ?? 14}
                  onChange={(e) =>
                    setDelayDraft((s) => ({
                      ...s,
                      days: Number(e.target.value),
                    }))
                  }
                  className="h-8 w-24 rounded border border-line bg-bg px-2 font-mono text-[11px] text-ink-hi outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                  Max delays per item
                </label>
                <input
                  type="number"
                  min={1}
                  value={delayDraft.max ?? data.values?.delay_max_count ?? 3}
                  onChange={(e) =>
                    setDelayDraft((s) => ({
                      ...s,
                      max: Number(e.target.value),
                    }))
                  }
                  className="h-8 w-24 rounded border border-line bg-bg px-2 font-mono text-[11px] text-ink-hi outline-none focus:border-accent"
                />
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  await saveValues(
                    {
                      delay_days:
                        delayDraft.days ?? data.values?.delay_days ?? 14,
                      delay_max_count:
                        delayDraft.max ?? data.values?.delay_max_count ?? 3,
                    },
                    "Delay settings saved",
                  );
                  setDelayDraft({});
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <SectionLabel>Automatic protections</SectionLabel>
        <p className="mb-3 text-[12px] leading-relaxed text-ink-mid">
          When a rule matches an item that still meets one of these conditions,
          Sweeparr keeps it automatically instead of scheduling it — no admin
          action needed. Every hour it re-checks: once the condition stops
          applying (unfavorited, tag removed, request window passed), the item
          is released back to normal evaluation on its own. Manual keeps made
          from the Keep button are indefinite and are never affected by this —
          release those yourself from the{" "}
          <span className="font-medium text-ink-hi">Keeps</span> page.
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded border border-line-subtle bg-bg-inset p-3">
            <div>
              <div className="text-[12px] font-medium text-ink-hi">
                Jellyfin favorites
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-low">
                Keep anything favorited by any Jellyfin user.
              </p>
            </div>
            <Toggle
              on={data.values?.favorite_protects ?? true}
              onChange={(on) =>
                saveValues(
                  { favorite_protects: on },
                  on
                    ? "Favorites now protect items"
                    : "Favorites no longer protect items",
                )
              }
            />
          </div>
          <div className="flex items-center justify-between rounded border border-line-subtle bg-bg-inset p-3">
            <div>
              <div className="text-[12px] font-medium text-ink-hi">
                Airing series
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-low">
                Keep the latest season of a continuing/airing show.
              </p>
            </div>
            <Toggle
              on={data.values?.airing_protects ?? true}
              onChange={(on) =>
                saveValues(
                  { airing_protects: on },
                  on
                    ? "Airing series now protected"
                    : "Airing series no longer protected",
                )
              }
            />
          </div>
          <div className="flex items-center justify-between rounded border border-line-subtle bg-bg-inset p-3">
            <div>
              <div className="text-[12px] font-medium text-ink-hi">
                Arr &quot;sweeparr-keep&quot; tag
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-low">
                Keep anything manually tagged in Sonarr/Radarr.
              </p>
            </div>
            <Toggle
              on={data.values?.tag_protects ?? true}
              onChange={(on) =>
                saveValues(
                  { tag_protects: on },
                  on ? "Tag protection enabled" : "Tag protection disabled",
                )
              }
            />
          </div>
          <div className="rounded border border-line-subtle bg-bg-inset p-3">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                  Recently requested (days, 0 = off)
                </label>
                <input
                  type="number"
                  min={0}
                  value={
                    requestWindowDraft ??
                    data.values?.request_protection_days ??
                    30
                  }
                  onChange={(e) =>
                    setRequestWindowDraft(Number(e.target.value))
                  }
                  className="h-8 w-32 rounded border border-line bg-bg px-2 font-mono text-[11px] text-ink-hi outline-none focus:border-accent"
                />
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  await saveValues(
                    {
                      request_protection_days:
                        requestWindowDraft ??
                        data.values?.request_protection_days ??
                        30,
                    },
                    "Request window saved",
                  );
                  setRequestWindowDraft(undefined);
                }}
              >
                Save
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-low">
              Keep items requested through Jellyseerr within the last N days, so
              a fresh request isn&apos;t swept up immediately.
            </p>
          </div>
          <p className="text-[11px] leading-relaxed text-ink-low">
            Unmanaged items (no Sonarr/Radarr counterpart) are always kept —
            Sweeparr has nothing to delete them through, so this one isn&apos;t
            configurable.
          </p>
        </div>
      </Card>

      <Card className="mt-4">
        <SectionLabel>Jellyfin inject script (§8.2)</SectionLabel>
        <p className="mb-2 text-[12px] leading-relaxed text-ink-mid">
          Load the versioned pill/banner script into your Jellyfin web client.
          It fetches only public-safe fields from the cached{" "}
          <span className="font-mono">/flags</span> endpoint and fails silently
          on any DOM change.
        </p>
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-low">
            Variant
          </span>
          <div className="flex gap-1">
            {(["default", "tangy"] as const).map((variant) => {
              const active =
                (data.values?.jellyfin_inject_variant ?? "default") === variant;
              return (
                <Button
                  key={variant}
                  size="sm"
                  variant={active ? "primary" : "ghost"}
                  onClick={async () => {
                    if (active) return;
                    await endpoints.updateSettings({
                      values: { jellyfin_inject_variant: variant },
                    });
                    toast(
                      variant === "tangy"
                        ? "TangyTheme snippet selected"
                        : "Default snippet selected",
                    );
                    qc.invalidateQueries();
                  }}
                >
                  {variant === "default" ? "Default" : "TangyTheme"}
                </Button>
              );
            })}
          </div>
        </div>
        <p className="mb-2 text-[11px] leading-relaxed text-ink-low">
          Re-paste the snippet into Jellyfin&apos;s Custom JavaScript field when
          you switch variants.
        </p>
        <code className="block rounded border border-line-subtle bg-bg-inset px-3 py-2 font-mono text-[11.5px] text-ink-hi">
          &lt;script src="{`{sweeparr}`}
          /static/inject/
          {(data.values?.jellyfin_inject_variant ?? "default") === "tangy"
            ? "sweeparr-tangy.js"
            : "sweeparr.js"}
          "&gt;&lt;/script&gt;
        </code>
      </Card>
    </div>
  );
}
