import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";

/**
 * What has just happened, each one gone again in a few seconds.
 *
 * Choosing one takes it away, and one that named something with a place of its
 * own goes there first: the label on it is what tells the two apart.
 */
export function Toasts() {
  const { t } = useTranslation();
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="toasts">
      {toasts.map((toast) => (
        <button
          className={`toast toast-${toast.kind}`}
          key={toast.id}
          onClick={() => {
            toast.choice?.go();
            dismiss(toast.id);
          }}
          title={toast.choice ? toast.choice.label : t("app:dismiss")}
          type="button"
        >
          {toast.message}
          {toast.choice && (
            <span className="toast-choice">{toast.choice.label}</span>
          )}
        </button>
      ))}
    </div>
  );
}
