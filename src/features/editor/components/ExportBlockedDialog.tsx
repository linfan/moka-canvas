import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="export-blocked-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="export-blocked-title">
          {t("editor:dialogs.exportBlocked.title")}
        </h2>
        <p>
          {message} {t("editor:dialogs.exportBlocked.before")}{" "}
          <code>incomplete</code> {t("editor:dialogs.exportBlocked.after")}
        </p>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy}
            onClick={onExportAnyway}
            type="button"
          >
            {busy
              ? t("editor:dialogs.exportPackage.exporting")
              : t("editor:dialogs.exportBlocked.exportAnyway")}
          </button>
        </div>
      </div>
    </div>
  );
}
