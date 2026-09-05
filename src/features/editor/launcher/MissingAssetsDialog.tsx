import { useEffect } from "react";
import type { SelfCheckReport } from "../../../shared/domain";

const REASON_LABEL: Record<string, string> = {
  missing: "Missing",
  changed: "Changed on disk",
  empty: "Empty file",
};

/**
 * Shown when the open-time self-check flags referenced assets. The user picks
 * between returning to the launcher and editing with broken media nodes.
 */
export function MissingAssetsDialog({
  report,
  onOpenAnyway,
  onCancel,
}: {
  report: SelfCheckReport;
  onOpenAnyway: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="missing-assets-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="missing-assets-title">Missing or changed assets</h2>
        <p>
          {report.issues.length} referenced asset
          {report.issues.length === 1 ? " is" : "s are"} missing or changed on
          disk. Nodes that use {report.issues.length === 1 ? "it" : "them"}{" "}
          render broken until the files are restored.
        </p>
        <ul className="missing-asset-list">
          {report.issues.map((issue) => (
            <li key={issue.assetId}>
              <strong>{issue.name}</strong>
              <span>
                {REASON_LABEL[issue.reason] ?? issue.reason} ·{" "}
                {issue.expectedPath}
              </span>
              {issue.referencingNodes.length > 0 && (
                <span>
                  Used by{" "}
                  {issue.referencingNodes
                    .map((node) => node.title)
                    .join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button onClick={onCancel} type="button">
            Back to launcher
          </button>
          <button autoFocus className="primary" onClick={onOpenAnyway} type="button">
            Open with missing assets
          </button>
        </div>
      </div>
    </div>
  );
}
