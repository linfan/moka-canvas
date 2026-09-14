import { PanelFold } from "../components/PanelFold";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { AssetsPanel } from "./AssetsPanel";
import { ProjectTree } from "./ProjectTree";

/**
 * The column on the left of the canvas, and the choice of what it shows.
 *
 * Two faces of one column rather than two columns: what a project holds — its
 * boards, the folders they are filed in, and what each board is made of — and
 * what it is made of altogether, the files a board can be given. They are read
 * together often enough to sit beside each other, and a canvas narrow enough to
 * need one of them folded away needs the other folded away too.
 *
 * Following a file from the tree to the shelf turns the column over rather than
 * opening anything, which is the point of two faces of one thing: what a reader
 * was looking at is still beside what they were looking at it in.
 *
 * The corner of the column folds the whole of it away, for a canvas that wants
 * the room; what is left in that corner of the window brings it back.
 */
export function SidePanel() {
  const moka = useProjectStore((state) => state.moka);
  const tab = useEditorStore((state) => state.leftPanelTab);
  const setTab = useEditorStore((state) => state.setLeftPanelTab);
  if (!moka) return null;

  return (
    <aside aria-label="Project" className="editor-side" id="panel-left">
      <PanelFold side="left" />
      <div
        aria-label="What the column shows"
        className="side-panel-tabs"
        role="tablist"
      >
        <button
          aria-selected={tab === "project"}
          className={tab === "project" ? "is-active" : ""}
          data-testid="left-tab-project"
          onClick={() => setTab("project")}
          role="tab"
          title="The project's canvases and the folders they are filed in"
          type="button"
        >
          Project
        </button>
        <button
          aria-selected={tab === "assets"}
          className={tab === "assets" ? "is-active" : ""}
          data-testid="left-tab-assets"
          onClick={() => setTab("assets")}
          role="tab"
          title="The files this project holds, by kind"
          type="button"
        >
          Assets
        </button>
      </div>
      {tab === "project" ? <ProjectTree /> : <AssetsPanel />}
    </aside>
  );
}
