import type { Toast } from "../hooks/useToasts";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

/** Fixed-position stack of transient notifications. Clicking a toast dismisses
 * it immediately; otherwise each auto-expires via {@link useToasts}. */
export default function ToastHost({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          className="toast"
          onClick={() => onDismiss(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}
