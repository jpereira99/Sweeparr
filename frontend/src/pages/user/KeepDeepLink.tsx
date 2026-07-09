import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, endpoints } from "../../lib/api";
import { fmtDate, gb } from "../../lib/format";

type Result =
  | { kind: "kept" }
  | { kind: "delayed"; delayUntil?: string; remaining?: number }
  | { kind: "capped" };

// The mobile keep-request flow (§08): pre-authenticated to the item, one tap.
export function KeepDeepLink() {
  const { token } = useParams();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["keep-token", token],
    queryFn: () => api.get(`/api/v1/keep/${token}`),
    retry: false,
  });

  async function submitKeep() {
    if (!data || !token) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/keep/${token}`, { reason: note });
      setResult({ kind: "kept" });
    } finally {
      setBusy(false);
    }
  }

  async function submitDelay() {
    if (!data || !token) return;
    setBusy(true);
    try {
      const r = await endpoints.delayByToken(token, { reason: note });
      if (r?.capped) setResult({ kind: "capped" });
      else
        setResult({
          kind: "delayed",
          delayUntil: r?.delete_at,
          remaining: r?.delay_remaining,
        });
    } finally {
      setBusy(false);
    }
  }

  const alreadyHandled = data && data.status !== "pending";
  const showKeepSuccess = result?.kind === "kept" || alreadyHandled;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-[320px] overflow-hidden rounded-[18px] border border-line bg-bg-inset">
        {isLoading ? (
          <div className="p-8 text-center font-mono text-ink-low">Loading…</div>
        ) : isError || !data ? (
          <div className="p-8 text-center text-ink-mid">
            This link has expired or the item is no longer leaving.
          </div>
        ) : showKeepSuccess ? (
          <div className="flex min-h-[330px] flex-col p-4">
            <div className="mx-auto mb-3.5 mt-6 flex h-11 w-11 items-center justify-center rounded-pill border border-[rgba(63,162,111,0.45)] bg-[rgba(63,162,111,0.16)] text-lg text-state-kept-ink">
              ✓
            </div>
            <div className="mb-1.5 text-center text-[15px] font-semibold text-ink-hi">
              Request sent
            </div>
            <div className="mb-4 text-center text-[12px] leading-relaxed text-ink-mid">
              {data.title}
              {data.season_number ? ` S${data.season_number}` : ""} stays put
              until an admin decides.{" "}
              <strong className="text-ink-hi">
                Deletion is paused for this item
              </strong>{" "}
              while your request is pending.
            </div>
            <div className="rounded-lg border border-line-subtle bg-bg-raised p-2.5 text-[11.5px] leading-relaxed text-ink-mid">
              You'll get a Jellyfin notification when it's decided.
            </div>
          </div>
        ) : result?.kind === "delayed" ? (
          <div className="flex min-h-[330px] flex-col p-4">
            <div className="mx-auto mb-3.5 mt-6 flex h-11 w-11 items-center justify-center rounded-pill border border-[rgba(229,72,77,0.4)] bg-[rgba(229,72,77,0.14)] text-lg text-state-scheduled-ink">
              ⏱
            </div>
            <div className="mb-1.5 text-center text-[15px] font-semibold text-ink-hi">
              Removal delayed
            </div>
            <div className="mb-4 text-center text-[12px] leading-relaxed text-ink-mid">
              {data.title}
              {data.season_number ? ` S${data.season_number}` : ""} now leaves{" "}
              <strong className="text-ink-hi">
                {fmtDate(result.delayUntil)}
              </strong>
              .
            </div>
            <div className="rounded-lg border border-line-subtle bg-bg-raised p-2.5 text-[11.5px] leading-relaxed text-ink-mid">
              {result.remaining && result.remaining > 0
                ? `You can delay ${result.remaining} more time${result.remaining === 1 ? "" : "s"}.`
                : "You've used all available delays for this item."}
            </div>
          </div>
        ) : result?.kind === "capped" ? (
          <div className="flex min-h-[330px] flex-col p-4">
            <div className="mb-1.5 mt-8 text-center text-[15px] font-semibold text-ink-hi">
              No delays left
            </div>
            <div className="mb-4 text-center text-[12px] leading-relaxed text-ink-mid">
              You've used all available delays for {data.title}
              {data.season_number ? ` S${data.season_number}` : ""}.
              {data.allow_keep ? " You can still request to keep it." : ""}
            </div>
            {data.allow_keep && (
              <button
                onClick={submitKeep}
                disabled={busy}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-[rgba(63,162,111,0.5)] bg-[rgba(63,162,111,0.18)] text-[14px] font-semibold text-state-kept-ink disabled:opacity-60"
              >
                ✓ Request to keep
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="poster-placeholder relative flex h-28 items-end overflow-hidden">
              {data.poster_url && (
                <img
                  src={data.poster_url}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              <div className="relative w-full bg-gradient-to-t from-bg-inset to-transparent p-3.5">
                <div className="text-[15px] font-semibold text-ink-hi">
                  {data.title}
                  {data.season_number ? ` — Season ${data.season_number}` : ""}
                </div>
                <div className="font-mono text-[10.5px] text-ink-mid">
                  {gb(data.size_gb)}
                </div>
              </div>
            </div>
            <div className="p-4">
              <span className="inline-flex items-center gap-1.5 rounded-pill border border-[rgba(229,72,77,0.4)] bg-[rgba(229,72,77,0.14)] px-2.5 py-1 text-[10.5px] font-semibold text-state-scheduled-ink">
                ⏱ LEAVES {fmtDate(data.delete_at).toUpperCase()}
              </span>
              <div className="my-2.5 text-[12px] text-ink-mid">
                Why: {data.reason_public}
              </div>
              <div className="my-2.5 h-px bg-line-subtle" />
              <div className="mb-1.5 text-[11px] text-ink-low">
                Add a note (optional)
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="mb-3 h-16 w-full rounded-lg border border-line bg-bg p-2 text-[12px] text-ink-hi outline-none focus:border-accent"
              />
              {data.allow_delay && (
                <button
                  onClick={submitDelay}
                  disabled={busy}
                  className="mb-2.5 flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-[rgba(229,72,77,0.5)] bg-[rgba(229,72,77,0.16)] text-[14px] font-semibold text-state-scheduled-ink disabled:opacity-60"
                >
                  ⏱ Delay {data.delay_days} days
                </button>
              )}
              {data.allow_keep && (
                <button
                  onClick={submitKeep}
                  disabled={busy}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-[rgba(63,162,111,0.5)] bg-[rgba(63,162,111,0.18)] text-[14px] font-semibold text-state-kept-ink disabled:opacity-60"
                >
                  ✓ Request to keep
                </button>
              )}
              {!data.allow_keep && !data.allow_delay && (
                <div className="rounded-lg border border-line-subtle bg-bg-raised p-2.5 text-center text-[11.5px] leading-relaxed text-ink-mid">
                  Reach out to your admin to keep this item.
                </div>
              )}
              <div className="mt-2.5 text-center text-[11px] text-ink-low">
                Signed in as {data.requester ?? "you"} via Jellyfin
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
