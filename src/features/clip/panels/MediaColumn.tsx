import { useEffect, useMemo, type ComponentType } from "react";
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
import { useClipStore, type ClipFace } from "../stores/clipStore";
import {
  stopAudioPreview,
  toggleAudioPreview,
  useAudioPreview,
} from "./audioPreview";
import { canvasHeldIds, faceShelf, isMediaFace } from "./mediaLenses";

const FACES: Record<
  ClipFace,
  { title: string; icon: ComponentType<{ size?: number }> }
> = {
  local: { title: "Local media", icon: LocalIcon },
  project: { title: "Project media", icon: ProjectIcon },
  runs: { title: "Runs", icon: RunsIcon },
  canvas: { title: "On canvas", icon: ClipCanvasIcon },
  library: { title: "Library", icon: LibraryIcon },
  audio: { title: "Audio", icon: AudioIcon },
  text: { title: "Text", icon: TextIcon },
  filters: { title: "Filters", icon: FiltersIcon },
  adjust: { title: "Adjust", icon: AdjustIcon },
};

/** The sound's own small offer on its row: hear it before it is laid down. */
function AudioPreviewAction({ entry }: { entry: ResourceEntry }) {
  const preview = useAudioPreview();
  const playing = preview.assetId === entry.id && preview.playing;
  return (
    <button
      aria-label={`${playing ? "Pause" : "Play"} ${entry.name}`}
      aria-pressed={playing}
      className={`resource-action clip-media-action${
        playing ? " is-playing" : ""
      }`}
      onClick={() => toggleAudioPreview(entry.id)}
      title={playing ? "Pause the preview" : "Preview this sound"}
      type="button"
    >
      {playing ? "⏸" : "▶"}
    </button>
  );
}

/** The row actions the audio face adds to the shelf's own. */
function previewRowAction(entry: ResourceEntry) {
  return <AudioPreviewAction entry={entry} />;
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
 * audio face adding its own little way of hearing a row. The faces still to
 * arrive (text, filters, adjust) keep the placeholder they stand behind until
 * the packages that fill them come: a dead search box would be worse than an
 * empty drawer that says it is empty.
 */
export function MediaColumn() {
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

  const { title, icon: Icon } = FACES[face];

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
              onImported={backToLocal}
              onSelect={chooseMedia}
              rowExtras={face === "audio" ? previewRowAction : undefined}
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
              <p>This panel arrives with the media work.</p>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
