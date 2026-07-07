import { createContext, useCallback, useContext, useState, ReactNode } from "react";

type Toast = { id: number; message: string; undo?: () => void };
const ToastCtx = createContext<(message: string, undo?: () => void) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, undo?: () => void) => {
    const id = ++counter;
    setToasts((t) => [...t, { id, message, undo }]);
    // 10s window per the veto flow (§07).
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 10000);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="flex items-center gap-4 rounded-lg border border-line bg-bg-overlay px-4 py-3 text-[12.5px] text-ink-hi shadow-overlay"
          >
            <span>{t.message}</span>
            {t.undo && (
              <button
                onClick={() => {
                  t.undo?.();
                  setToasts((x) => x.filter((y) => y.id !== t.id));
                }}
                className="font-semibold text-accent-hover"
              >
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
