import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints, unitSnapshot } from "../lib/api";
import { StatusPill } from "./StatusPill";
import { Button, Poster } from "./ui";
import { useToast } from "./Toast";
import { fmtDate, fmtDateTime, gb, relDays } from "../lib/format";

// Compact season-grid coloring — mirrors StatusPill's palette without the
// text label, so dozens of seasons stay scannable instead of wrapping as
// full pills.
function seasonChipClasses(state: string, delayCount = 0): string {
  switch (state) {
    case "SCHEDULED":
      return delayCount > 0
        ? "bg-[rgba(217,168,60,0.14)] border-[rgba(217,168,60,0.4)] text-state-candidate-ink"
        : "bg-[rgba(229,72,77,0.14)] border-[rgba(229,72,77,0.4)] text-state-scheduled-ink";
    case "KEPT":
      return "bg-[rgba(63,162,111,0.13)] border-[rgba(63,162,111,0.38)] text-state-kept-ink";
    case "DELETING":
    case "DELETED":
      return "bg-[rgba(107,116,135,0.1)] border-[rgba(107,116,135,0.25)] text-state-muted";
    case "ERROR":
      return "bg-[rgba(247,104,8,0.16)] border-[rgba(247,104,8,0.5)] text-state-error-ink";
    default:
      return "bg-[rgba(139,150,168,0.12)] border-[rgba(139,150,168,0.28)] text-ink-mid";
  }
}

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
  // null = per-series overview (all seasons); a number filters everything
  // below — protections, history, playback, requests, and the action bar —
  // down to that one season.
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const { data } = useQuery({
    queryKey: ["media-detail", itemId],
    queryFn: () => endpoints.mediaDetail(itemId),
  });

  useEffect(() => {
    setSelectedSeason(null);
  }, [itemId]);

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
  const selectedSeasonData = isSeries
    ? (data?.seasons ?? []).find((s: any) => s.season_number === selectedSeason)
    : null;
  // The unit the tabs/action-bar operate on: the movie itself, the selected
  // season, or nothing while viewing the series-wide overview.
  const activeUnit = isSeries ? selectedSeasonData : data;
  const activeLabel = isSeries
    ? `${data?.title} S${selectedSeasonData?.season_number}`
    : data?.title;
  const playbackSource = isSeries ? (selectedSeasonData ?? data) : data;
  const filteredProtections = (data?.protections ?? []).filter((p: any) =>
    selectedSeason === null ? true : p.season_number === selectedSeason,
  );
  const filteredHistory = (data?.history ?? []).filter((h: any) =>
    selectedSeason === null ? true : h.season_number === selectedSeason,
  );
  const filteredRequests = (data?.requests ?? []).filter((r: any) =>
    selectedSeason === null ? true : r.season_number === selectedSeason,
  );

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
                    delayCount={data.delay_count}
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
              <div className="border-b border-line-subtle p-4">
                <button
                  onClick={() => setSelectedSeason(null)}
                  className={`mb-2 w-full rounded border px-2 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                    selectedSeason === null
                      ? "border-accent bg-accent-subtle text-accent-hover"
                      : "border-line-subtle bg-bg-raised text-ink-mid hover:border-ink-low hover:text-ink-hi"
                  }`}
                >
                  All seasons
                </button>
                <div className="grid grid-cols-8 gap-1.5">
                  {data.seasons.map((s: any) => (
                    <button
                      key={s.unit_id}
                      title={`S${s.season_number} · ${
                        s.state === "SCHEDULED" && s.delay_count > 0
                          ? "DELAYED"
                          : s.state
                      }${
                        s.state === "SCHEDULED" && s.delete_at
                          ? " · " + fmtDate(s.delete_at)
                          : ""
                      }`}
                      onClick={() =>
                        setSelectedSeason(
                          selectedSeason === s.season_number
                            ? null
                            : s.season_number,
                        )
                      }
                      className={`flex h-8 items-center justify-center rounded border font-mono text-[11px] font-semibold transition-colors ${seasonChipClasses(
                        s.state,
                        s.delay_count,
                      )} ${
                        selectedSeason === s.season_number
                          ? "ring-2 ring-accent"
                          : "opacity-80 hover:opacity-100"
                      }`}
                    >
                      {s.season_number}
                    </button>
                  ))}
                </div>
                {selectedSeasonData && (
                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="font-mono text-[11px] text-ink-mid">
                      S{selectedSeasonData.season_number}
                    </span>
                    <StatusPill
                      state={selectedSeasonData.state}
                      size="sm"
                      date={selectedSeasonData.delete_at}
                      delayCount={selectedSeasonData.delay_count}
                    />
                  </div>
                )}
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
                  {filteredProtections.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                        Active protections
                      </div>
                      {filteredProtections.map((p: any, i: number) => (
                        <div
                          key={i}
                          className="mb-1 rounded bg-[rgba(63,162,111,0.07)] px-2.5 py-1.5 text-[12px] text-state-kept-ink"
                        >
                          {selectedSeason === null &&
                            p.season_number != null && (
                              <span className="mr-1 font-mono text-[10px] text-ink-low">
                                S{p.season_number}
                              </span>
                            )}
                          {p.kind} —{" "}
                          <span className="text-ink-mid">{p.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
                    Lifecycle history
                  </div>
                  {filteredHistory.length ? (
                    filteredHistory.map((h: any, i: number) => (
                      <div
                        key={i}
                        className="flex justify-between rounded bg-bg-raised px-2.5 py-1.5 font-mono text-[11px] text-ink-mid"
                      >
                        <span>
                          {selectedSeason === null && h.season_number != null
                            ? `S${h.season_number} · `
                            : ""}
                          {h.action}
                        </span>
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
                    value={relDays(playbackSource?.last_watched_days)}
                  />
                  <Row
                    label="Total plays"
                    value={String(playbackSource?.total_plays ?? "—")}
                  />
                  <Row
                    label="Distinct watchers"
                    value={String(playbackSource?.distinct_watchers ?? "—")}
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
                  {isSeries && selectedSeasonData && (
                    <Row
                      label="Season completion"
                      value={
                        selectedSeasonData.pct_season_watched
                          ? `${Math.round(selectedSeasonData.pct_season_watched)}%`
                          : "—"
                      }
                    />
                  )}
                </div>
              )}
              {tab === "request" && (
                <div className="flex flex-col gap-2">
                  {filteredRequests.length ? (
                    filteredRequests.map((r: any, i: number) => (
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

            {activeUnit &&
              (activeUnit.state === "ACTIVE" ||
                activeUnit.state === "SCHEDULED" ||
                activeUnit.state === "ERROR") && (
                <div className="flex gap-2 border-t border-line-subtle p-4">
                  <Button
                    variant="keep"
                    onClick={() => keepUnit(activeUnit, activeLabel)}
                  >
                    ✓ Keep
                  </Button>
                  {activeUnit.state === "SCHEDULED" && (
                    <Button onClick={() => delayUnit(activeUnit, activeLabel)}>
                      Delay
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    onClick={async () => {
                      if (!confirm(`Delete ${activeLabel} now?`)) return;
                      const res = await endpoints.deleteNow(
                        activeUnit.unit_type,
                        activeUnit.unit_id,
                      );
                      const outcome = (res?.result?.results ?? []).find(
                        (r: any) =>
                          r.unit ===
                          `${activeUnit.unit_type}:${activeUnit.unit_id}`,
                      )?.result;
                      if (outcome === "protected_at_execute") {
                        toast(
                          `${activeLabel} is still protected — not deleted`,
                        );
                      } else if (outcome === "held_pending_keep") {
                        toast(
                          `${activeLabel} has a pending keep request — not deleted`,
                        );
                      } else if (outcome === "error") {
                        toast(`Failed to delete ${activeLabel}`);
                      } else {
                        toast(`Deleted ${activeLabel}`);
                      }
                      qc.invalidateQueries();
                    }}
                  >
                    Delete now
                  </Button>
                </div>
              )}
            {activeUnit && activeUnit.state === "KEPT" && (
              <div className="flex gap-2 border-t border-line-subtle p-4">
                <Button onClick={() => releaseUnit(activeUnit, activeLabel)}>
                  Release — return to evaluation
                </Button>
              </div>
            )}
            {isSeries && selectedSeason === null && (
              <div className="border-t border-line-subtle p-4 text-center text-[11.5px] text-ink-low">
                Select a season above to Keep, Delay, or Delete it.
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
