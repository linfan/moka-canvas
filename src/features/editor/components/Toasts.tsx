import { useAppStore } from "../stores/appStore";

export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="toasts">
      {toasts.map((toast) => (
        <button
          className={`toast toast-${toast.kind}`}
          key={toast.id}
          onClick={() => dismiss(toast.id)}
          title="Dismiss"
          type="button"
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
