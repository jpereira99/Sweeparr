import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Card, SectionLabel, Button, Toggle, Skeleton } from "../components/ui";
import { useToast } from "../components/Toast";

const SERVICES = [
  "jellyfin",
  "jellyseerr",
  "sonarr",
  "radarr",
  "ntfy",
] as const;

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
  const [delayDraft, setDelayDraft] = useState<{
    days?: number;
    max?: number;
  }>({});

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
            <div className="border-b border-line-subtle px-5 py-4">
              <SectionLabel>Job schedules</SectionLabel>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_88px_56px] items-center gap-x-3 border-b border-line-subtle bg-bg-raised px-5 py-2">
              <span className="text-[10px] font-semibold tracking-[0.08em] text-ink-low">
                JOB
              </span>
              <span className="text-[10px] font-semibold tracking-[0.08em] text-ink-low">
                NEXT RUN
              </span>
              <span className="text-right text-[10px] font-semibold tracking-[0.08em] text-ink-low">
                RUN
              </span>
            </div>
            <div className="divide-y divide-line-subtle">
              {(data.jobs ?? []).map((j: any) => (
                <div
                  key={j.name}
                  className="grid grid-cols-[minmax(0,1fr)_88px_56px] items-center gap-x-3 px-5 py-2.5 font-mono text-[11px]"
                >
                  <span className="truncate text-ink-hi">{j.name}</span>
                  <span className="text-ink-mid">
                    {j.paused
                      ? "paused"
                      : j.next_run
                        ? new Date(j.next_run).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—"}
                  </span>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
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
