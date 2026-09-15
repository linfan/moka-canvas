import type { ComponentType } from "react";
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
  label: string;
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
    label: "Local",
    hint: "Files on this machine",
    icon: LocalIcon,
  },
  {
    face: "project",
    label: "Project",
    hint: "Everything the project holds",
    icon: ProjectIcon,
  },
  {
    face: "runs",
    label: "Runs",
    hint: "What generations made",
    icon: RunsIcon,
  },
  {
    face: "canvas",
    label: "Canvas",
    hint: "Pictures from the boards",
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
    label: "Library",
    hint: "Titles, overlays and pieces the app brings",
    icon: LibraryIcon,
  },
  {
    face: "audio",
    label: "Audio",
    hint: "Music, voice and effects",
    icon: AudioIcon,
  },
  { face: "text", label: "Text", hint: "Words on the cut", icon: TextIcon },
  {
    face: "filters",
    label: "Filters",
    hint: "The look a clip wears",
    icon: FiltersIcon,
  },
  {
    face: "adjust",
    label: "Adjust",
    hint: "Speed, volume and opacity",
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
  const face = useClipStore((state) => state.face);
  const setFace = useClipStore((state) => state.setFace);

  const item = ({ face: id, label, hint, icon: Icon }: RailFace) => (
    <button
      aria-label={label}
      aria-selected={face === id}
      className={face === id ? "clip-rail-item is-active" : "clip-rail-item"}
      data-testid={`clip-face-${id}`}
      key={id}
      onClick={() => setFace(id)}
      role="tab"
      title={hint}
      type="button"
    >
      <Icon />
    </button>
  );

  return (
    <aside aria-label="Clip panels" className="clip-rail" role="tablist">
      <div className="clip-rail-group">{SOURCES.map(item)}</div>
      <div className="clip-rail-group">{TOOLS.map(item)}</div>
    </aside>
  );
}
