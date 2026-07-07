import { useEffect, useLayoutEffect, useRef, useState, ReactNode } from "react";
import { createPortal } from "react-dom";

type Snapshot = Record<
  string,
  { value: any; cmp: string; threshold: any; passed: boolean }
>;

const PANEL_W = 320;

// The "Why?" popover (§03 3.10): every SCHEDULED/CANDIDATE pill answers for
// itself in one click. The matched-values snapshot is the same structure QC uses.
export function WhyPopover({
  title = "WHY IS THIS LEAVING?",
  ruleName,
  snapshot,
  children,
  footer,
}: {
  title?: string;
  ruleName?: string | null;
  snapshot?: Snapshot | null;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;

    function place() {
      if (!btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      const panelH = panelRef.current?.offsetHeight ?? 240;
      const margin = 8;

      let left = rect.left;
      if (left + PANEL_W > window.innerWidth - margin) {
        left = Math.max(margin, rect.right - PANEL_W);
      }

      let top = rect.bottom + 4;
      if (top + panelH > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - panelH - 4);
      }

      setPos({ top, left });
    }

    place();
    const id = requestAnimationFrame(place);
    return () => cancelAnimationFrame(id);
  }, [open, snapshot]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const panel =
    open &&
    createPortal(
      <div
        ref={panelRef}
        className="fixed z-[70] max-h-[min(60vh,420px)] w-80 overflow-y-auto rounded-lg border border-line bg-bg-overlay p-3.5 shadow-overlay"
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-low">
          {title}
        </div>
        {ruleName && (
          <div className="mb-2.5 text-[12.5px] text-ink-hi">
            Matched by rule{" "}
            <span className="font-semibold text-accent-hover">{ruleName}</span>
          </div>
        )}
        {snapshot && (
          <div className="flex flex-col gap-1.5">
            {Object.entries(snapshot).map(([field, v]) => (
              <div
                key={field}
                className="flex justify-between gap-3 rounded bg-bg-raised px-2.5 py-1.5 font-mono text-[11.5px]"
              >
                <span className="shrink-0 text-ink-mid">{field}</span>
                <span className="text-right text-ink-hi">
                  {String(v.value)}{" "}
                  <span
                    className={
                      v.passed ? "text-state-kept-ink" : "text-ink-low"
                    }
                  >
                    {v.cmp} {String(v.threshold)} {v.passed ? "✓" : "✗"}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
        {children}
        {footer && <div className="mt-3 flex gap-2">{footer}</div>}
      </div>,
      document.body,
    );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-ink-low hover:text-ink-mid"
        aria-label="Why?"
        aria-expanded={open}
      >
        ⓘ
      </button>
      {panel}
    </>
  );
}
