import { useEffect } from "react";
import { isApiError, projectsApi } from "../../api";
import { redo, undo } from "./commands/execute";
import { CanvasSurface } from "./canvas/CanvasSurface";
import { clientToWorld, zoomTo } from "./canvas/canvasControl";
import {
  ASSET_DRAG_MIME,
  addAssetNode,
  fitViewAction,
  importFiles,
} from "./interactions/actions";
import { useEditorKeyboard } from "./interactions/keyboard";
import { useAppStore } from "./stores/appStore";
import { useEditorStore, useEffectiveTool } from "./stores/editorStore";
import { useHistoryStore, isBoundary } from "./stores/historyStore";
import { useActiveCanvas, useProjectStore } from "./stores/projectStore";
import { useRunStore } from "./stores/runStore";
import { CanvasTabs } from "./panels/CanvasTabs";
import { ContextMenu } from "./panels/ContextMenu";
import { InspectorPanel } from "./panels/InspectorPanel";
import { NodeMenu } from "./panels/NodeMenu";
import { SidePanel } from "./panels/SidePanel";
import { AssetDeleteDialog } from "./components/AssetDeleteDialog";
import { AssetPreviewDialog } from "./components/AssetPreviewDialog";
import { RenameOverlay } from "./components/RenameOverlay";
import { TextEditOverlay } from "./components/TextEditOverlay";

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
  const liveZoom = useEditorStore((state) => state.camera?.zoom);
  const tool = useEffectiveTool();
  const resourcesPanelOpen = useEditorStore(
    (state) => state.resourcesPanelOpen,
  );
  const inspectorOpen = useEditorStore((state) => state.inspectorOpen);
  const announcement = useEditorStore((state) => state.announcement);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);
  const starting = useRunStore((state) => state.starting);
  const runActive = useRunStore((state) =>
    state.runs.some(
      (run) => run.status === "queued" || run.status === "running",
    ),
  );
  const runnableIds = useEditorStore((state) => state.selection.nodeIds).filter(
    (id) =>
      activeCanvas?.nodes.some(
        (node) => node.id === id && node.kind === "operation",
      ) ?? false,
  );
  useEditorKeyboard();

  useEffect(() => {
    void useRunStore.getState().load();
  }, []);

  const zoom = liveZoom ?? activeCanvas?.viewport.zoom ?? 1;

  const closeProject = async () => {
    const project = useProjectStore.getState();
    await project.flush();
    project.close();
    useRunStore.getState().reset();
    useAppStore.getState().setPhase("launcher");
  };

  const startRun = async () => {
    if (!activeCanvas || runnableIds.length === 0) return;
    try {
      await useRunStore.getState().start(activeCanvas.id, runnableIds);
    } catch (error) {
      const app = useAppStore.getState();
      if (isApiError(error, "RUN_VALIDATION_FAILED")) {
        const count = useRunStore.getState().lastIssues.length;
        app.pushToast(
          "error",
          count > 0
            ? `Run blocked by ${count} issue${count === 1 ? "" : "s"} — see inspector`
            : error.message,
        );
      } else {
        app.pushToast(
          "error",
          error instanceof Error ? error.message : "Run failed to start",
        );
      }
    }
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
      <div aria-live="polite" className="sr-only" role="status">
        {announcement}
      </div>
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
        <button
          className="run-button"
          disabled={
            runnableIds.length === 0 || starting || runActive
          }
          onClick={() => void startRun()}
          title={
            runnableIds.length === 0
              ? "Select an operation node to run"
              : `Run ${runnableIds.length} operation${runnableIds.length === 1 ? "" : "s"}`
          }
          type="button"
        >
          {starting ? "Starting…" : runActive ? "Running…" : "▶ Run"}
        </button>
        <button onClick={() => void exportPackage()} type="button">
          Export
        </button>
      </header>

      <div className="editor-body">
        {resourcesPanelOpen && <SidePanel />}
        <main
          className="editor-canvas"
          data-testid="canvas-host"
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const world = clientToWorld({
              x: event.clientX,
              y: event.clientY,
            });
            const assetId = event.dataTransfer.getData(ASSET_DRAG_MIME);
            if (assetId) {
              void addAssetNode(assetId, world ?? undefined);
              return;
            }
            const files = [...event.dataTransfer.files];
            if (files.length > 0) {
              void importFiles(files, {
                at: world ?? undefined,
                addNodes: true,
              });
            }
          }}
        >
          <CanvasSurface />
          <RenameOverlay />
          <TextEditOverlay />
          <p className="editor-canvas-hint">
            {activeCanvas
              ? `${activeCanvas.nodes.length} nodes · ${activeCanvas.edges.length} edges`
              : "No canvas"}
          </p>
        </main>
        {inspectorOpen && <InspectorPanel />}
      </div>

      <ContextMenu />
      <NodeMenu />
      <AssetDeleteDialog />
      <AssetPreviewDialog />

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
        <div aria-label="Zoom" className="tool-group" role="group">
          <button
            aria-label="Fit view"
            onClick={() => fitViewAction()}
            type="button"
          >
            Fit
          </button>
          <input
            aria-label="Zoom"
            className="zoom-slider"
            max={500}
            min={5}
            onChange={(event) => zoomTo(Number(event.target.value) / 100)}
            step={5}
            type="range"
            value={Math.round(zoom * 100)}
          />
          <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
        </div>
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
