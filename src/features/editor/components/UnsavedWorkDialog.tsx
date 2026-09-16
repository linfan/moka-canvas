import { useTranslation } from "react-i18next";
import type { SaveStatus } from "../stores/projectStore";

export type CloseAction = "save" | "export" | "discard";

/**
 * Guard shown when leaving a project that still has unsaved or conflicted work,
 * or a run still going. Nothing is discarded silently: the user explicitly
 * saves, preserves a package copy, or discards. A run is not stopped by leaving
 * either, and the guard says so rather than letting the reader assume it.
 */
export function UnsavedWorkDialog({
  saveStatus,
  pendingCount,
  inFlight,
  busy,
  error,
  onAction,
  onCancel,
}: {
  saveStatus: SaveStatus;
  pendingCount: number;
  /** Runs still going, which leaving does not stop. */
  inFlight: number;
  busy: CloseAction | null;
  error: string | null;
  onAction: (action: CloseAction) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const conflicted = saveStatus === "conflicted";
  const nothingToLose = pendingCount === 0 && !conflicted;
  // A run still going is a reason to ask with nothing to lose: offering to
  // discard or to export work that does not exist would be offering nothing.
  const onlyRunning = nothingToLose && inFlight > 0;
  // Saving is debounced, so the work this was raised for can be written while
  // the question is on screen. What the question says changes then, not what it
  // offers: a way out that moves is one the reader has to look for again.
  const savedWhileAsked = nothingToLose && inFlight === 0;
  const one = inFlight === 1;
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="unsaved-work-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="unsaved-work-title">
          {t(
            onlyRunning
              ? "editor:dialogs.unsaved.stillRunning"
              : "editor:dialogs.unsaved.unsavedChanges",
          )}
        </h2>
        {conflicted ? (
          <p>
            {t(
              pendingCount === 1
                ? "editor:dialogs.unsaved.conflictOne"
                : "editor:dialogs.unsaved.conflictMany",
            )}
          </p>
        ) : savedWhileAsked ? (
          <p>{t("editor:dialogs.unsaved.savedWhileAsked")}</p>
        ) : (
          !nothingToLose && (
            <p>
              {pendingCount > 0
                ? t(
                    pendingCount === 1
                      ? "editor:dialogs.unsaved.lostOne"
                      : "editor:dialogs.unsaved.lostMany",
                    { count: pendingCount },
                  )
                : t("editor:dialogs.unsaved.lostGeneric")}
            </p>
          )
        )}
        {inFlight > 0 && (
          <p className="dialog-note">
            {one
              ? t("editor:dialogs.unsaved.runningOne")
              : t("editor:dialogs.unsaved.runningMany", { count: inFlight })}
          </p>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        {onlyRunning ? (
          <div className="dialog-actions">
            <button disabled={busy !== null} onClick={onCancel} type="button">
              {t("editor:action.cancel")}
            </button>
            <button
              autoFocus
              className="primary"
              disabled={busy !== null}
              onClick={() => onAction("save")}
              type="button"
            >
              {t("editor:action.close")}
            </button>
          </div>
        ) : (
          <div className="dialog-actions">
            <button disabled={busy !== null} onClick={onCancel} type="button">
              {t("editor:action.cancel")}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => onAction("discard")}
              type="button"
            >
              {t("editor:dialogs.unsaved.discardAndClose")}
            </button>
            <button
              disabled={busy !== null}
              onClick={() => onAction("export")}
              title={
                conflicted
                  ? t("editor:dialogs.unsaved.exportHintConflict")
                  : t("editor:dialogs.unsaved.exportHint")
              }
              type="button"
            >
              {busy === "export"
                ? t("editor:dialogs.unsaved.exporting")
                : t("editor:dialogs.unsaved.exportCopyAndClose")}
            </button>
            <button
              autoFocus={!conflicted}
              className="primary"
              disabled={busy !== null || conflicted}
              onClick={() => onAction("save")}
              title={
                conflicted
                  ? t("editor:dialogs.unsaved.saveHintConflict")
                  : undefined
              }
              type="button"
            >
              {busy === "save"
                ? t("editor:action.saving")
                : t("editor:dialogs.unsaved.saveAndClose")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
