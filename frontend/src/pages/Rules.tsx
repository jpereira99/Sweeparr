import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { endpoints } from "../lib/api";
import { PageHeader } from "./Dashboard";
import { Button, EmptyState, Skeleton, Toggle } from "../components/ui";
import { Popover } from "../components/Popover";
import { useToast } from "../components/Toast";
import { gb } from "../lib/format";

type Cond = {
  field?: string;
  cmp?: string;
  value?: any;
  op?: string;
  conditions?: Cond[];
};

type RulePreset = {
  id: string;
  name: string;
  description: string;
  target: "movie" | "season" | "series";
  conditions: Cond;
  grace_days?: number;
  notify_requester?: boolean;
};

const RULE_PRESETS: RulePreset[] = [
  {
    id: "blank",
    name: "Blank rule",
    description: "Start with an empty condition tree and build from scratch.",
    target: "movie",
    conditions: { op: "AND", conditions: [] },
  },
  {
    id: "stale-movies",
    name: "Stale movies",
    description: "Added 120+ days ago and not watched in the last 90 days.",
    target: "movie",
    grace_days: 30,
    conditions: {
      op: "AND",
      conditions: [
        { field: "age_days", cmp: ">=", value: 120 },
        { field: "last_watched_days", cmp: ">=", value: 90 },
      ],
    },
  },
  {
    id: "never-played-requests",
    name: "Never-played requests",
    description:
      "Requested 90+ days ago with zero plays — notifies the requester.",
    target: "movie",
    grace_days: 21,
    notify_requester: true,
    conditions: {
      op: "AND",
      conditions: [
        { field: "was_requested", cmp: "==", value: true },
        { field: "total_plays", cmp: "==", value: 0 },
        { field: "requested_days_ago", cmp: ">=", value: 90 },
      ],
    },
  },
  {
    id: "watched-and-done",
    name: "Watched and done",
    description:
      "Finished movies (85%+ completion) not rewatched in 60 days, excluding favorites.",
    target: "movie",
    grace_days: 30,
    conditions: {
      op: "AND",
      conditions: [
        { field: "max_completion_pct", cmp: ">=", value: 85 },
        { field: "last_watched_days", cmp: ">=", value: 60 },
        { field: "is_favorite_any_user", cmp: "==", value: false },
      ],
    },
  },
  {
    id: "big-and-unwatched",
    name: "Big and unwatched",
    description: "Large files (20+ GB) with zero plays added 90+ days ago.",
    target: "movie",
    grace_days: 14,
    conditions: {
      op: "AND",
      conditions: [
        { field: "size_gb", cmp: ">=", value: 20 },
        { field: "total_plays", cmp: "==", value: 0 },
        { field: "age_days", cmp: ">=", value: 90 },
      ],
    },
  },
  {
    id: "stale-seasons",
    name: "Stale seasons",
    description:
      "Older seasons not watched in 120 days — skips the latest season.",
    target: "season",
    grace_days: 30,
    conditions: {
      op: "AND",
      conditions: [
        { field: "season_age_days", cmp: ">=", value: 180 },
        { field: "season_last_watched_days", cmp: ">=", value: 120 },
        { field: "is_latest_season", cmp: "==", value: false },
      ],
    },
  },
  {
    id: "ended-and-watched",
    name: "Ended and fully watched",
    description:
      "Completed seasons from ended series, 90%+ watched, not rewatched in 90 days.",
    target: "season",
    grace_days: 45,
    conditions: {
      op: "AND",
      conditions: [
        { field: "series_status", cmp: "==", value: "ended" },
        { field: "pct_season_watched", cmp: ">=", value: 90 },
        { field: "season_last_watched_days", cmp: ">=", value: 90 },
      ],
    },
  },
];

const RULE_SAVE_KEYS = [
  "name",
  "target",
  "library",
  "conditions",
  "grace_days",
  "notify_requester",
  "notify_admin",
  "add_import_list_exclusion",
  "mirror_arr_tags",
  "disk_overrides",
] as const;

function rulePayload(rule: Record<string, unknown>) {
  return Object.fromEntries(
    RULE_SAVE_KEYS.filter((k) => k in rule).map((k) => [k, rule[k]]),
  );
}

