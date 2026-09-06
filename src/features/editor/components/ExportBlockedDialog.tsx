/**
 * Shown when export is refused because referenced assets are missing on disk.
 * The user may export anyway; the package manifest is then flagged incomplete.
 */
export function ExportBlockedDialog({
  message,
  busy,
  onExportAnyway,
  onCancel,
}: {
  message: string;
  busy: boolean;
  onExportAnyway: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="export-blocked-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="export-blocked-title">Assets are missing</h2>
        <p>
          {message} Export anyway — the package manifest will be flagged{" "}
          <code>incomplete</code> and importers will be warned.
        </p>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy}
            onClick={onExportAnyway}
            type="button"
          >
            {busy ? "Exporting…" : "Export anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
