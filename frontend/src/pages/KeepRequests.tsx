import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Button, Chip, EmptyState, Poster, Skeleton } from "../components/ui";
import { StatusPill } from "../components/StatusPill";
import { useToast } from "../components/Toast";
import { gb } from "../lib/format";

export function KeepRequests() {
  const [tab, setTab] = useState<"kept" | "requests">("kept");
  return (
    <div>
      <PageHeader
        title="Keeps"
        subtitle="manage everything you've flagged to keep, plus household keep requests"
      />
      <div className="mb-4 flex gap-2">
        <Chip active={tab === "kept"} onClick={() => setTab("kept")}>
          Flagged Keeps
        </Chip>
        <Chip active={tab === "requests"} onClick={() => setTab("requests")}>
          Requests
        </Chip>
      </div>
      {tab === "kept" ? <FlaggedKeeps /> : <Requests />}
    </div>
  );
}

function FlaggedKeeps() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["kept"],
    queryFn: endpoints.kept,
  });
  const units = data?.units ?? [];

  async function release(u: any) {
    await endpoints.release(u.unit_type, u.unit_id);
    toast(`Released ${u.title} — back to evaluation`, async () => {
      await endpoints.keepUnit(u.unit_type, u.unit_id, {
        reason: u.keep_reason ?? undefined,
      });
      qc.invalidateQueries();
    });
    qc.invalidateQueries();
  }

  if (isLoading) return <Skeleton rows={3} />;
  if (units.length === 0)
    return (
      <EmptyState title="Nothing flagged to keep">
        Keep an item from the schedule, the drawer, or by approving a request,
        and it will appear here — off-limits to rules until you release it.
      </EmptyState>
    );

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center gap-3 border-b border-line-subtle bg-bg-raised px-6 py-3 text-[12.5px] text-ink-mid">
        <span>
          {units.length} kept · {gb(data?.total_gb)} held from removal
        </span>
      </div>
      {units.map((u: any) => (
        <div
          key={u.key}
          className="flex items-center gap-3 border-b border-[#141A26] px-6 py-2.5"
        >
          <Poster size={40} src={u.poster_url} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-ink-hi">
              {u.title}
              {u.season_number ? (
                <span className="ml-1 rounded bg-accent-subtle px-1.5 py-0.5 font-mono text-[10.5px] text-accent-hover">
                  S{u.season_number}
                </span>
              ) : null}
            </div>
            <div className="text-[11.5px] text-ink-low">
              {u.unit_type === "season" ? "TV" : "Movie"} · {gb(u.size_gb)}
              {u.keep_reason ? ` · ${u.keep_reason}` : ""}
            </div>
          </div>
          <StatusPill state="KEPT" size="sm" />
          <Button size="sm" onClick={() => release(u)}>
            Release
          </Button>
        </div>
      ))}
    </div>
  );
}

function Requests() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("pending");
  const { data, isLoading } = useQuery({
    queryKey: ["keep-requests", status],
    queryFn: () => endpoints.keepRequests(status),
  });
  const krs = data?.keep_requests ?? [];

  async function approve(id: number) {
    await endpoints.approveKeep(id);
    toast("Keep approved — kept indefinitely");
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
        <EmptyState title={`No ${status === "all" ? "" : status} keep requests`}>
          Users can request to keep items from the Jellyfin banner. Approving
          one keeps the item indefinitely until you release it.
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
                    approve = keep indefinitely
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
