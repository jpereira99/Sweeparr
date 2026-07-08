import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { fmtDate, gb } from "../../lib/format";

// The mobile keep-request flow (§08): pre-authenticated to the item, one tap.
export function KeepDeepLink() {
  const { token } = useParams();
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState("");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["keep-token", token],
    queryFn: () => api.get(`/api/v1/keep/${token}`),
    retry: false,
  });

  async function submit() {
    if (!data || !token) return;
    await api.post(`/api/v1/keep/${token}`, { reason: note });
    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="w-[320px] overflow-hidden rounded-[18px] border border-line bg-bg-inset">
        {isLoading ? (
          <div className="p-8 text-center font-mono text-ink-low">Loading…</div>
        ) : isError || !data ? (
          <div className="p-8 text-center text-ink-mid">
            This link has expired or the item is no longer leaving.
          </div>
        ) : sent || data.status !== "pending" ? (
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
        ) : (
          <>
            <div className="poster-placeholder relative flex h-28 items-end">
              <div className="w-full bg-gradient-to-t from-bg-inset to-transparent p-3.5">
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
              <button
                onClick={submit}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] border border-[rgba(63,162,111,0.5)] bg-[rgba(63,162,111,0.18)] text-[14px] font-semibold text-state-kept-ink"
              >
                ✓ Request to keep
              </button>
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
