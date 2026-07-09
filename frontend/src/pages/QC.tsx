import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endpoints, unitSnapshot } from "../lib/api";
import { PageHeader } from "./Dashboard";
import {
  Card,
  SectionLabel,
  Button,
  Skeleton,
  EmptyState,
} from "../components/ui";
import { Popover } from "../components/Popover";
import { StatusPill } from "../components/StatusPill";
import { useToast } from "../components/Toast";
import { gb } from "../lib/format";

// A manual keep already reads "KEPT"; only non-keep protections need a suffix.
const PROTECTION_LABEL: Record<string, string> = {
  favorite: "favorite",
  tag: "tag",
  airing: "airing",
  request_window: "requested",
  unmanaged: "unmanaged",
};

export function QC() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: rulesData } = useQuery({
    queryKey: ["rules"],
    queryFn: endpoints.rules,
  });
  const [ruleId, setRuleId] = useState<number | null>(null);
  const rules = rulesData?.rules ?? [];

  useEffect(() => {
    if (ruleId == null && rules.length) {
      const first = rules.find((r: any) => r.enabled) ?? rules[0];
      setRuleId(first.id);
    }
  }, [rules, ruleId]);

  const { data, isLoading } = useQuery({
    queryKey: ["qc", ruleId],
    queryFn: () => endpoints.qc(ruleId!),
    enabled: ruleId != null,
  });

  async function keep(m: any) {
    const before = unitSnapshot(m);
    await endpoints.keepUnit(m.unit_type, m.unit_id);
    toast(`Kept ${m.title}`, async () => {
      await endpoints.restore(m.unit_type, m.unit_id, before);
      qc.invalidateQueries();
    });
    qc.invalidateQueries();
  }

  async function delay(m: any) {
    const before = unitSnapshot(m);
    try {
      await endpoints.delay(m.unit_type, m.unit_id);
      toast(`Delayed ${m.title}`, async () => {
        await endpoints.restore(m.unit_type, m.unit_id, before);
        qc.invalidateQueries();
      });
    } catch {
      toast("Cannot delay");
    }
    qc.invalidateQueries();
  }

  const spark = data?.sparkline ?? [];
  const max = Math.max(1, ...spark.map((s: any) => s.count));

  return (
    <div>
      <PageHeader
        title="Rule QC"
        subtitle={`observability, not approval — "is this rule behaving?"`}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {rules.map((r: any) => (
          <button
            key={r.id}
            onClick={() => setRuleId(r.id)}
            className={`rounded-pill border px-3 py-1 text-[12px] ${
              r.id === ruleId
                ? "border-[rgba(91,141,239,0.4)] bg-accent-subtle text-ink-hi"
                : "border-line text-ink-mid"
            }`}
          >
            {r.name}
          </button>
        ))}
      </div>

      {isLoading || !data ? (
        <Skeleton rows={5} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-[1fr_1.15fr] gap-4">
            <Card className="!p-3">
              <div className="mb-2.5 flex items-center gap-2.5">
                <span className="text-[13px] font-semibold text-ink-hi">
                  {data.rule.name}
                </span>
                <span className="ml-auto font-mono text-[11px] text-ink-mid">
                  {data.rule.match_count} matches
                </span>
              </div>
              <SectionLabel>Match count · {spark.length} days</SectionLabel>
              <div className="flex h-9 items-end gap-0.5">
                {spark.map((s: any, i: number) => (
                  <span
                    key={i}
                    className="flex-1 rounded-sm"
                    style={{
                      height: `${(s.count / max) * 100}%`,
                      background:
                        i === spark.length - 1
                          ? "#D9A83C"
                          : "rgba(217,168,60,0.4)",
                    }}
                    title={`${s.count}`}
                  />
                ))}
              </div>
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-mid">
                Steady drift upward = healthy staleness accrual. A cliff or
                spike means a condition is wrong.
              </p>
            </Card>
            <Card className="!p-3">
              <div className="mb-2.5 flex items-center gap-2">
                <SectionLabel>Diff vs previous run</SectionLabel>
                <span className="font-mono text-[11px] text-state-kept-ink">
                  +{data.diff.added.length}
                </span>
                <span className="font-mono text-[11px] text-state-muted">
                  −{data.diff.removed.length}
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                {data.diff.added.map((k: string) => (
                  <DiffRow
                    key={k}
                    kind="new"
                    label={k}
                    matches={data.matches}
                  />
                ))}
                {data.diff.removed.map((k: string) => (
                  <DiffRow
                    key={k}
                    kind="out"
                    label={k}
                    matches={data.matches}
                  />
                ))}
                {data.diff.added.length === 0 &&
                  data.diff.removed.length === 0 && (
                    <div className="text-[12px] text-ink-mid">
                      No change since the last run.
                    </div>
                  )}
              </div>
            </Card>
          </div>

          {data.matches.length === 0 ? (
            <EmptyState title="No matches yet">
              The rule runs nightly — check back after the next evaluation.
            </EmptyState>
          ) : (
            <div className="overflow-hidden rounded-lg border border-line bg-bg">
              <div className="grid grid-cols-[minmax(180px,1.4fr)_180px_100px_1fr_170px] gap-x-3 border-b border-line-subtle px-6 py-2">
                {["TITLE", "STATE", "FREES", "SNAPSHOT", "ACTION"].map(
                  (h, i) => (
                    <span
                      key={i}
                      className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-low"
                    >
                      {h}
                    </span>
                  ),
                )}
              </div>
              {data.matches.map((m: any) => (
                <div
                  key={m.key}
                  className="grid grid-cols-[minmax(180px,1.4fr)_180px_100px_1fr_170px] items-center gap-x-3 border-b border-[#141A26] px-6 py-2"
                >
                  <span className="text-[13px] font-medium text-ink-hi">
                    {m.title}
                    {m.season_number ? (
                      <span className="ml-1 font-mono text-[10.5px] text-accent-hover">
                        S{m.season_number}
                      </span>
                    ) : null}
                  </span>
                  <span>
                    {m.protected ? (
                      <StatusPill
                        state="KEPT"
                        size="sm"
                        reason={PROTECTION_LABEL[m.protections?.[0]?.kind]}
                      />
                    ) : (
                      <StatusPill
                        state={m.state}
                        size="sm"
                        delayCount={m.delay_count}
                      />
                    )}
                  </span>
                  <span className="font-mono text-[12px] text-ink-hi">
                    {gb(m.size_gb)}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11.5px] text-ink-mid">
                    <span className="font-mono">
                      {Object.entries(m.snapshot || {})
                        .slice(0, 1)
                        .map(([k, v]: any) => `${k}=${v.value}`)}
                    </span>
                    <Popover ruleName={data.rule.name} snapshot={m.snapshot} />
                  </span>
                  <span className="flex justify-end gap-1.5">
                    {!m.protected && (
                      <>
                        <Button
                          size="sm"
                          variant="keep"
                          onClick={() => keep(m)}
                        >
                          ✓ Keep
                        </Button>
                        <Button size="sm" onClick={() => delay(m)}>
                          Delay
                        </Button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiffRow({
  kind,
  label,
  matches,
}: {
  kind: "new" | "out";
  label: string;
  matches: any[];
}) {
  const m = matches.find((x) => x.key === label);
  const title = m
    ? `${m.title}${m.season_number ? ` S${m.season_number}` : ""}`
    : label;
  return (
    <div
      className="flex items-center gap-2.5 rounded px-2.5 py-1.5"
      style={{
        background:
          kind === "new" ? "rgba(63,162,111,0.07)" : "rgba(107,116,135,0.06)",
        borderLeft: `3px solid ${kind === "new" ? "#3FA26F" : "#6B7487"}`,
      }}
    >
      <span
        className={`font-mono text-[11.5px] ${kind === "new" ? "text-state-kept-ink" : "text-state-muted"}`}
      >
        {kind === "new" ? "+ new" : "− out"}
      </span>
      <span
        className={`text-[12px] font-medium ${kind === "out" ? "text-ink-mid line-through" : "text-ink-hi"}`}
      >
        {title}
      </span>
    </div>
  );
}
