import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import { PanelFold } from "../../editor/components/PanelFold";
import { AssetShelf } from "../../editor/panels/AssetShelf";
import { addAssetAtPlayhead } from "../interactions/clipActions";
import { useClipStore, type ClipFace } from "../stores/clipStore";
import { AdjustPanel } from "./AdjustPanel";
import { FiltersPanel } from "./FiltersPanel";
import { faceShelf, isMediaFace } from "./mediaLenses";
import { TextPanel } from "./TextPanel";

const TITLES: Record<ClipFace, string> = {
  project: "clip:mediaColumn.project",
  local: "clip:mediaColumn.local",
  text: "clip:mediaColumn.text",
  filters: "clip:mediaColumn.filters",
  adjust: "clip:mediaColumn.adjust",
};

/** The row's own small offer on every face: the file lands where the playhead is. */
function AddAtPlayheadAction({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  return (
    <button
      aria-label={t("clip:mediaColumn.addAria", { name: entry.name })}
      className="resource-action clip-media-action"
      data-testid="clip-media-add"
      onClick={() => addAssetAtPlayhead(entry.id)}
      title={t("clip:common.addAtPlayhead")}
      type="button"
    >
      ＋
    </button>
  );
}

/** The row actions the media faces add to the shelf's own. */
function mediaRowExtras(entry: ResourceEntry) {
  return <AddAtPlayheadAction entry={entry} />;
}

/** Reads the row a reader chose, which the material card in the inspector reads. */
function chooseMedia(id: AssetId) {
  useClipStore.getState().selectMedia(id);
}

/** A file that just arrived is a file to use: the column turns to Local. */
function backToLocal() {
  useClipStore.getState().setFace("local");
}

/**
 * The column between the rail and the stage.
 *
 * Two of the five faces read the project's shelf — the same shelf the canvas
 * column shows — through a lens apiece (mediaLenses says which), with each row
 * carrying the room's own offer to land the file at the playhead. The other
 * three are the room's quick tools: the words written on the cut, the looks a
 * clip can wear, and the sliders that grade it, the last two working on
 * whatever the timeline holds chosen.
 */
export function MediaColumn() {
  const { t } = useTranslation();
  const face = useClipStore((state) => state.face);
  const mediaSelection = useClipStore((state) => state.mediaSelection);
  const shelf = useMemo(
    () => (isMediaFace(face) ? faceShelf(face) : null),
    [face],
  );
  const title = t(TITLES[face]);

  return (
    <aside aria-label={title} className="clip-column" id="clip-panel-left">
      <PanelFold side="left" />
      {shelf ? (
        <>
          <div className="clip-media-head">
            <h2>{title}</h2>
          </div>
          <div className="clip-media-scroll">
            <AssetShelf
              key={face}
              {...shelf}
              emptyText={t(shelf.emptyText)}
              onImported={backToLocal}
              onSelect={chooseMedia}
              rowExtras={mediaRowExtras}
              selectedId={mediaSelection}
            />
          </div>
        </>
      ) : (
        <>
          <div className="clip-column-head">
            <h2>{title}</h2>
          </div>
          <div className="clip-column-body">
            {face === "text" ? (
              <TextPanel />
            ) : face === "filters" ? (
              <FiltersPanel />
            ) : (
              <AdjustPanel />
            )}
          </div>
        </>
      )}
    </aside>
  );
}
