import { useState } from "react";
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
        <h2 id="export-title">Export package</h2>
        <p className="dialog-note">
          The canvas, its nodes and the assets they hold. Model channels, API
          keys and the prompt library are not part of a project, so they are
          never exported.
        </p>
        <label className="dialog-choice">
          <input
            checked={choices.includePersonalHistory}
            onChange={(event) =>
              set({ includePersonalHistory: event.target.checked })
            }
            type="checkbox"
          />
          <span>
            Include my run history — for my own backup only
            <small>
              Keeps the record of each run this machine made, with the prompt it
              was asked with and the model that answered.
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
            Only the assets a node points at
            <small>
              {nothingToLeave
                ? "Every asset in this project is placed on a canvas."
                : `Leaves out ${leftBehind.count} unreferenced ${
                    leftBehind.count === 1 ? "asset" : "assets"
                  } (${formatBytes(leftBehind.bytes)}).`}
            </small>
          </span>
        </label>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy}
            onClick={() => onExport(choices)}
            type="button"
          >
            {busy ? "Exporting…" : "Export package"}
          </button>
        </div>
      </div>
    </div>
  );
}
