import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "info" | "success" | "error";
export type Toast = {
  readonly id: number;
  readonly tone: ToastTone;
  readonly message: string;
  readonly action?: { readonly label: string; readonly run: () => void };
};
type Toasts = { push: (toast: Omit<Toast, "id">) => number; dismiss: (id: number) => void };
const ToastContext = createContext<Toasts | null>(null);
const SUCCESS_MS = 6000;

export function useToasts(): Toasts {
  const toasts = useContext(ToastContext);
  if (!toasts) throw Error("Toast context missing");
  return toasts;
}

/** Notifications in one polite live region; failures stay until dismissed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<readonly Toast[]>([]);
  const next = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = ++next.current;
      setItems((current) => [...current.slice(-4), { ...toast, id }]);
      if (toast.tone !== "error") timers.current.set(id, setTimeout(() => dismiss(id), SUCCESS_MS));
      return id;
    },
    [dismiss],
  );
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <section className="toasts" aria-label="Notifications">
        <div aria-live="polite" aria-relevant="additions text">
          {items.map((toast) => (
            <div key={toast.id} className={"toast " + toast.tone}>
              <p>{toast.message}</p>
              <div className="toast-actions">
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => {
                      dismiss(toast.id);
                      toast.action?.run();
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
                <button type="button" className="icon-button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)}>
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </ToastContext.Provider>
  );
}
