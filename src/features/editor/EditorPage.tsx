import { useEffect, useState } from "react";
import { isApiError, projectsApi } from "../../api";
import { unreferencedAssets, type MokaFile } from "../../shared/domain";
import { AssistantPanel } from "../assistant/AssistantPanel";
import { CanvasSurface } from "./canvas/CanvasSurface";
import { clientToWorld, zoomReset, zoomTo } from "./canvas/canvasControl";
import {
  ASSET_DRAG_MIME,
  addAssetNode,
  fitSelectionAction,
  fitViewAction,
  importFiles,
} from "./interactions/actions";
import { useEditorKeyboard } from "./interactions/keyboard";
import { useAppStore } from "./stores/appStore";
import { useEditorStore, useEffectiveTool } from "./stores/editorStore";
import { useActiveCanvas, useProjectStore } from "./stores/projectStore";
import { useRunStore, useRunsInFlight } from "./stores/runStore";
import { ContextMenu } from "./panels/ContextMenu";
import { InspectorPanel } from "./panels/InspectorPanel";
import { NodeMenu } from "./panels/NodeMenu";
import { SidePanel } from "./panels/SidePanel";
import { TopBar } from "./panels/TopBar";
import { AssetDeleteDialog } from "./components/AssetDeleteDialog";
import { AssetPickerModal } from "./components/AssetPickerModal";
import { AssetPreviewDialog } from "./components/AssetPreviewDialog";
import {
  UnsavedWorkDialog,
  type CloseAction,
} from "./components/UnsavedWorkDialog";
import { ExportBlockedDialog } from "./components/ExportBlockedDialog";
import {
  EXPORT_DEFAULTS,
  ExportDialog,
  type ExportChoices,
  type LeftBehind,
} from "./components/ExportDialog";
import { RenameOverlay } from "./components/RenameOverlay";
import { TextEditOverlay } from "./components/TextEditOverlay";
import { PromptPanel } from "./components/PromptPanel";
import { RunHint } from "./components/RunHint";
import { NodeActionBar } from "./components/NodeActionBar";
import { SelectionActionBar } from "./components/SelectionActionBar";
import { DescribeDialog } from "./components/DescribeDialog";
import { PictureToolDialog } from "./components/PictureToolDialog";
import { RepaintDialog } from "./components/RepaintDialog";

/** What a package asked to carry only the placed assets would leave behind. */
function countLeftBehind(moka: MokaFile | null): LeftBehind {
  if (!moka) return { count: 0, bytes: 0 };
  const shelf = unreferencedAssets(moka);
  return {
    count: shelf.length,
    bytes: shelf.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
  };
}

