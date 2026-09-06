import type { SaveStatus } from "../stores/projectStore";

export type CloseAction = "save" | "export" | "discard";

/**
 * Guard shown when leaving a project that still has unsaved or conflicted
 * work. Nothing is discarded silently: the user explicitly saves, preserves a
 * package copy, or discards.
 */
export function UnsavedWorkDialog({
  saveStatus,
  pendingCount,
  busy,
  error,
  onAction,
  onCancel,
}: {
  saveStatus: SaveStatus;
  pendingCount: number;
  busy: CloseAction | null;
  error: string | null;
  onAction: (action: CloseAction) => void;
  onCancel: () => void;
}) {
  const conflicted = saveStatus === "conflicted";
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="unsaved-work-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="unsaved-work-title">Unsaved changes</h2>
        {conflicted ? (
          <p>
            Saving is blocked by a revision conflict — your{" "}
            {pendingCount === 1 ? "change" : "changes"} cannot be written until
            you reload the project. Exporting keeps a package of the last saved
            revision (without your unsaved changes); discarding drops them.
          </p>
        ) : (
          <p>
            {pendingCount > 0
              ? `${pendingCount} unsaved change${pendingCount === 1 ? "" : "s"} will`
              : "Your changes will"}{" "}
            be lost if you leave without saving.
          </p>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
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
      </div>
    </div>
  );
}
