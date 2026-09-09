import { useEffect, useState } from "react";
import { isApiError, projectsApi } from "../../api";
import { PROVIDER_EXECUTOR_KEY, executorKeyForNode } from "../../shared/domain";
import { useProviderStore } from "../settings/providerStore";
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
import {
  GENERATION_UNAVAILABLE,
  useAppStore,
  useGenerationAvailable,
} from "./stores/appStore";
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
import {
  UnsavedWorkDialog,
  type CloseAction,
} from "./components/UnsavedWorkDialog";
import { ExportBlockedDialog } from "./components/ExportBlockedDialog";
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
  const selectedIds = useEditorStore((state) => state.selection.nodeIds);
  // The nodes a run could drive: an operation node, or one carrying a generation
  // spec. Anything else is a run the server would only refuse.
  const runnable = selectedIds.flatMap((id) => {
    const node = activeCanvas?.nodes.find((entry) => entry.id === id);
    return node && executorKeyForNode(node) !== null ? [node] : [];
  });
  const runnableIds = runnable.map((node) => node.id);
  // Only a generation run can be refused by the deployment rather than by the
  // document, and it says so on the control instead of on the click.
  const generationOn = useGenerationAvailable();
  const waitingOnProvider =
    !generationOn &&
    runnable.length > 0 &&
    runnable.every(
      (node) => executorKeyForNode(node) === PROVIDER_EXECUTOR_KEY,
    );
  useEditorKeyboard();

  useEffect(() => {
    void useRunStore.getState().load();
  }, []);

  const zoom = liveZoom ?? activeCanvas?.viewport.zoom ?? 1;

  const [exportBlock, setExportBlock] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [closeBusy, setCloseBusy] = useState<CloseAction | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const pendingCount = useProjectStore((state) => state.pending.length);

  const finishClose = () => {
    useProjectStore.getState().close();
    useRunStore.getState().reset();
    useAppStore.getState().setPhase("launcher");
  };

  const requestClose = () => {
    const project = useProjectStore.getState();
    const guarded =
      project.pending.length > 0 ||
      project.saveStatus === "saving" ||
      project.saveStatus === "conflicted";
    if (!guarded) {
      finishClose();
      return;
    }
    setCloseError(null);
    setCloseGuardOpen(true);
  };

  const closeWith = async (action: CloseAction) => {
    if (action === "discard") {
      setCloseGuardOpen(false);
      finishClose();
      return;
    }
    setCloseBusy(action);
    setCloseError(null);
    const project = useProjectStore.getState();
    // A conflict blocks flushing; export then preserves the last saved revision.
    if (project.saveStatus !== "conflicted") {
      await project.flush();
      const after = useProjectStore.getState();
      if (after.pending.length > 0 || after.saveStatus === "conflicted") {
        setCloseBusy(null);
        setCloseError(
          after.saveStatus === "conflicted"
            ? "Saving is blocked by a revision conflict — reload the project or discard your changes."
            : (after.saveError ??
                "Saving failed — try again or discard your changes."),
        );
        return;
      }
    }
    if (action === "export") {
      try {
        await projectsApi.exportPackage({});
      } catch (error) {
        setCloseBusy(null);
        setCloseError(error instanceof Error ? error.message : "Export failed");
        return;
      }
    }
    setCloseBusy(null);
    setCloseGuardOpen(false);
    finishClose();
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

  const exportPackage = async (allowIncomplete = false) => {
    setExportBusy(allowIncomplete);
    try {
      const report = await projectsApi.exportPackage(
        allowIncomplete ? { allowIncomplete: true } : {},
      );
      setExportBlock(null);
      useAppStore
        .getState()
        .pushToast(
          "success",
          report.incomplete
            ? `Exported ${report.entries} files (flagged incomplete) to ${report.destination}`
            : `Exported ${report.entries} files to ${report.destination}`,
        );
    } catch (error) {
      if (!allowIncomplete && isApiError(error, "ASSET_MISSING")) {
        setExportBlock(error.message);
      } else {
        setExportBlock(null);
        useAppStore
          .getState()
          .pushToast(
            "error",
            error instanceof Error ? error.message : "Export failed",
          );
      }
    } finally {
      setExportBusy(false);
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
          onClick={requestClose}
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
            runnableIds.length === 0 ||
            starting ||
            runActive ||
            waitingOnProvider
          }
          onClick={() => void startRun()}
          title={
            waitingOnProvider
              ? GENERATION_UNAVAILABLE
              : runnableIds.length === 0
                ? "Select a node a run can drive"
                : `Run ${runnableIds.length} node${runnableIds.length === 1 ? "" : "s"}`
          }
          type="button"
        >
          {starting ? "Starting…" : runActive ? "Running…" : "▶ Run"}
        </button>
        <button
          onClick={() => useProviderStore.getState().openSettings()}
          type="button"
        >
          Settings
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
      {exportBlock !== null && (
        <ExportBlockedDialog
          busy={exportBusy}
          message={exportBlock}
          onCancel={() => setExportBlock(null)}
          onExportAnyway={() => void exportPackage(true)}
        />
      )}
      {closeGuardOpen && (
        <UnsavedWorkDialog
          busy={closeBusy}
          error={closeError}
          onAction={(action) => void closeWith(action)}
          onCancel={() => setCloseGuardOpen(false)}
          pendingCount={pendingCount}
          saveStatus={saveStatus}
        />
      )}

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
