import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Button, Chip, EmptyState, Skeleton } from "../components/ui";
import { useToast } from "../components/Toast";

export function KeepRequests() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("pending");
  const { data, isLoading } = useQuery({
    queryKey: ["keep-requests", status],
    queryFn: () => endpoints.keepRequests(status),
  });
  const krs = data?.keep_requests ?? [];

  async function approve(id: number) {
    await endpoints.approveKeep(id, { days: 60 });
    toast("Keep approved (+60d)");
    qc.invalidateQueries();
  }
  async function deny(id: number) {
    const reason = prompt("Reason for denial (shown to the requester):");
    if (!reason) return;
    await endpoints.denyKeep(id, { reason });
    toast("Request denied");
    qc.invalidateQueries();
  }

  return (
    <div>
      <PageHeader
        title="Keep Requests"
        subtitle="approve = keep with an optional expiry; on expiry the item re-enters normal evaluation"
      />
      <div className="mb-4 flex gap-2">
        {["pending", "approved", "denied", "all"].map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
            {s}
          </Chip>
        ))}
      </div>
      {isLoading ? (
        <Skeleton rows={3} />
      ) : krs.length === 0 ? (
        <EmptyState
          title={`No ${status === "all" ? "" : status} keep requests`}
        >
          Users can request to keep items from the Jellyfin banner.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {krs.map((k: any) => (
            <div
              key={k.id}
              className="rounded-lg border border-line-subtle bg-bg p-4"
            >
              <div className="mb-1 flex justify-between">
                <span className="text-[13px] font-medium text-ink-hi">
                  {k.title}
                  {k.season_number ? (
                    <span className="ml-1 font-mono text-[10.5px] text-ink-mid">
                      S{k.season_number}
                    </span>
                  ) : null}
                </span>
                {k.days_until != null && (
                  <span className="font-mono text-[10.5px] text-state-scheduled-ink">
                    leaves in {Math.max(0, Math.round(k.days_until))}d
                  </span>
                )}
              </div>
              <div className="mb-3 text-[11.5px] text-ink-mid">
                {k.requester} {k.reason ? `· "${k.reason}"` : ""}
              </div>
              {k.status === "pending" ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="keep"
                    onClick={() => approve(k.id)}
                  >
                    Approve
                  </Button>
                  <Button size="sm" onClick={() => deny(k.id)}>
                    Deny
                  </Button>
                  <span className="ml-auto font-mono text-[10.5px] text-ink-low">
                    keep until: +60d
                  </span>
                </div>
              ) : (
                <span className="font-mono text-[10.5px] uppercase text-ink-low">
                  {k.status}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
