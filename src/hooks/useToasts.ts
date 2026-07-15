import { useCallback, useRef, useState } from "react";

/** A transient, auto-dismissing notification shown by {@link ToastHost}. */
export interface Toast {
  id: number;
  text: string;
}

export interface UseToastsResult {
  toasts: Toast[];
  /** Show a toast that auto-dismisses after `ttl` ms (default 2600). */
  pushToast: (text: string, ttl?: number) => void;
  /** Remove a toast immediately (e.g. when the user clicks it). */
  dismissToast: (id: number) => void;
}

/**
 * Minimal toast queue. IDs come from a monotonic ref (not `Date.now()`, which
 * is banned in some environments and can collide within the same tick), so two
 * toasts pushed in the same render are always distinct.
 */
export function useToasts(): UseToastsResult {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const pushToast = useCallback(
    (text: string, ttl = 2600) => {
      const id = nextId.current++;
      setToasts((list) => [...list, { id, text }]);
      const timer = setTimeout(() => dismissToast(id), ttl);
      timers.current.set(id, timer);
    },
    [dismissToast],
  );

  return { toasts, pushToast, dismissToast };
}
