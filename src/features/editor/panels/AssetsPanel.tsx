import type { AssetId, AssetKind } from "../../../shared/domain";
import { useEditorStore } from "../stores/editorStore";
import { AssetShelf } from "./AssetShelf";
import { SHELF_KINDS } from "./shelfFilter";

/**
 * What the project is made of, one kind at a time, in the canvas column.
 *
 * The shelf itself is the shared `AssetShelf`; this is the editor's reading of
 * it: the four kinds, the kind the store is holding (the tree can turn the
 * column over to the kind a file is filed under), the reader's inspection for
 * the row that is being read, and the canvas offers a board can answer — Focus
 * and "Add to canvas", which no other page has.
 */

/** Reads a file chosen on the shelf in the inspector beside the canvas. */
function inspectOnShelf(id: AssetId) {
  useEditorStore.getState().inspectAsset(id);
}

/** Turns the shelf to a kind, which both the tabs and the tree ask for. */
function chooseKind(kind: AssetKind) {
  useEditorStore.getState().setAssetKind(kind);
}

/** Takes the brought-here mark off again, once the row has been seen. */
function forgetFocusedAsset() {
  useEditorStore.getState().clearAssetFocus();
}

export function AssetsPanel() {
  const kind = useEditorStore((state) => state.assetKind);
  const focusedAssetId = useEditorStore((state) => state.focusedAssetId);
  // The file the column beside the canvas is reading: a row that is the one
  // being read says so, and a row's offer to go to the cards using it is an
  // offer about this board only.
  const inspected = useEditorStore((state) => state.inspectedAssetId);
  return (
    <AssetShelf
      focusedId={focusedAssetId}
      kind={kind}
      kinds={SHELF_KINDS}
      onFocusClear={forgetFocusedAsset}
      onKindChange={chooseKind}
      onSelect={inspectOnShelf}
      selectedId={inspected}
    />
  );
}
