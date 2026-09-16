import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { assetsApi } from "../../../api";
import type { AssetId, SelfCheckReport } from "../../../shared/domain";
import { useProjectStore } from "../stores/projectStore";

const REASON_LABEL: Record<string, string> = {
  missing: "app:missingAssets.reasonMissing",
  changed: "app:missingAssets.reasonChanged",
  empty: "app:missingAssets.reasonEmpty",
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
  const { t } = useTranslation();
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
        cause instanceof Error
          ? cause.message
          : t("app:missingAssets.replaceFailed"),
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
        <h2 id="missing-assets-title">{t("app:missingAssets.title")}</h2>
        {report.ok ? (
          <p>{t("app:missingAssets.allAccounted")}</p>
        ) : (
          <p>
            {t(
              report.issues.length === 1
                ? "app:missingAssets.issuesOne"
                : "app:missingAssets.issuesMany",
              { count: report.issues.length },
            )}
          </p>
        )}
        <ul className="missing-asset-list">
          {report.issues.map((issue) => (
            <li key={issue.assetId}>
              <strong>{issue.name}</strong>
              <span>
                {REASON_LABEL[issue.reason]
                  ? t(REASON_LABEL[issue.reason])
                  : issue.reason}{" "}
                · {issue.expectedPath}
              </span>
              {issue.referencingNodes.length > 0 && (
                <span>
                  {t("app:missingAssets.usedBy", {
                    nodes: issue.referencingNodes
                      .map((node) => node.title)
                      .join(", "),
                  })}
                </span>
              )}
              <button
                disabled={busy}
                onClick={() => locate(issue.assetId)}
                type="button"
              >
                {t("app:missingAssets.locate")}
              </button>
            </li>
          ))}
          {restored.map((name) => (
            <li className="missing-asset-restored" key={name}>
              <strong>{name}</strong>
              <span>{t("app:missingAssets.restored")}</span>
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
            {t("app:missingAssets.back")}
          </button>
          <button
            autoFocus
            className="primary"
            disabled={busy}
            onClick={onOpenAnyway}
            type="button"
          >
            {report.ok
              ? t("app:openProject")
              : t("app:missingAssets.openWithMissing")}
          </button>
        </div>
      </div>
    </div>
  );
}