function rulesEqual(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
) {
  if (!a || !b) return a === b;
  return JSON.stringify(rulePayload(a)) === JSON.stringify(rulePayload(b));
}

export function RulesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const params = useParams();
  const { data, isLoading } = useQuery({
    queryKey: ["rules"],
    queryFn: endpoints.rules,
  });
  const { data: catalog } = useQuery({
    queryKey: ["catalog"],
    queryFn: endpoints.catalog,
  });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newRuleModal, setNewRuleModal] = useState(false);
  const [creating, setCreating] = useState(false);

  const rules = data?.rules ?? [];
  useEffect(() => {
    if (params.id) setSelectedId(Number(params.id));
    else if (rules.length && selectedId == null) setSelectedId(rules[0].id);
  }, [params.id, rules, selectedId]);

  const selected = rules.find((r: any) => r.id === selectedId);

  async function createFromPreset(preset: RulePreset) {
    setCreating(true);
    try {
      const created = await endpoints.createRule({
        name: preset.id === "blank" ? "New rule" : preset.name,
        target: preset.target,
        conditions: preset.conditions,
        grace_days: preset.grace_days ?? 30,
        ...(preset.notify_requester != null
          ? { notify_requester: preset.notify_requester }
          : {}),
      });
      await qc.invalidateQueries({ queryKey: ["rules"] });
      setSelectedId(created.id);
      setNewRuleModal(false);
      toast(`Created "${created.name}"`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Rules — condition builder"
        subtitle="preview against your catalog, then turn a rule on when you're ready"
      />
      {isLoading ? (
        <Skeleton rows={6} />
      ) : rules.length === 0 ? (
        <EmptyState title="No rules yet">
          Create a rule from a preset or start blank — new rules begin disabled
          until you turn them on.
          <div className="mt-3 flex justify-center">
            <Button onClick={() => setNewRuleModal(true)}>Create rule</Button>
          </div>
        </EmptyState>
      ) : (
        <Builder
          rules={rules}
          selected={selected}
          catalog={catalog}
          onSelect={setSelectedId}
          onNew={() => setNewRuleModal(true)}
          toast={toast}
          qc={qc}
        />
      )}
      {newRuleModal && (
        <NewRuleModal
          presets={RULE_PRESETS}
          creating={creating}
          onSelect={createFromPreset}
          onCancel={() => setNewRuleModal(false)}
        />
      )}
    </div>
  );
}

function Builder({
  rules,
  selected,
  catalog,
  onSelect,
  onNew,
  toast,
  qc,
}: any) {
  const [draft, setDraft] = useState<any>(selected);
  const [preview, setPreview] = useState<any>(null);
  const [previewStale, setPreviewStale] = useState(false);
  const [enableModal, setEnableModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [previewModal, setPreviewModal] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const previewDebounce = useRef<any>();
  const autosaveDebounce = useRef<any>();
  const autosaveSeq = useRef(0);
  const draftRef = useRef<any>(selected);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!selected) return;

    if (
      draftRef.current?.id != null &&
      draftRef.current.id !== selected.id &&
      !draftRef.current.enabled
    ) {
      clearTimeout(autosaveDebounce.current);
      const snapshot = draftRef.current;
      const serverRule = rules.find((r: any) => r.id === snapshot.id);
      if (!serverRule || !rulesEqual(snapshot, serverRule)) {
        void endpoints.updateRule(snapshot.id, rulePayload(snapshot));
      }
    }

    setDraft((prev: any) => {
      if (prev?.id !== selected.id) return selected;
      return { ...prev, enabled: selected.enabled };
    });
  }, [selected?.id, selected?.enabled, selected, rules]);

  useEffect(() => {
    if (!draft || draft.enabled || !selected) return;
    if (rulesEqual(draft, selected)) {
      setSaveStatus("idle");
      return;
    }

    setSaveStatus("saving");
    clearTimeout(autosaveDebounce.current);
    autosaveDebounce.current = setTimeout(async () => {
      const seq = ++autosaveSeq.current;
      const snapshot = draftRef.current;
      if (!snapshot || snapshot.enabled) return;
      try {
        await endpoints.updateRule(snapshot.id, rulePayload(snapshot));
        if (seq !== autosaveSeq.current) return;
        await qc.invalidateQueries({ queryKey: ["rules"] });
        setSaveStatus("saved");
      } catch {
        if (seq === autosaveSeq.current) setSaveStatus("idle");
      }
    }, 800);

    return () => clearTimeout(autosaveDebounce.current);
  }, [draft, selected, qc]);

  useEffect(() => {
    return () => {
      clearTimeout(autosaveDebounce.current);
      const snapshot = draftRef.current;
      if (!snapshot || snapshot.enabled) return;
      void endpoints.updateRule(snapshot.id, rulePayload(snapshot));
    };
  }, []);

  useEffect(() => {
    if (!draft) return;
    setPreviewStale(true);
    clearTimeout(previewDebounce.current);
    previewDebounce.current = setTimeout(async () => {
      try {
        const r = await endpoints.preview({
          target: draft.target,
          library: draft.library,
          conditions: draft.conditions,
        });
        setPreview(r);
        setPreviewStale(false);
      } catch {
        setPreviewStale(false);
      }
    }, 400);
    return () => clearTimeout(previewDebounce.current);
  }, [draft?.conditions, draft?.target, draft?.library]);

  if (!draft) return null;

  const update = (patch: any) => setDraft((d: any) => ({ ...d, ...patch }));
  const isDirty = !rulesEqual(draft, selected);

  async function flushAutosave() {
    clearTimeout(autosaveDebounce.current);
    const snapshot = draftRef.current;
    if (!snapshot || snapshot.enabled) return;
    const serverRule = rules.find((r: any) => r.id === snapshot.id);
    if (serverRule && rulesEqual(snapshot, serverRule)) return;
    await endpoints.updateRule(snapshot.id, rulePayload(snapshot));
    await qc.invalidateQueries({ queryKey: ["rules"] });
  }

  async function save() {
    await endpoints.updateRule(draft.id, rulePayload(draft));
    await qc.invalidateQueries({ queryKey: ["rules"] });
    toast("Rule saved");
  }

  async function toggleEnabled(on: boolean) {
    if (on) {
      if (!draft.enabled && isDirty) await flushAutosave();
      await endpoints.enableRule(draft.id);
      setDraft((d: any) => ({ ...d, enabled: true }));
      toast(`Enabled "${draft.name}" — matches are now scheduled`);
    } else {
      if (isDirty) await save();
      await endpoints.disableRule(draft.id);
      setDraft((d: any) => ({ ...d, enabled: false }));
      toast(`Disabled "${draft.name}" — scheduled units reverted`);
    }
    await qc.invalidateQueries({ queryKey: ["rules"] });
    setEnableModal(false);
  }

  async function doDelete() {
    await endpoints.deleteRule(draft.id);
    await qc.invalidateQueries();
    setDeleteModal(false);
    toast(`Deleted "${draft.name}"`);
    const remaining = rules.filter((r: any) => r.id !== draft.id);
    onSelect(remaining[0]?.id ?? null);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center gap-4 border-b border-line-subtle bg-bg-raised px-6 py-3.5">
        <label
          title="Rule name — click to edit"
          className="group flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-1.5 transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent hover:border-ink-low"
        >
          <input
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Rule name"
            className="w-48 bg-transparent text-[16px] font-semibold text-ink-hi outline-none placeholder:text-ink-faint"
          />
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-none text-ink-low transition-colors group-focus-within:text-accent group-hover:text-ink-mid"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </label>
        <span
          className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[11px] font-bold tracking-[0.06em] ${
            draft.enabled
              ? "border border-[rgba(229,72,77,0.4)] bg-[rgba(229,72,77,0.14)] text-state-scheduled-ink"
              : "border border-[rgba(139,150,168,0.28)] bg-[rgba(139,150,168,0.12)] text-ink-mid"
          }`}
        >
          {draft.enabled ? "● ON" : "○ OFF"}
        </span>
        {!draft.enabled && saveStatus !== "idle" && (
          <span className="text-[11px] text-ink-low" aria-live="polite">
            {saveStatus === "saving" ? "Saving…" : "Saved"}
          </span>
        )}
        {draft.enabled && isDirty && (
          <span className="text-[11px] text-state-scheduled-ink">
            Unsaved changes
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] text-ink-mid">
            <span>Rule</span>
            <Toggle
              on={draft.enabled}
              onChange={(v) => {
                if (v && !draft.enabled) setEnableModal(true);
                else if (!v && draft.enabled) toggleEnabled(false);
              }}
            />
          </label>
          {draft.enabled && (
            <Button onClick={save} disabled={!isDirty}>
              Save
            </Button>
          )}
          <Button variant="danger" onClick={() => setDeleteModal(true)}>
            Delete
          </Button>
        </div>
      </div>

      <div className="flex min-h-[420px]">
        <div className="flex w-52 flex-none flex-col gap-1 border-r border-line-subtle bg-bg-inset p-3">
          <div className="flex items-center justify-between px-1.5 pb-2">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-low">
              RULES
            </span>
            <button
              onClick={onNew}
              className="text-[12px] font-semibold text-accent"
            >
              + New
            </button>
          </div>
          {rules.map((r: any) => {
            const enabled = r.id === draft.id ? draft.enabled : r.enabled;
            return (
              <button
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={`rounded p-2.5 text-left ${r.id === draft.id ? "border border-line bg-bg-raised" : ""}`}
              >
                <div
                  className={`mb-1.5 text-[12.5px] font-medium ${r.id === draft.id ? "text-ink-hi" : "text-ink-mid"}`}
                >
                  {r.name}
                </div>
                <span
                  className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[9.5px] font-bold tracking-[0.06em] ${
                    enabled
                      ? "border border-[rgba(229,72,77,0.4)] bg-[rgba(229,72,77,0.14)] text-state-scheduled-ink"
                      : "border border-[rgba(139,150,168,0.28)] bg-[rgba(139,150,168,0.12)] text-ink-mid"
                  }`}
                >
                  {enabled ? "ON" : "OFF"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="min-w-0 flex-1 p-6">
          {!draft.enabled && (
            <div className="mb-3.5 rounded border border-[rgba(91,141,239,0.35)] bg-accent-subtle px-3 py-2 text-[12px] text-accent-hover">
              This rule is off — use the live preview to test it, then turn it
              on when you're satisfied.
            </div>
          )}
          {draft.enabled && (
            <div className="mb-3.5 rounded border border-[rgba(229,72,77,0.35)] bg-[rgba(229,72,77,0.08)] px-3 py-2 text-[12px] text-state-scheduled-ink">
              This rule is on — matching units are scheduled for deletion after
              the grace period.
            </div>
          )}
          <TreeGroup
            node={draft.conditions}
            catalog={catalog}
            target={draft.target}
            perCondition={preview?.per_condition ?? {}}
            onChange={(c: any) => update({ conditions: c })}
          />
        </div>

        <div className="flex w-64 flex-none flex-col gap-3.5 border-l border-line-subtle bg-bg-inset p-4">
          <button
            type="button"
            disabled={!preview?.count}
            onClick={() => setPreviewModal(true)}
            className={`rounded-lg border bg-bg-raised p-3 text-left transition-colors ${
              preview?.count
                ? "cursor-pointer border-[rgba(91,141,239,0.4)] hover:border-accent hover:bg-accent-subtle"
                : "cursor-default border-[rgba(91,141,239,0.4)] opacity-60"
            }`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span
                className="text-[10.5px] font-semibold tracking-[0.08em] text-ink-low"
                aria-live="polite"
              >
                LIVE PREVIEW{" "}
                {previewStale && (
                  <span className="text-state-error-ink">· stale…</span>
                )}
              </span>
              {preview?.count ? (
                <span className="text-[10px] font-medium text-accent">
                  View all →
                </span>
              ) : null}
            </div>
            <div className="font-mono text-xl font-semibold text-ink-hi">
              {preview?.count ?? "—"}{" "}
              <span className="text-[12px] font-normal text-ink-mid">
                units
              </span>{" "}
              · {gb(preview?.total_gb ?? 0)}{" "}
              <span className="text-[12px] font-normal text-ink-mid">GB</span>
            </div>
            <div className="mb-2.5 mt-1 text-[11.5px] text-ink-mid">
              would enter grace if enabled
            </div>
            <div className="flex flex-col gap-1">
              {(preview?.items ?? []).slice(0, 4).map((i: any) => (
                <div key={i.key} className="flex justify-between text-[11.5px]">
                  <span className="truncate text-ink-hi">
                    {i.title}
                    {i.season_number ? (
                      <span className="ml-1 font-mono text-[10px] text-ink-mid">
                        S{i.season_number}
                      </span>
                    ) : null}
                  </span>
                  <span className="ml-2 flex-none font-mono text-ink-mid">
                    {i.size_gb} GB
                  </span>
                </div>
              ))}
              {(preview?.count ?? 0) > 4 && (
                <div className="pt-0.5 text-[11px] text-accent">
                  + {(preview?.count ?? 0) - 4} more
                </div>
              )}
            </div>
          </button>
          <div className="rounded-lg border border-line-subtle bg-bg-raised p-3">
            <div className="mb-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-low">
              POLICY
            </div>
            <div className="flex flex-col gap-2.5 text-[12px] text-ink-mid">
              <label className="flex items-center justify-between">
                <span>Target</span>
                <select
                  value={draft.target}
                  onChange={(e) => update({ target: e.target.value })}
                  className="rounded border border-line bg-bg px-1.5 py-0.5 text-ink-hi"
                >
                  <option value="movie">Movies</option>
                  <option value="season">TV seasons</option>
                  <option value="series">TV series</option>
                </select>
              </label>
              <label className="flex items-center justify-between">
                <span>Grace period</span>
                <span className="flex items-center gap-1">
                  <input
                    type="number"
                    value={draft.grace_days}
                    onChange={(e) =>
                      update({ grace_days: Number(e.target.value) })
                    }
                    className="w-14 rounded border border-line bg-bg px-1.5 py-0.5 text-right font-mono text-ink-hi"
                  />
                  <span className="text-ink-low">days</span>
                </span>
              </label>
              <label className="flex items-center justify-between">
                <span>Notify requester</span>
                <input
                  type="checkbox"
                  checked={draft.notify_requester}
                  onChange={(e) =>
                    update({ notify_requester: e.target.checked })
                  }
                  className="accent-accent"
                />
              </label>
              <label className="flex items-center justify-between">
                <span>Import-list exclusion</span>
                <input
                  type="checkbox"
                  checked={draft.add_import_list_exclusion}
                  onChange={(e) =>
                    update({ add_import_list_exclusion: e.target.checked })
                  }
                  className="accent-accent"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      {previewModal && preview?.items?.length ? (
        <PreviewMatchesModal
          ruleName={draft.name}
          count={preview.count}
          totalGb={preview.total_gb}
          items={preview.items}
          onClose={() => setPreviewModal(false)}
        />
      ) : null}
      {enableModal && (
        <ConfirmModal
          title={`Enable "${draft.name}"?`}
          body={
            <>
              This will schedule{" "}
              <span className="font-mono text-state-scheduled-ink">
                {preview?.count ?? 0} units
              </span>{" "}
              ·{" "}
              <span className="font-mono text-ink-hi">
                {gb(preview?.total_gb)}
              </span>{" "}
              for deletion after the grace period.
              <span className="mt-2 block text-[12px] text-ink-low">
                Once enabled, changes to this rule require a manual save.
              </span>
            </>
          }
          confirmLabel="Enable rule"
          onConfirm={() => toggleEnabled(true)}
          onCancel={() => setEnableModal(false)}
        />
      )}
      {deleteModal && (
        <ConfirmModal
          title={`Delete "${draft.name}"?`}
          body="This permanently removes the rule and reverts any units it scheduled back to active."
          confirmLabel="Delete rule"
          onConfirm={doDelete}
          onCancel={() => setDeleteModal(false)}
          danger
        />
      )}
    </div>
  );
}

