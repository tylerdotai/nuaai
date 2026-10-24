import { useEffect, useRef } from 'react';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastData {
  id: string;
  variant: ToastVariant;
  title?: string;
  message: string;
  dismissAfterMs?: number;
  onDismiss?: () => void;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const delay = toast.dismissAfterMs ?? 5000;
    timerRef.current = window.setTimeout(() => {
      onDismiss(toast.id);
    }, delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.dismissAfterMs, onDismiss]);

  return (
    <div className={`toast toast-${toast.variant}`} role="alert">
      <div className="toast-content">
        {toast.title && <strong className="toast-title">{toast.title}</strong>}
        <p className="toast-message">{toast.message}</p>
      </div>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({
  toasts,
  onDismiss,
}: ToastContainerProps): React.JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
