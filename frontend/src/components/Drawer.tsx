import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints, unitSnapshot } from "../lib/api";
import { StatusPill } from "./StatusPill";
import { Button, Poster } from "./ui";
import { useToast } from "./Toast";
import { fmtDateTime, gb, relDays } from "../lib/format";

// The 440px right detail drawer (§03/§06): navigation never leaves the page.
export function Drawer({
  itemId,
  onClose,
}: {
  itemId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<"lifecycle" | "playback" | "request">(
    "lifecycle",
  );
  const { data } = useQuery({
    queryKey: ["media-detail", itemId],
    queryFn: () => endpoints.mediaDetail(itemId),
  });

  async function keepUnit(u: any, title: string) {
    const before = unitSnapshot(u);
    await endpoints.keepUnit(u.unit_type, u.unit_id);
    toast(`Kept ${title}`, async () => {
      await endpoints.restore(u.unit_type, u.unit_id, before);
      qc.invalidateQueries();
    });
    qc.invalidateQueries();
  }

  async function delayUnit(u: any, title: string) {
    const before = unitSnapshot(u);
    try {
      await endpoints.delay(u.unit_type, u.unit_id);
      toast(`Delayed ${title}`, async () => {
        await endpoints.restore(u.unit_type, u.unit_id, before);
        qc.invalidateQueries();
      });
    } catch {
      toast("Cannot delay");
    }
    qc.invalidateQueries();
  }

  async function releaseUnit(u: any, title: string) {
    await endpoints.release(u.unit_type, u.unit_id);
    toast(`Released ${title} — back to evaluation`, async () => {
      await endpoints.keepUnit(u.unit_type, u.unit_id);
      qc.invalidateQueries();
    });
    qc.invalidateQueries();
  }

  const isSeries = data?.type === "series";

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex h-full w-[440px] flex-col border-l border-line bg-bg-overlay shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        {!data ? (
          <div className="p-6 font-mono text-ink-low">Loading…</div>
        ) : (
          <>
            <div className="flex items-start gap-3 border-b border-line-subtle p-5">
              <Poster size={56} src={data.poster_url} />
              <div className="min-w-0 flex-1">
                <div className="text-[16px] font-semibold text-ink-hi">
                  {data.title}
                </div>
                <div className="mb-2 font-mono text-[11.5px] text-ink-mid">
                  {isSeries
                    ? `TV · ${data.series_status ?? ""}`
                    : `Movie · ${data.year ?? ""}`}{" "}
                  · {gb(data.size_gb)}
                </div>
                {!isSeries && (
                  <StatusPill
                    state={data.state}
                    size="sm"
                    date={data.delete_at}
                  />
                )}
              </div>
              <button
                onClick={onClose}
                className="text-ink-low hover:text-ink-hi"
              >
                ✕
              </button>
            </div>

            {isSeries && (
              <div className="flex flex-wrap gap-1.5 border-b border-line-subtle p-4">
                {data.seasons.map((s: any) => (
                  <div
                    key={s.unit_id}
                    className="flex items-center gap-1.5 rounded border border-line-subtle bg-bg-raised px-2 py-1"
                  >
                    <span className="font-mono text-[11px] text-ink-mid">
                      S{s.season_number}
                    </span>
                    <StatusPill state={s.state} size="sm" date={s.delete_at} />
                    {s.state === "SCHEDULED" && (
                      <>
                        <button
                          className="text-[10px] text-state-kept-ink"
                          onClick={() =>
                            keepUnit(s, `${data.title} S${s.season_number}`)
                          }
                        >
                          Keep
                        </button>
                        <button
                          className="text-[10px] text-ink-mid"
                          onClick={() =>
                            delayUnit(s, `${data.title} S${s.season_number}`)
                          }
                        >
                          Delay
                        </button>
                      </>
                    )}
                    {s.state === "KEPT" && (
                      <button
                        className="text-[10px] text-ink-mid"
                        onClick={() =>
                          releaseUnit(s, `${data.title} S${s.season_number}`)
                        }
                      >
                        Release
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-4 border-b border-line-subtle px-5 pt-3 font-mono text-[11.5px]">
              {(["lifecycle", "playback", "request"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`pb-2 capitalize ${tab === t ? "border-b-2 border-accent text-ink-hi" : "text-ink-mid"}`}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto p-5">
              {tab === "lifecycle" && (
                <div className="flex flex-col gap-3">
                  {data.protections?.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                        Active protections
                      </div>
                      {data.protections.map((p: any, i: number) => (
                        <div
                          key={i}
                          className="mb-1 rounded bg-[rgba(63,162,111,0.07)] px-2.5 py-1.5 text-[12px] text-state-kept-ink"
                        >
                          {p.kind} —{" "}
                          <span className="text-ink-mid">{p.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                    Lifecycle history
                  </div>
                  {data.history?.length ? (
                    data.history.map((h: any, i: number) => (
                      <div
                        key={i}
                        className="flex justify-between rounded bg-bg-raised px-2.5 py-1.5 font-mono text-[11px] text-ink-mid"
                      >
                        <span>{h.action}</span>
                        <span className="text-ink-low">
                          {fmtDateTime(h.ts)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-[12px] text-ink-mid">
                      No lifecycle events yet.
                    </div>
                  )}
                </div>
              )}
              {tab === "playback" && (
                <div className="flex flex-col gap-2 text-[12.5px]">
                  <Row
                    label="Last watched"
                    value={relDays(data.last_watched_days)}
                  />
                  <Row
                    label="Total plays"
                    value={String(data.total_plays ?? "—")}
                  />
                  <Row
                    label="Distinct watchers"
                    value={String(data.distinct_watchers ?? "—")}
                  />
                  {!isSeries && (
                    <Row
                      label="Max completion"
                      value={
                        data.max_completion_pct
                          ? `${Math.round(data.max_completion_pct)}%`
                          : "—"
                      }
                    />
                  )}
                </div>
              )}
              {tab === "request" && (
                <div className="flex flex-col gap-2">
                  {data.requests?.length ? (
                    data.requests.map((r: any, i: number) => (
                      <div
                        key={i}
                        className="rounded bg-bg-raised px-2.5 py-2 text-[12px]"
                      >
                        <div className="text-ink-hi">
                          Requested by {r.requester ?? "unknown"}
                        </div>
                        <div className="font-mono text-[11px] text-ink-low">
                          {r.season_number ? `S${r.season_number} · ` : ""}
                          {fmtDateTime(r.requested_at)} · {r.status}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-[12px] text-ink-mid">
                      No linked Jellyseerr request.
                    </div>
                  )}
                </div>
              )}
            </div>

            {!isSeries && data.state === "SCHEDULED" && (
              <div className="flex gap-2 border-t border-line-subtle p-4">
                <Button variant="keep" onClick={() => keepUnit(data, data.title)}>
                  ✓ Keep
                </Button>
                <Button onClick={() => delayUnit(data, data.title)}>Delay</Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${data.title} now?`)) return;
                    await endpoints.deleteNow("movie", data.unit_id);
                    toast("Delete requested");
                    qc.invalidateQueries();
                  }}
                >
                  Delete now
                </Button>
              </div>
            )}
            {!isSeries && data.state === "KEPT" && (
              <div className="flex gap-2 border-t border-line-subtle p-4">
                <Button onClick={() => releaseUnit(data, data.title)}>
                  Release — return to evaluation
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-line-subtle py-1.5">
      <span className="text-ink-mid">{label}</span>
      <span className="font-mono text-ink-hi">{value}</span>
    </div>
  );
}
