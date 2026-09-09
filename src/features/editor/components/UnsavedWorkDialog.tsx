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
  const conflicted = saveStatus === "conflicted";
  // A run still going is a reason to ask, but there is nothing to lose: offering
  // to discard or to export work that does not exist would be offering nothing.
  const nothingToLose = pendingCount === 0 && !conflicted;
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
          {nothingToLose && inFlight > 0 ? "Still running" : "Unsaved changes"}
        </h2>
        {conflicted ? (
          <p>
            Saving is blocked by a revision conflict — your{" "}
            {pendingCount === 1 ? "change" : "changes"} cannot be written until
            you reload the project. Exporting keeps a package of the last saved
            revision (without your unsaved changes); discarding drops them.
          </p>
        ) : (
          !nothingToLose && (
            <p>
              {pendingCount > 0
                ? `${pendingCount} unsaved change${pendingCount === 1 ? "" : "s"} will`
                : "Your changes will"}{" "}
              be lost if you leave without saving.
            </p>
          )
        )}
        {inFlight > 0 && (
          <p className="dialog-note">
            {one ? "A generation is" : `${inFlight} generations are`} still
            running. Leaving does not stop {one ? "it" : "them"}: what{" "}
            {one ? "it makes" : "they make"} is written into the project, and is
            there when the project is opened again.
          </p>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        {nothingToLose ? (
          <div className="dialog-actions">
            <button disabled={busy !== null} onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              autoFocus
              className="primary"
              disabled={busy !== null}
              onClick={() => onAction("save")}
              type="button"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="dialog-actions">
            <button disabled={busy !== null} onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              disabled={busy !== null}
              onClick={() => onAction("discard")}
              type="button"
            >
              Discard and close
            </button>
            <button
              disabled={busy !== null}
              onClick={() => onAction("export")}
              title={
                conflicted
                  ? "Exports the last saved revision; unsaved changes are not included"
                  : "Save, then export the project as a package"
              }
              type="button"
            >
              {busy === "export" ? "Exporting…" : "Export copy and close"}
            </button>
            <button
              autoFocus={!conflicted}
              className="primary"
              disabled={busy !== null || conflicted}
              onClick={() => onAction("save")}
              title={
                conflicted
                  ? "Blocked by a revision conflict — reload the project first"
                  : undefined
              }
              type="button"
            >
              {busy === "save" ? "Saving…" : "Save and close"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