function PreviewMatchesModal({
  ruleName,
  count,
  totalGb,
  items,
  onClose,
}: {
  ruleName: string;
  count: number;
  totalGb: number;
  items: any[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[720px] max-w-full flex-col rounded-lg border border-line bg-bg-overlay shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line-subtle px-6 py-4">
          <div>
            <div className="text-[16px] font-semibold text-ink-hi">
              Live preview matches
            </div>
            <p className="mt-1 text-[12.5px] text-ink-mid">
              {count} units · {gb(totalGb)} would enter grace if{" "}
              <span className="font-medium text-ink-hi">{ruleName}</span> were
              enabled
            </p>
          </div>
          <Button onClick={onClose}>Close</Button>
        </div>
        <div className="overflow-y-auto overflow-x-hidden px-6 py-2">
          <div className="grid grid-cols-[minmax(0,1fr)_72px_80px_32px] gap-x-3 border-b border-line-subtle py-2">
            {["TITLE", "SEASON", "FREES", ""].map((h) => (
              <span
                key={h}
                className="text-[10px] font-semibold tracking-[0.08em] text-ink-low"
              >
                {h}
              </span>
            ))}
          </div>
          <div className="divide-y divide-line-subtle">
            {items.map((i) => (
              <div
                key={i.key}
                className="grid grid-cols-[minmax(0,1fr)_72px_80px_32px] items-center gap-x-3 py-2.5"
              >
                <span className="truncate text-[13px] font-medium text-ink-hi">
                  {i.title}
                </span>
                <span className="font-mono text-[11.5px] text-ink-mid">
                  {i.season_number ? `S${i.season_number}` : "—"}
                </span>
                <span className="font-mono text-[12px] text-ink-hi">
                  {gb(i.size_gb)}
                </span>
                <Popover title="WHY WOULD THIS MATCH?" snapshot={i.snapshot} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewRuleModal({
  presets,
  creating,
  onSelect,
  onCancel,
}: {
  presets: RulePreset[];
  creating: boolean;
  onSelect: (preset: RulePreset) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-[520px] rounded-lg border border-line bg-bg-overlay p-6 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[16px] font-semibold text-ink-hi">
          Create rule
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-ink-mid">
          Start from a preset or a blank rule. New rules are created disabled.
        </p>
        <div className="mb-4 flex flex-col gap-2">
          {presets.map((preset) => (
            <button
              key={preset.id}
              disabled={creating}
              onClick={() => onSelect(preset)}
              className="rounded border border-line-subtle bg-bg-raised px-3.5 py-3 text-left transition-colors hover:border-line hover:bg-bg disabled:opacity-50"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-ink-hi">
                  {preset.name}
                </span>
                <span className="rounded-pill border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-low">
                  {preset.target}
                </span>
              </div>
              <div className="mt-1 text-[12px] leading-relaxed text-ink-mid">
                {preset.description}
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <Button onClick={onCancel} disabled={creating}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: any) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-[440px] rounded-lg border border-line bg-bg-overlay p-6 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 text-[16px] font-semibold text-ink-hi">
          {title}
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-ink-mid">
          {body}
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TreeGroup({ node, catalog, target, perCondition, onChange }: any) {
  const setChild = (idx: number, child: any) => {
    const conditions = [...(node.conditions || [])];
    conditions[idx] = child;
    onChange({ ...node, conditions });
  };
  const removeChild = (idx: number) => {
    const conditions = [...(node.conditions || [])];
    conditions.splice(idx, 1);
    onChange({ ...node, conditions });
  };
  const addCondition = () => {
    const first = (catalog?.fields ?? []).find((f: any) =>
      f.applies.includes(target),
    ) ?? { field: "age_days", type: "number" };
    onChange({
      ...node,
      conditions: [
        ...(node.conditions || []),
        { field: first.field, cmp: ">=", value: 0 },
      ],
    });
  };
  const addGroup = () =>
    onChange({
      ...node,
      conditions: [...(node.conditions || []), { op: "OR", conditions: [] }],
    });

  return (
    <div className="flex gap-3.5">
      <div className="w-[3px] flex-none rounded bg-accent" />
      <div className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2.5">
          <select
            value={node.op || "AND"}
            onChange={(e) => onChange({ ...node, op: e.target.value })}
            className="rounded border border-[rgba(91,141,239,0.4)] bg-accent-subtle px-2.5 py-1 text-[11px] font-bold tracking-[0.06em] text-[#8FB0F5]"
          >
            <option value="AND">ALL</option>
            <option value="OR">ANY</option>
          </select>
          <span className="text-[12px] text-ink-low">
            of the following are true
          </span>
        </div>
        {(node.conditions || []).map((c: Cond, idx: number) =>
          c.op ? (
            <div
              key={idx}
              className="rounded border border-line-subtle bg-bg-raised p-2.5"
            >
              <TreeGroup
                node={c}
                catalog={catalog}
                target={target}
                perCondition={perCondition}
                onChange={(g: any) => setChild(idx, g)}
              />
              <button
                onClick={() => removeChild(idx)}
                className="mt-2 text-[11px] text-ink-low hover:text-state-scheduled-ink"
              >
                remove group
              </button>
            </div>
          ) : (
            <ConditionRow
              key={idx}
              cond={c}
              catalog={catalog}
              target={target}
              matches={perCondition[`${c.field} ${c.cmp} ${c.value}`]}
              onChange={(nc: any) => setChild(idx, nc)}
              onRemove={() => removeChild(idx)}
            />
          ),
        )}
        <div className="mt-0.5 flex items-center gap-2">
          <button
            onClick={addCondition}
            className="text-[12px] font-medium text-accent"
          >
            + condition
          </button>
          <span className="text-[12px] text-ink-low">·</span>
          <button
            onClick={addGroup}
            className="text-[12px] font-medium text-accent"
          >
            + group
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionRow({
  cond,
  catalog,
  target,
  matches,
  onChange,
  onRemove,
}: any) {
  const fields = (catalog?.fields ?? []).filter(
    (f: any) => f.applies.includes(target) || f.field === cond.field,
  );
  const fieldMeta = (catalog?.fields ?? []).find(
    (f: any) => f.field === cond.field,
  ) ?? { type: "number" };
  const ops = (catalog?.operators ?? {})[fieldMeta.type] ?? [">=", "<="];

  const valueInput =
    fieldMeta.type === "bool" ? (
      <select
        value={String(cond.value)}
        onChange={(e) =>
          onChange({ ...cond, value: e.target.value === "true" })
        }
        className="rounded border border-line bg-bg px-2 py-0.5 font-mono text-[12px] text-ink-hi"
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    ) : (
      <input
        value={cond.value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          const val =
            fieldMeta.type === "number" && raw !== "" && !isNaN(Number(raw))
              ? Number(raw)
              : raw;
          onChange({ ...cond, value: val });
        }}
        className="w-24 rounded border border-line bg-bg px-2 py-0.5 font-mono text-[12px] text-ink-hi"
      />
    );

  return (
    <div className="flex items-center gap-2 rounded border border-line-subtle bg-bg-raised px-2.5 py-2">
      <select
        value={cond.field}
        onChange={(e) => onChange({ ...cond, field: e.target.value })}
        className="rounded bg-accent-subtle px-2 py-1 font-mono text-[12px] text-[#8FB0F5]"
      >
        {fields.map((f: any) => (
          <option key={f.field} value={f.field}>
            {f.field}
          </option>
        ))}
      </select>
      <select
        value={cond.cmp}
        onChange={(e) => onChange({ ...cond, cmp: e.target.value })}
        className="rounded border border-line bg-bg px-1.5 py-0.5 text-[12px] text-ink-mid"
      >
        {ops.map((o: string) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {valueInput}
      {matches != null && (
        <span className="text-[11px] text-ink-low">
          matches <span className="font-mono text-ink-mid">{matches}</span>
        </span>
      )}
      <button
        onClick={onRemove}
        className="ml-auto font-mono text-[11px] text-ink-faint hover:text-state-scheduled-ink"
      >
        ✕
      </button>
    </div>
  );
}
