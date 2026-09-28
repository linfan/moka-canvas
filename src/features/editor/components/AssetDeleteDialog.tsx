import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { confirmDeleteAsset, drawingName } from "../interactions/actions";
import { buildResourceIndex } from "../canvas/mediaCards";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/**
 * Confirmation shown when deleting an asset something still holds.
 *
 * Both ways a file is held and can be let go are said out loud — the cards
 * that show it, and the story places keeping it as an old drawing — since
 * confirming does both: the cards go (edges cascade), the old drawings are
 * thrown away, and then the file.
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
  const drawings = prompt.drawings.map(drawingName);
  const close = () => useEditorStore.getState().closeAssetDeletePrompt();
  const confirm =
    count > 0 && drawings.length > 0
      ? t("editor:dialogs.assetDelete.removeBothAndDelete")
      : drawings.length > 0
        ? t("editor:dialogs.assetDelete.removeDrawingAndDelete")
        : t("editor:dialogs.assetDelete.removeAndDelete");

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
          </strong>
          {count > 0 && (
            <>
              {" "}
              {count === 1
                ? t("editor:dialogs.assetDelete.usedByOne")
                : t("editor:dialogs.assetDelete.usedByMany", { count })}
            </>
          )}
        </p>
        {drawings.length > 0 && (
          <p>
            {drawings.length === 1
              ? t("editor:dialogs.assetDelete.keepsDrawingOne", {
                  place: drawings[0],
                })
              : t("editor:dialogs.assetDelete.keepsDrawingMany", {
                  count: drawings.length,
                  places: drawings.join(t("editor:holders.join")),
                })}
          </p>
        )}
        <div className="dialog-actions">
          <button onClick={close} type="button">
            {t("editor:action.cancel")}
          </button>
          <button
            className="danger"
            onClick={() => void confirmDeleteAsset()}
            type="button"
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
