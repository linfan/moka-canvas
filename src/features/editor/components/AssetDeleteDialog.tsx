import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { confirmDeleteAsset } from "../interactions/actions";
import { buildResourceIndex } from "../canvas/mediaCards";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/**
 * Confirmation shown when deleting an asset that nodes still reference.
 * Confirming removes the referencing nodes (edges cascade) and the file.
 */
export function AssetDeleteDialog() {
  const { t } = useTranslation();
  const prompt = useEditorStore((state) => state.assetDeletePrompt);
  const moka = useProjectStore((state) => state.moka);

  useEffect(() => {
    if (!prompt) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        useEditorStore.getState().closeAssetDeletePrompt();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prompt]);

  if (!prompt) return null;
  const entry = moka ? buildResourceIndex(moka).get(prompt.assetId) : undefined;
  const count = prompt.nodeIds.length;
  const close = () => useEditorStore.getState().closeAssetDeletePrompt();

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        aria-labelledby="asset-delete-title"
        aria-modal="true"
        className="dialog"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
      >
        <h2 id="asset-delete-title">{t("editor:dialogs.assetDelete.title")}</h2>
        <p>
          <strong>
            {entry?.name ?? t("editor:dialogs.assetDelete.thisAsset")}
          </strong>{" "}
          {count === 1
            ? t("editor:dialogs.assetDelete.usedByOne")
            : t("editor:dialogs.assetDelete.usedByMany", { count })}
        </p>
        <div className="dialog-actions">
          <button onClick={close} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            className="danger"
            onClick={() => void confirmDeleteAsset()}
            type="button"
          >
            {t("editor:dialogs.assetDelete.removeAndDelete")}
          </button>
        </div>
      </div>
    </div>
  );
}