export function EditorPage() {
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const activeCanvas = useActiveCanvas();
  const liveZoom = useEditorStore((state) => state.camera?.zoom);
  const selectedCount = useEditorStore(
    (state) => state.selection.nodeIds.length,
  );
  const tool = useEffectiveTool();
  const resourcesPanelOpen = useEditorStore(
    (state) => state.resourcesPanelOpen,
  );
  const sidePanelOpen = useEditorStore((state) => state.sidePanelOpen);
  const sidePanelTab = useEditorStore((state) => state.sidePanelTab);
  const promptPanelOnSelect = useEditorStore(
    (state) => state.promptPanelOnSelect,
  );
  const announcement = useEditorStore((state) => state.announcement);
  const inFlight = useRunsInFlight();
  useEditorKeyboard();

  useEffect(() => {
    void useRunStore.getState().load();
  }, []);

  const zoom = liveZoom ?? activeCanvas?.viewport.zoom ?? 1;

  const [exportBlock, setExportBlock] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportChoices, setExportChoices] =
    useState<ExportChoices>(EXPORT_DEFAULTS);
  const [leftBehind, setLeftBehind] = useState<LeftBehind>({
    count: 0,
    bytes: 0,
  });
  const [exportThenClose, setExportThenClose] = useState(false);
  const [closeGuardOpen, setCloseGuardOpen] = useState(false);
  const [closeBusy, setCloseBusy] = useState<CloseAction | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const pendingCount = useProjectStore((state) => state.pending.length);

  // Read when the question is asked rather than watched: what is on offer is
  // the document as it stands at that moment, and numbers that move while a
  // dialog is being read are numbers to read again.
  const askAboutExport = (thenClose: boolean) => {
    setLeftBehind(countLeftBehind(useProjectStore.getState().moka));
    setExportThenClose(thenClose);
    setExportOpen(true);
  };

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
      project.saveStatus === "conflicted" ||
      inFlight > 0;
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
      setCloseBusy(null);
      setCloseGuardOpen(false);
      askAboutExport(true);
      return;
    }
    setCloseBusy(null);
    setCloseGuardOpen(false);
    finishClose();
  };

  const exportPackage = async (
    choices: ExportChoices,
    allowIncomplete = false,
  ) => {
    setExportChoices(choices);
    setExportBusy(true);
    try {
      const report = await projectsApi.exportPackage({
        allowIncomplete: allowIncomplete || undefined,
        includePersonalHistory: choices.includePersonalHistory || undefined,
        onlyReferencedAssets: choices.onlyReferencedAssets || undefined,
      });
      setExportBlock(null);
      setExportOpen(false);
      useAppStore
        .getState()
        .pushToast(
          "success",
          report.incomplete
            ? `Exported ${report.entries} files (flagged incomplete) to ${report.destination}`
            : `Exported ${report.entries} files to ${report.destination}`,
        );
      if (exportThenClose) finishClose();
    } catch (error) {
      if (!allowIncomplete && isApiError(error, "ASSET_MISSING")) {
        setExportOpen(false);
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
      <TopBar onBack={requestClose} onExport={() => askAboutExport(false)} />

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
          <NodeActionBar />
          <SelectionActionBar />
          <RenameOverlay />
          <TextEditOverlay />
          <PromptPanel />
          <RunHint />
          <p className="editor-canvas-hint">
            {activeCanvas
              ? `${activeCanvas.nodes.length} nodes · ${activeCanvas.edges.length} edges`
              : "No canvas"}
          </p>
        </main>
        {sidePanelOpen &&
          (sidePanelTab === "assistant" ? (
            <AssistantPanel />
          ) : (
            <InspectorPanel />
          ))}
      </div>

      <ContextMenu />
      <NodeMenu />
      <AssetDeleteDialog />
      <AssetPickerModal />
      <AssetPreviewDialog />
      <PictureToolDialog />
      <RepaintDialog />
      <DescribeDialog />
      {exportOpen && (
        <ExportDialog
          busy={exportBusy}
          leftBehind={leftBehind}
          onCancel={() => setExportOpen(false)}
          onExport={(choices) => void exportPackage(choices)}
        />
      )}
      {exportBlock !== null && (
        <ExportBlockedDialog
          busy={exportBusy}
          message={exportBlock}
          onCancel={() => setExportBlock(null)}
          onExportAnyway={() => void exportPackage(exportChoices, true)}
        />
      )}
      {closeGuardOpen && (
        <UnsavedWorkDialog
          busy={closeBusy}
          error={closeError}
          inFlight={inFlight}
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
          <button
            aria-label="Zoom to selection"
            disabled={selectedCount === 0}
            onClick={() => fitSelectionAction()}
            type="button"
          >
            Selection
          </button>
          <button
            aria-label="Zoom to 100 percent"
            onClick={() => zoomReset()}
            type="button"
          >
            100%
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
            aria-pressed={sidePanelOpen && sidePanelTab === "inspector"}
            onClick={() =>
              useEditorStore.getState().toggleSidePanel("inspector")
            }
            type="button"
          >
            Inspector
          </button>
          <button
            aria-pressed={sidePanelOpen && sidePanelTab === "assistant"}
            onClick={() =>
              useEditorStore.getState().toggleSidePanel("assistant")
            }
            title="Ask about the cards on this canvas"
            type="button"
          >
            Assistant
          </button>
          <button
            aria-pressed={promptPanelOnSelect}
            onClick={() =>
              useEditorStore.getState().togglePromptPanelOnSelect()
            }
            title="Bring the generation panel up when a node is selected"
            type="button"
          >
            Prompt
          </button>
        </div>
      </footer>
    </div>
  );
}
