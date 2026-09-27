import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type Toast } from "../stores/appStore";

/**
 * How long a toast stands before it takes itself away, by what it is saying.
 *
 * A report of something that broke is read twice — once for what happened, and
 * once for what to do about it — and a reader who has gone back to what they
 * were doing cannot be told any of it; so one that is saying something went
 * wrong stands longer than one that is saying what just happened.
 */
const LINGER_MS: Record<Toast["kind"], number> = {
  info: 6_000,
  success: 6_000,
  error: 20_000,
};

/**
 * What has just happened, each one gone again in a few seconds.
 *
 * Choosing one takes it away, and one that named something with a place of its
 * own goes there first: the label on it is what tells the two apart. One that
 * carries more than a line keeps the rest under it, shown when the reader asks
 * — a provider's whole complaint, kept rather than cut, and the toast stays
 * while it is being read.
 */
export function Toasts() {
  const toasts = useAppStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="toasts">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

/**
 * One toast: the line, the rest of it, and where choosing it goes.
 *
 * A toast with nothing under it is one control from edge to edge, as it has
 * always been. One with something under it cannot be: the click is what shows
 * the rest, so where it leads — and the way out — are their own controls.
 */
function ToastCard({ toast }: { toast: Toast }) {
  const { t } = useTranslation();
  const dismiss = useAppStore((state) => state.dismissToast);
  const [open, setOpen] = useState(false);
  const detail = toast.detail;
  const close = () => dismiss(toast.id);

  // A toast being read is not taken away under the reader's eyes: the clock
  // runs only while what is on screen is the whole of it. Put away, it starts
  // over, which is the length a reader is promised either way.
  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(
      () => dismiss(toast.id),
      LINGER_MS[toast.kind],
    );
    return () => window.clearTimeout(timer);
  }, [open, toast.id, toast.kind, dismiss]);

  if (detail === undefined) {
    return (
      <div className={`toast toast-${toast.kind}`}>
        <button
          className="toast-body"
          onClick={() => {
            toast.choice?.go();
            close();
          }}
          title={toast.choice ? toast.choice.label : t("app:dismiss")}
          type="button"
        >
          {toast.message}
          {toast.choice && (
            <span className="toast-choice">{toast.choice.label}</span>
          )}
        </button>
      </div>
    );
  }

  const detailId = `toast-detail-${toast.id}`;
  return (
    <div className={`toast toast-${toast.kind}`}>
      <button
        aria-controls={detailId}
        aria-expanded={open}
        className="toast-body"
        onClick={() => setOpen((held) => !held)}
        title={t(open ? "app:hideDetail" : "app:showDetail")}
        type="button"
      >
        {toast.message}
      </button>
      <p className="toast-detail" hidden={!open} id={detailId}>
        {detail}
      </p>
      <div className="toast-actions">
        {toast.choice && (
          <button
            className="toast-choice"
            onClick={() => {
              toast.choice?.go();
              close();
            }}
            type="button"
          >
            {toast.choice.label}
          </button>
        )}
        <button
          aria-label={t("app:dismiss")}
          className="toast-close"
          onClick={close}
          type="button"
        >
          ×
        </button>
      </div>
    </div>
  );
}
