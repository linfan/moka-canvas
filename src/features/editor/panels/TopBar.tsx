import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../settings/modelStore";
import { redo, undo } from "../commands/execute";
import { exportCanvasImage } from "../interactions/actions";
import { useHistoryStore, isBoundary } from "../stores/historyStore";
import { useActiveCanvas, useProjectStore } from "../stores/projectStore";
import { CanvasTabs } from "./CanvasTabs";
import { HomeMenu } from "../components/HomeMenu";

const SAVE_LABEL: Record<string, string> = {
  saved: "Saved",
  saving: "Saving…",
  conflicted: "Conflict",
  error: "Save failed",
};

function useCanUndo(): boolean {
  return useHistoryStore((state) => {
    const top = state.undoStack[state.undoStack.length - 1];
    return top !== undefined && !isBoundary(top);
  });
}

interface TopBarProps {
  onBack: () => void;
  /** Opens the export question; the dialog itself belongs to the page. */
  onExport: () => void;
}

/**
 * What the project is, where it is being saved, and the things that act on
 * the document as a whole.
 *
 * Everything that acts on one node lives on the node, in its inspector, or in
 * the menus the canvas itself offers, so this bar says the same thing however
 * much is selected — and the two exports, which answer one question between
 * them ("what should leave with this?"), are one button with two answers
 * under it rather than two buttons side by side.
 */
export function TopBar({ onBack, onExport }: TopBarProps) {
  const projectName = useProjectStore((state) => state.moka?.metadata.name);
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const saveError = useProjectStore((state) => state.saveError);
  const canvasDoc = useActiveCanvas();
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!exportRef.current?.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  return (
    <header className="editor-topbar">
      <HomeMenu current="canvas" onHome={onBack} />
      <strong className="editor-project-name">{projectName}</strong>
      <CanvasTabs />
      <span
        className={`save-status save-status-${saveStatus}`}
        title={saveError ?? undefined}
      >
        {SAVE_LABEL[saveStatus]}
      </span>
      {saveStatus === "conflicted" && (
        <button
          onClick={() => void useProjectStore.getState().reload()}
          type="button"
        >
          Reload
        </button>
      )}
      <div aria-label="Edit" className="tool-group" role="group">
        <button
          aria-label="Undo"
          disabled={!canUndo}
          onClick={() => undo()}
          type="button"
        >
          ↶
        </button>
        <button
          aria-label="Redo"
          disabled={!canRedo}
          onClick={() => redo()}
          type="button"
        >
          ↷
        </button>
      </div>
      <button
        onClick={() => useModelStore.getState().openSettings()}
        type="button"
      >
        Settings
      </button>
      <div className="export-menu" ref={exportRef}>
        <button
          aria-expanded={exportOpen}
          aria-haspopup="menu"
          data-testid="export-menu-button"
          onClick={() => setExportOpen((seen) => !seen)}
          type="button"
        >
          Export
        </button>
        {exportOpen && (
          <div
            aria-label="Export"
            className="menu export-menu-pop"
            data-testid="export-menu"
            role="menu"
          >
            <button
              onClick={() => {
                setExportOpen(false);
                onExport();
              }}
              role="menuitem"
              title="Choose what leaves with the project, and where to"
              type="button"
            >
              Export project
            </button>
            <button
              disabled={!canvasDoc || canvasDoc.nodes.length === 0}
              onClick={() => {
                setExportOpen(false);
                void exportCanvasImage();
              }}
              role="menuitem"
              title="Save the canvas as a PNG image"
              type="button"
            >
              Export as image
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
