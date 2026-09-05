import { useEffect } from "react";
import { confirmDeleteAsset } from "../interactions/actions";
import { buildResourceIndex } from "../canvas/mediaCards";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

/**
 * Confirmation shown when deleting an asset that nodes still reference.
 * Confirming removes the referencing nodes (edges cascade) and the file.
 */
export function AssetDeleteDialog() {
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
        <h2 id="asset-delete-title">Delete asset?</h2>
        <p>
          <strong>{entry?.name ?? "This asset"}</strong> is used by {count} node
          {count === 1 ? "" : "s"}. Deleting it also removes{" "}
          {count === 1 ? "that node" : "those nodes"} and their connections.
        </p>
        <div className="dialog-actions">
          <button onClick={close} type="button">
            Cancel
          </button>
          <button
            className="danger"
            onClick={() => void confirmDeleteAsset()}
            type="button"
          >
            Remove nodes and delete
          </button>
        </div>
      </div>
    </div>
  );
}
