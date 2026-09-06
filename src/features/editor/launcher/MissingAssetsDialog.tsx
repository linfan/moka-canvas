import { useEffect, useRef, useState } from "react";
import { assetsApi } from "../../../api";
import type { AssetId, SelfCheckReport } from "../../../shared/domain";
import { useProjectStore } from "../stores/projectStore";

const REASON_LABEL: Record<string, string> = {
  missing: "Missing",
  changed: "Changed on disk",
  empty: "Empty file",
};

/**
 * Shown when the open-time self-check flags referenced assets. Each issue can
 * be resolved by locating a replacement file (copied to the expected path);
 * otherwise the user edits with broken media nodes or returns to the launcher.
 */
export function MissingAssetsDialog({
  report,
  onReportChange,
  onOpenAnyway,
  onCancel,
}: {
  report: SelfCheckReport;
  onReportChange: (report: SelfCheckReport) => void;
  onOpenAnyway: () => void;
  onCancel: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [locating, setLocating] = useState<AssetId | null>(null);
  const [restored, setRestored] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, busy]);

  const locate = (assetId: AssetId) => {
    setError(null);
    setLocating(assetId);
    fileInput.current?.click();
  };

  const onFileChosen = async (files: FileList | null) => {
    const file = files?.[0];
    const assetId = locating;
    setLocating(null);
    if (!file || !assetId) return;
    setBusy(true);
    setError(null);
    try {
      const change = await assetsApi.replace(assetId, file);
      const project = useProjectStore.getState();
      project.integrateAssetEntry(change.entry, {
        revision: change.revision,
        updatedAt: change.updatedAt,
      });
      const issues = report.issues.filter((issue) => issue.assetId !== assetId);
      const next: SelfCheckReport = { ok: issues.length === 0, issues };
      project.setSelfCheck(next);
      setRestored((names) => [...names, change.entry.name]);
      onReportChange(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not replace the asset",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        aria-labelledby="missing-assets-title"
        aria-modal="true"
        className="dialog"
        role="alertdialog"
      >
        <h2 id="missing-assets-title">Missing or changed assets</h2>
        {report.ok ? (
          <p>All referenced assets are accounted for.</p>
        ) : (
          <p>
            {report.issues.length} referenced asset
            {report.issues.length === 1 ? " is" : "s are"} missing or changed on
            disk. Locate the moved files, or open the project and restore them
            later — affected nodes render broken until then.
          </p>
        )}
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
                  {issue.referencingNodes.map((node) => node.title).join(", ")}
                </span>
              )}
              <button
                disabled={busy}
                onClick={() => locate(issue.assetId)}
                type="button"
              >
                Locate…
              </button>
            </li>
          ))}
          {restored.map((name) => (
            <li className="missing-asset-restored" key={name}>
              <strong>{name}</strong>
              <span>Restored</span>
            </li>
          ))}
        </ul>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <input
          aria-hidden="true"
          className="sr-only"
          onChange={(event) => {
            void onFileChosen(event.target.files);
            event.target.value = "";
          }}
          ref={fileInput}
          tabIndex={-1}
          type="file"
        />
        <div className="dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            Back to launcher
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy}
            onClick={onOpenAnyway}
            type="button"
          >
            {report.ok ? "Open project" : "Open with missing assets"}
          </button>
        </div>
      </div>
    </div>
  );
}
