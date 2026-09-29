import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ASSET_KIND_LABELS,
  type AssetId,
  type AssetKind,
  type ResourceEntry,
} from "../../../shared/domain";
import { addAssetNodes } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas } from "../stores/projectStore";
import { AssetShelf } from "./AssetShelf";
import { canvasAssetIds } from "./canvasAssets";
import { SHELF_KINDS, heldLens } from "./shelfFilter";

/**
 * The board's own material, one kind at a time, in the canvas column.
 *
 * The shelf itself is the shared `AssetShelf`; this is the editor's reading of
 * it: the four kinds, the kind the store is holding (the tree can turn the
 * column over to the kind a file is filed under), the reader's inspection for
 * the row that is being read, and the canvas offers a board can answer — Focus
 * and "Add to canvas", which no other page has.
 *
 * What the column lists is what the board being looked at holds rather than
 * every file the project does: the project's whole shelf is the files room's
 * question, reached from here through the picker. Files brought in and placed
 * nowhere wait in the tray above the list, where each one can be put on this
 * board with one press.
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

/** The way to the whole project's shelf: the picker, in its node-inserting mode. */
function fromTheProject() {
  useEditorStore.getState().openAssetPicker({ mode: "nodes", at: null });
}

/**
 * The tray's own offer: a file waiting for a place lands on this board as a
 * card, in the middle of the view, the same way an insert from the picker
 * lands — one press rather than a drag for the common case.
 */
function AddToCanvasAction({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  return (
    <button
      aria-label={t("editor:shelf.addToCanvasAria", { name: entry.name })}
      className="resource-action"
      data-testid="shelf-add-to-canvas"
      onClick={() => void addAssetNodes([entry.id])}
      title={t("editor:shelf.addToCanvas")}
      type="button"
    >
      ＋
    </button>
  );
}

export function AssetsPanel() {
  const { t } = useTranslation();
  const kind = useEditorStore((state) => state.assetKind);
  const focusedAssetId = useEditorStore((state) => state.focusedAssetId);
  // The file the column beside the canvas is reading: a row that is the one
  // being read says so, and a row's offer to go to the cards using it is an
  // offer about this board only.
  const inspected = useEditorStore((state) => state.inspectedAssetId);
  const activeCanvas = useActiveCanvas();
  // What this board holds, read once per document rather than once per row:
  // the lens the shelf narrows through.
  const held = useMemo(
    () => new Set(activeCanvas ? canvasAssetIds(activeCanvas) : []),
    [activeCanvas],
  );
  return (
    <div className="side-assets">
      <div className="side-assets-actions">
        <button
          data-testid="shelf-from-project"
          onClick={fromTheProject}
          title={t("editor:shelf.fromProjectHint")}
          type="button"
        >
          {t("editor:shelf.fromProject")}
        </button>
      </div>
      <AssetShelf
        emptyText={t("assets:shelf.emptyBoard", {
          kind: t(ASSET_KIND_LABELS[kind]).toLowerCase(),
        })}
        focusedId={focusedAssetId}
        kind={kind}
        kinds={SHELF_KINDS}
        lens={heldLens(held)}
        onFocusClear={forgetFocusedAsset}
        onKindChange={chooseKind}
        onSelect={inspectOnShelf}
        selectedId={inspected}
        unplaced={{
          titleKey: "assets:shelf.unplaced",
          action: (entry) => <AddToCanvasAction entry={entry} />,
        }}
      />
    </div>
  );
}
