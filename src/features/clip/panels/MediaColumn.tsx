import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import { PanelFold } from "../../editor/components/PanelFold";
import { AssetShelf } from "../../editor/panels/AssetShelf";
import { useProjectStore } from "../../editor/stores/projectStore";
import { addAssetAtPlayhead } from "../interactions/clipActions";
import { useClipStore, type ClipFace } from "../stores/clipStore";
import { AdjustPanel } from "./AdjustPanel";
import { FiltersPanel } from "./FiltersPanel";
import {
  canvasHeldIds,
  faceShelf,
  isMediaFace,
  PROJECT_NARROWINGS,
  type ProjectNarrowing,
} from "./mediaLenses";
import {
  previewKindOf,
  stopMediaPreview,
  toggleMediaPreview,
  useMediaPreview,
} from "./mediaPreview";
import { TextPanel } from "./TextPanel";

const TITLES: Record<ClipFace, string> = {
  project: "clip:mediaColumn.project",
  local: "clip:mediaColumn.local",
  text: "clip:mediaColumn.text",
  filters: "clip:mediaColumn.filters",
  adjust: "clip:mediaColumn.adjust",
};

const FILTER_LABELS: Record<ProjectNarrowing, string> = {
  all: "clip:mediaColumn.filterAll",
  made: "clip:mediaColumn.filterMade",
  canvas: "clip:mediaColumn.filterCanvas",
};

/** The row's own small offer on a sound or a picture in motion: hear it, or
    watch it in the card beside the shelf, before it is laid down. */
function PreviewAction({ entry }: { entry: ResourceEntry }) {
  const { t } = useTranslation();
  const preview = useMediaPreview();
  const kind = previewKindOf(entry);
  if (kind === null) return null;
  const playing = preview.assetId === entry.id && preview.playing;
  return (
    <button
      aria-label={t(
        playing ? "clip:mediaColumn.pauseAria" : "clip:mediaColumn.playAria",
        { name: entry.name },
      )}
      aria-pressed={playing}
      className={`resource-action clip-media-action${
        playing ? " is-playing" : ""
      }`}
      data-testid="clip-media-preview"
      onClick={() => {
        // A video plays where a file is read, so asking for one is also asking
        // the card to show it; a sound plays from the row itself.
        if (kind === "video") useClipStore.getState().selectMedia(entry.id);
        toggleMediaPreview(entry.id, kind);
      }}
      title={
        playing
          ? t("clip:mediaColumn.pausePreview")
          : t(
              kind === "audio"
                ? "clip:mediaColumn.previewSound"
                : "clip:mediaColumn.previewVideo",
            )
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
function mediaRowExtras(entry: ResourceEntry) {
  return (
    <>
      <PreviewAction entry={entry} />
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
 * The project face's own question, asked above the shelf rather than inside
 * its filter bar: which of the project's material the shelf is read for.
 */
function ProjectFilter({
  value,
  onChange,
}: {
  value: ProjectNarrowing;
  onChange: (next: ProjectNarrowing) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("clip:mediaColumn.filterLabel")}
      className="clip-media-filter"
      role="group"
    >
      {PROJECT_NARROWINGS.map((option) => (
        <button
          aria-pressed={value === option}
          className={value === option ? "is-active" : undefined}
          data-testid={`clip-project-filter-${option}`}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {t(FILTER_LABELS[option])}
        </button>
      ))}
    </div>
  );
}

/**
 * The column between the rail and the stage.
 *
 * Two of the five faces read the project's shelf — the same shelf the canvas
 * column shows — through a lens apiece (mediaLenses says which), with each row
 * carrying the room's own offers: trying a sound or a video before it is used,
 * and landing the file at the playhead. The project face also asks a question
 * of its own above the shelf: everything the project holds, what the models
 * made, or what the boards are holding. The other three faces are the room's
 * quick tools: the words written on the cut, the looks a clip can wear, and
 * the sliders that grade it, the last two working on whatever the timeline
 * holds chosen.
 */
export function MediaColumn() {
  const { t } = useTranslation();
  const face = useClipStore((state) => state.face);
  const mediaSelection = useClipStore((state) => state.mediaSelection);
  const playing = useClipStore((state) => state.playing);
  const moka = useProjectStore((state) => state.moka);
  // What the boards are holding is a question about the document, answered
  // once per document rather than once per row: the canvas narrowing reads
  // the index.
  const held = useMemo(() => canvasHeldIds(moka), [moka]);
  const [projectFilter, setProjectFilter] = useState<ProjectNarrowing>("all");
  const shelf = useMemo(
    () =>
      isMediaFace(face)
        ? faceShelf(face, { project: projectFilter, held })
        : null,
    [face, projectFilter, held],
  );
  const title = t(TITLES[face]);

  // A preview belongs to the moment it was asked for: leaving the face puts
  // the sound away rather than letting it follow the reader to another face.
  useEffect(() => () => stopMediaPreview(), [face]);
  // And the cut has the room to itself: a preview gives way the moment the
  // transport starts, so the two are never heard over each other.
  useEffect(() => {
    if (playing) stopMediaPreview();
  }, [playing]);

  return (
    <aside aria-label={title} className="clip-column" id="clip-panel-left">
      <PanelFold side="left" />
      {shelf ? (
        <>
          <div className="clip-media-head">
            <h2>{title}</h2>
          </div>
          {face === "project" && (
            <ProjectFilter onChange={setProjectFilter} value={projectFilter} />
          )}
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
