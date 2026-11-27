import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

interface ToastApi {
  show(message: string, options?: { tone?: Toast["tone"]; action?: Toast["action"]; ms?: number }): void;
}

const ToastCtx = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const show = useCallback<ToastApi["show"]>(
    (message, options = {}) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { id, message, tone: options.tone ?? "info", action: options.action }]);
      window.setTimeout(() => dismiss(id), options.ms ?? (options.tone === "error" ? 6000 : 2600));
    },
    [dismiss],
  );
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === "error" ? <Icon name="error" size={18} /> : <Icon name="check" size={18} />}
            <span>{t.message}</span>
            {t.action ? (
              <button
                className="toast-action"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button className="icon-btn small" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
