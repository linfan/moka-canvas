import type { ComponentType } from "react";
import { PanelFold } from "../../editor/components/PanelFold";
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

const FACES: Record<
  ClipFace,
  { title: string; icon: ComponentType<{ size?: number }> }
> = {
  local: { title: "Local media", icon: LocalIcon },
  project: { title: "Project media", icon: ProjectIcon },
  runs: { title: "Runs", icon: RunsIcon },
  canvas: { title: "Canvases", icon: ClipCanvasIcon },
  library: { title: "Library", icon: LibraryIcon },
  audio: { title: "Audio", icon: AudioIcon },
  text: { title: "Text", icon: TextIcon },
  filters: { title: "Filters", icon: FiltersIcon },
  adjust: { title: "Adjust", icon: AdjustIcon },
};

/**
 * The column between the rail and the stage.
 *
 * Which face it shows is the rail's choice, and the head says the face in
 * words so the choice is readable from the column as well as from the rail.
 * What each face holds arrives with the packages that fill it: a placeholder
 * here is the honest thing to show while the shelf behind it is being built,
 * and no search box or import button is drawn for a shelf that is not there
 * yet — a dead control is worse than an empty drawer, which says so.
 */
export function MediaColumn() {
  const face = useClipStore((state) => state.face);
  const { title, icon: Icon } = FACES[face];

  return (
    <aside aria-label={title} className="clip-column" id="clip-panel-left">
      <PanelFold side="left" />
      <div className="clip-column-head">
        <h2>{title}</h2>
      </div>
      <div className="clip-column-body">
        <div className="clip-placeholder">
          <Icon size={26} />
          <p>This panel arrives with the media work.</p>
        </div>
      </div>
    </aside>
  );
}
