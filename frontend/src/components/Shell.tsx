import { ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { endpoints } from "../lib/api";

const GROUPS: {
  label: string;
  items: { to: string; label: string; badge?: "scheduled" | "keep" }[];
}[] = [
  {
    label: "OBSERVE",
    items: [
      { to: "/dashboard", label: "Dashboard" },
      { to: "/upcoming", label: "Upcoming Removals", badge: "scheduled" },
      { to: "/qc", label: "Rule QC" },
    ],
  },
  { label: "LIBRARY", items: [{ to: "/library", label: "Media Explorer" }] },
  {
    label: "AUTOMATE",
    items: [
      { to: "/rules", label: "Rules" },
      { to: "/requests", label: "Keep Requests", badge: "keep" },
    ],
  },
  {
    label: "SYSTEM",
    items: [
      { to: "/history", label: "History" },
      { to: "/settings", label: "Settings" },
    ],
  },
];

export function GlobalBanner() {
  const { data } = useQuery({
    queryKey: ["healthz"],
    queryFn: () => endpoints.settings(),
    refetchInterval: 15000,
  });
  const navigate = useNavigate();
  if (data?.system_enabled !== false) return null;
  return (
    <div
      role="status"
      className="flex h-[34px] items-center justify-center gap-2.5 border-b border-[rgba(229,72,77,0.45)] bg-[rgba(229,72,77,0.14)] text-[12px] font-semibold text-[#FF7B80]"
    >
      ■ SYSTEM PAUSED — no rules evaluate and nothing deletes
      <button
        className="font-normal underline opacity-80"
        onClick={() => navigate("/settings")}
      >
        Resume
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: endpoints.me });
  const { data: dash } = useQuery({
    queryKey: ["dash-badge"],
    queryFn: endpoints.dashboard,
    refetchInterval: 20000,
  });
  const { data: keeps } = useQuery({
    queryKey: ["keep-badge"],
    queryFn: () => endpoints.keepRequests("pending"),
  });

  const scheduled = dash?.scheduled_count ?? 0;
  const pendingKeeps = keeps?.keep_requests?.length ?? 0;

  const badgeValue = (b?: string) =>
    b === "scheduled" ? scheduled : b === "keep" ? pendingKeeps : undefined;

  return (
    <div className="flex min-h-screen flex-col">
      <GlobalBanner />
      <div className="flex flex-1">
        <aside className="sticky top-0 flex h-screen w-[200px] flex-none flex-col gap-0.5 overflow-auto border-r border-line-subtle bg-bg-inset px-2.5 py-3">
          <div className="px-2 pb-3 pt-1 font-mono text-[13px] font-semibold text-ink-hi">
            ▚ SWEEPARR
          </div>
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="px-2 pb-1 pt-3 text-[10px] font-semibold tracking-[0.1em] text-ink-faint">
                {g.label}
              </div>
              {g.items.map((it) => {
                const bv = badgeValue(it.badge);
                return (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    className={({ isActive }) =>
                      `flex items-center gap-2 rounded px-2 py-1.5 text-[12.5px] ${
                        isActive
                          ? "bg-accent-subtle font-medium text-ink-hi"
                          : "text-ink-mid hover:text-ink-hi"
                      }`
                    }
                  >
                    {it.label}
                    {bv != null && bv > 0 && (
                      <span
                        className={`ml-auto rounded-pill border px-1.5 font-mono text-[10.5px] ${
                          it.badge === "scheduled"
                            ? "border-[rgba(229,72,77,0.4)] bg-[rgba(229,72,77,0.14)] text-state-scheduled-ink"
                            : "border-[rgba(139,150,168,0.28)] bg-[rgba(139,150,168,0.12)] text-ink-mid"
                        }`}
                      >
                        {bv}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          ))}
          <div className="mt-auto flex items-center gap-2 px-2 pt-4 text-[11px] text-ink-faint">
            <span className="flex h-6 w-6 items-center justify-center rounded-pill bg-line text-[10px] text-ink-mid">
              {(me?.name ?? "?")[0]?.toUpperCase()}
            </span>
            <span>{me?.name}</span>
          </div>
        </aside>
        <main className="min-w-0 flex-1 overflow-auto p-8">{children}</main>
      </div>
    </div>
  );
}
