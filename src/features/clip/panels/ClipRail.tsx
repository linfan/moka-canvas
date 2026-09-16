import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useClipStore, type ClipFace } from "../stores/clipStore";
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

interface RailFace {
  face: ClipFace;
  /** The name the face is read under, as a translation key. */
  label: string;
  /** What the face is for, as a translation key. */
  hint: string;
  icon: ComponentType<{ size?: number }>;
}

/**
 * Where the material comes from. Four places a clip can be found rather than
 * made: this machine, the project's own shelf, what a run made, and the boards.
 */
const SOURCES: RailFace[] = [
  {
    face: "local",
    label: "clip:rail.local",
    hint: "clip:rail.localHint",
    icon: LocalIcon,
  },
  {
    face: "project",
    label: "clip:rail.project",
    hint: "clip:rail.projectHint",
    icon: ProjectIcon,
  },
  {
    face: "runs",
    label: "clip:rail.runs",
    hint: "clip:rail.runsHint",
    icon: RunsIcon,
  },
  {
    face: "canvas",
    label: "clip:rail.canvas",
    hint: "clip:rail.canvasHint",
    icon: ClipCanvasIcon,
  },
];

/**
 * What can be laid over the material. Five tools that work on the cut rather
 * than on where its pieces came from.
 */
const TOOLS: RailFace[] = [
  {
    face: "library",
    label: "clip:rail.library",
    hint: "clip:rail.libraryHint",
    icon: LibraryIcon,
  },
  {
    face: "audio",
    label: "clip:rail.audio",
    hint: "clip:rail.audioHint",
    icon: AudioIcon,
  },
  {
    face: "text",
    label: "clip:rail.text",
    hint: "clip:rail.textHint",
    icon: TextIcon,
  },
  {
    face: "filters",
    label: "clip:rail.filters",
    hint: "clip:rail.filtersHint",
    icon: FiltersIcon,
  },
  {
    face: "adjust",
    label: "clip:rail.adjust",
    hint: "clip:rail.adjustHint",
    icon: AdjustIcon,
  },
];

/**
 * The rail down the left of the cutting room.
 *
 * Nine faces of one column rather than nine panels: sources above, tools
 * below, and the one being read is marked. The rail says what each face is
 * with its mark and its title, since a rail is a row of drawers and a drawer
 * that only shows a glyph is a drawer to be opened to be known.
 */
export function ClipRail() {
  const { t } = useTranslation();
  const face = useClipStore((state) => state.face);
  const setFace = useClipStore((state) => state.setFace);

  const item = ({ face: id, label, hint, icon: Icon }: RailFace) => (
    <button
      aria-label={t(label)}
      aria-selected={face === id}
      className={face === id ? "clip-rail-item is-active" : "clip-rail-item"}
      data-testid={`clip-face-${id}`}
      key={id}
      onClick={() => setFace(id)}
      role="tab"
      title={t(hint)}
      type="button"
    >
      <Icon />
    </button>
  );

  return (
    <aside
      aria-label={t("clip:rail.label")}
      className="clip-rail"
      role="tablist"
    >
      <div className="clip-rail-group">{SOURCES.map(item)}</div>
      <div className="clip-rail-group">{TOOLS.map(item)}</div>
    </aside>
  );
}
