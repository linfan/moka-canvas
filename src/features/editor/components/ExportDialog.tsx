import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatBytes } from "../canvas/mediaCards";

/** What the person exporting asked for. */
export interface ExportChoices {
  /** Carry the record of the runs made on this machine along with the work. */
  includePersonalHistory: boolean;
  /** Leave out the assets nothing on a canvas points at. */
  onlyReferencedAssets: boolean;
}

/**
 * Both choices start off, so the thing an export does unless somebody asks
 * otherwise is hand over the work and nothing about this machine.
 */
export const EXPORT_DEFAULTS: ExportChoices = {
  includePersonalHistory: false,
  onlyReferencedAssets: false,
};

/** What ticking "only the placed assets" would leave behind, counted up front. */
export interface LeftBehind {
  count: number;
  bytes: number;
}

/**
 * The two questions an export has to answer, asked before anything is written.
 *
 * What is never in a package at all is said here rather than left to be
 * discovered: a reader who is about to hand a file to somebody else is owed the
 * difference between "not exported" and "not part of the project".
 */
export function ExportDialog({
  busy,
  leftBehind,
  onCancel,
  onExport,
}: {
  busy: boolean;
  leftBehind: LeftBehind;
  onCancel: () => void;
  onExport: (choices: ExportChoices) => void;
}) {
  const { t } = useTranslation();
  const [choices, setChoices] = useState<ExportChoices>(EXPORT_DEFAULTS);
  const nothingToLeave = leftBehind.count === 0;
  const set = (patch: Partial<ExportChoices>) =>
    setChoices({ ...choices, ...patch });
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="export-title"
        aria-modal="true"
        className="dialog"
        role="dialog"
      >
        <h2 id="export-title">{t("editor:dialogs.exportPackage.title")}</h2>
        <p className="dialog-note">{t("editor:dialogs.exportPackage.note")}</p>
        <label className="dialog-choice">
          <input
            checked={choices.includePersonalHistory}
            onChange={(event) =>
              set({ includePersonalHistory: event.target.checked })
            }
            type="checkbox"
          />
          <span>
            {t("editor:dialogs.exportPackage.includeHistory")}
            <small>
              {t("editor:dialogs.exportPackage.includeHistoryNote")}
            </small>
          </span>
        </label>
        <label className="dialog-choice">
          <input
            checked={choices.onlyReferencedAssets}
            disabled={nothingToLeave}
            onChange={(event) =>
              set({ onlyReferencedAssets: event.target.checked })
            }
            type="checkbox"
          />
          <span>
            {t("editor:dialogs.exportPackage.onlyReferenced")}
            <small>
              {nothingToLeave
                ? t("editor:dialogs.exportPackage.allPlaced")
                : leftBehind.count === 1
                  ? t("editor:dialogs.exportPackage.leavesOutOne", {
                      bytes: formatBytes(leftBehind.bytes),
                    })
                  : t("editor:dialogs.exportPackage.leavesOutMany", {
                      bytes: formatBytes(leftBehind.bytes),
                      count: leftBehind.count,
                    })}
            </small>
          </span>
        </label>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy}
            onClick={() => onExport(choices)}
            type="button"
          >
            {busy
              ? t("editor:dialogs.exportPackage.exporting")
              : t("editor:dialogs.exportPackage.title")}
          </button>
        </div>
      </div>
    </div>
  );
}
