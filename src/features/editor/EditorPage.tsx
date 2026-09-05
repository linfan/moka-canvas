import { projectsApi } from "../../api";
import { redo, undo } from "./commands/execute";
import { useAppStore } from "./stores/appStore";
import { useEditorStore, useEffectiveTool } from "./stores/editorStore";
import { useHistoryStore, isBoundary } from "./stores/historyStore";
import { useActiveCanvas, useProjectStore } from "./stores/projectStore";
import { CanvasTabs } from "./panels/CanvasTabs";
import { InspectorPanel } from "./panels/InspectorPanel";
import { SidePanel } from "./panels/SidePanel";

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

export function EditorPage() {
  const projectName = useProjectStore((state) => state.moka?.metadata.name);
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const saveError = useProjectStore((state) => state.saveError);
  const activeCanvas = useActiveCanvas();
  const tool = useEffectiveTool();
  const resourcesPanelOpen = useEditorStore(
    (state) => state.resourcesPanelOpen,
  );
  const inspectorOpen = useEditorStore((state) => state.inspectorOpen);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);

  const closeProject = async () => {
    const project = useProjectStore.getState();
    await project.flush();
    project.close();
    useAppStore.getState().setPhase("launcher");
  };

  const exportPackage = async () => {
    try {
      const report = await projectsApi.exportPackage({});
      useAppStore
        .getState()
        .pushToast(
          "success",
          `Exported ${report.entries} files to ${report.destination}`,
        );
    } catch (error) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          error instanceof Error ? error.message : "Export failed",
        );
    }
  };

  return (
    <div className="editor">
      <header className="editor-topbar">
        <button
          aria-label="Back to launcher"
          className="editor-back"
          onClick={() => void closeProject()}
          type="button"
        >
          ←
        </button>
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
        <button onClick={() => void exportPackage()} type="button">
          Export
        </button>
      </header>

      <div className="editor-body">
        {resourcesPanelOpen && <SidePanel />}
        <main className="editor-canvas" data-testid="canvas-host">
          <p className="editor-canvas-hint">
            {activeCanvas
              ? `${activeCanvas.nodes.length} nodes · ${activeCanvas.edges.length} edges`
              : "No canvas"}
          </p>
        </main>
        {inspectorOpen && <InspectorPanel />}
      </div>

      <footer className="editor-toolstrip">
        <div aria-label="Tool" className="tool-group" role="group">
          <button
            aria-pressed={tool === "select"}
            className={tool === "select" ? "is-active" : ""}
            onClick={() => useEditorStore.getState().setTool("select")}
            type="button"
          >
            Select
          </button>
          <button
            aria-pressed={tool === "pan"}
            className={tool === "pan" ? "is-active" : ""}
            onClick={() => useEditorStore.getState().setTool("pan")}
            type="button"
          >
            Pan
          </button>
        </div>
        <span className="zoom-readout">
          {Math.round((activeCanvas?.viewport.zoom ?? 1) * 100)}%
        </span>
        <div aria-label="Panels" className="tool-group" role="group">
          <button
            aria-pressed={resourcesPanelOpen}
            onClick={() => useEditorStore.getState().toggleResourcesPanel()}
            type="button"
          >
            Resources
          </button>
          <button
            aria-pressed={inspectorOpen}
            onClick={() => useEditorStore.getState().toggleInspector()}
            type="button"
          >
            Inspector
          </button>
        </div>
      </footer>
    </div>
  );
}
