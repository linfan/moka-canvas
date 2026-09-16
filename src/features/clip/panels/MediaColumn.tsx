import { useEffect, useMemo, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import { PanelFold } from "../../editor/components/PanelFold";
import { AssetShelf } from "../../editor/panels/AssetShelf";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  AdjustIcon,
  AudioIcon,
  ClipCanvasIcon,
  FiltersIcon,
  LibraryIcon,
  LocalIcon,
  ProjectIcon,
  RunsIcon,
  TextIcon,
} from "../components/ClipIcons";
import { addAssetAtPlayhead } from "../interactions/clipActions";
import { useClipStore, type ClipFace } from "../stores/clipStore";
import { AdjustPanel } from "./AdjustPanel";
import {
  stopAudioPreview,
  toggleAudioPreview,
  useAudioPreview,
} from "./audioPreview";
import { FiltersPanel } from "./FiltersPanel";
import { canvasHeldIds, faceShelf, isMediaFace } from "./mediaLenses";
import { TextPanel } from "./TextPanel";

const FACES: Record<
  ClipFace,
  { titleKey: string; icon: ComponentType<{ size?: number }> }
> = {
  local: { titleKey: "clip:mediaColumn.local", icon: LocalIcon },
  project: { titleKey: "clip:mediaColumn.project", icon: ProjectIcon },
  runs: { titleKey: "clip:mediaColumn.runs", icon: RunsIcon },
  canvas: { titleKey: "clip:mediaColumn.canvas", icon: ClipCanvasIcon },
  library: { titleKey: "clip:mediaColumn.library", icon: LibraryIcon },
  audio: { titleKey: "clip:mediaColumn.audio", icon: AudioIcon },
  text: { titleKey: "clip:mediaColumn.text", icon: TextIcon },
  filters: { titleKey: "clip:mediaColumn.filters", icon: FiltersIcon },
  adjust: { titleKey: "clip:mediaColumn.adjust", icon: AdjustIcon },
};

/** The sound's own small offer on its row: hear it before it is laid down. */
function AudioPreviewAction({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const preview = useAudioPreview();
  const playing = preview.assetId === entry.id && preview.playing;
  return (
    <button
      aria-label={t(
        playing ? "clip:mediaColumn.pauseAria" : "clip:mediaColumn.playAria",
        {
          name: entry.name,
        },
      )}
      aria-pressed={playing}
      className={`resource-action clip-media-action${
        playing ? " is-playing" : ""
      }`}
      onClick={() => toggleAudioPreview(entry.id)}
      title={
        playing
          ? t("clip:mediaColumn.pausePreview")
          : t("clip:mediaColumn.previewSound")
      }
      type="button"
    >
      {playing ? "⏸" : "▶"}
    </button>
  );
}

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
function mediaRowExtras(face: ClipFace) {
  return (entry: ResourceEntry) => (
    <>
      {face === "audio" && <AudioPreviewAction entry={entry} />}
      <AddAtPlayheadAction entry={entry} />
    </>
  );
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
 * Six of the nine faces read the project's shelf — the same shelf the canvas
 * column shows — through a lens apiece (mediaLenses says which), with the
 * audio face adding its own little way of hearing a row. Two more are the
 * room's quick tools: the looks a clip can wear and the three sliders that
 * grade it, both working on whatever the timeline holds chosen. The last is
 * the text face, where words are written and subtitles come and go — a page
 * of its own rather than a shelf, so it stands where the placeholders used to.
 */
export function MediaColumn() {
  const { t } = useTranslation();
  const face = useClipStore((state) => state.face);
  const moka = useProjectStore((state) => state.moka);
  const mediaSelection = useClipStore((state) => state.mediaSelection);
  // What the boards hold is a question about the document, answered once per
  // document rather than once per row: the canvas face reads the index.
  const held = useMemo(() => canvasHeldIds(moka), [moka]);
  const shelf = useMemo(
    () => (isMediaFace(face) ? faceShelf(face, held) : null),
    [face, held],
  );
  // A preview belongs to the face being read: leaving the shelf leaves the
  // sound behind rather than having it follow the reader to another face.
  useEffect(() => () => stopAudioPreview(), [face]);

  const { titleKey, icon: Icon } = FACES[face];
  const title = t(titleKey);

  return (
    <aside aria-label={title} className="clip-column" id="clip-panel-left">
      <PanelFold side="left" />
      {face === "filters" || face === "adjust" ? (
        <>
          <div className="clip-column-head">
            <h2>{title}</h2>
          </div>
          <div className="clip-column-body">
            {face === "filters" ? <FiltersPanel /> : <AdjustPanel />}
          </div>
        </>
      ) : face === "text" ? (
        <>
          <div className="clip-column-head">
            <h2>{title}</h2>
          </div>
          <div className="clip-column-body">
            <TextPanel />
          </div>
        </>
      ) : shelf ? (
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
              rowExtras={mediaRowExtras(face)}
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
            <div className="clip-placeholder">
              <Icon size={26} />
              <p>{t("clip:mediaColumn.placeholder")}</p>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
