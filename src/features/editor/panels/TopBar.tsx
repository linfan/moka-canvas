import { useRef } from "react";
import { isApiError } from "../../../api";
import {
  PROVIDER_EXECUTOR_KEY,
  executorKeyForNode,
} from "../../../shared/domain";
import { useModelStore } from "../../settings/modelStore";
import { viewCenterWorld } from "../canvas/canvasControl";
import { redo, undo } from "../commands/execute";
import {
  exportCanvasImage,
  groupSelection,
  importFiles,
  ungroupSelection,
} from "../interactions/actions";
import {
  GENERATION_UNAVAILABLE,
  useAppStore,
  useGenerationAvailable,
} from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { isBoundary, useHistoryStore } from "../stores/historyStore";
import { useActiveCanvas, useProjectStore } from "../stores/projectStore";
import { useRunStore, useRunsInFlight } from "../stores/runStore";
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
  /** The guarded close the menu's Home row asks for. */
  onBack: () => void;
  /** Opens the export question; the dialog itself belongs to the page. */
  onExport: () => void;
}

/**
 * What the project is, where it is being saved, and the things that act on the
 * document as a whole. Whatever acts on one node lives on the node or in its
 * inspector instead, so that this bar stays the same length for any selection.
 */
export function TopBar({ onBack, onExport }: TopBarProps) {
  const projectName = useProjectStore((state) => state.moka?.metadata.name);
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const saveError = useProjectStore((state) => state.saveError);
  const canvasDoc = useActiveCanvas();
  const selection = useEditorStore((state) => state.selection);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);
  const starting = useRunStore((state) => state.starting);
  const inFlight = useRunsInFlight();
  const runActive = inFlight > 0;
  const fileInput = useRef<HTMLInputElement | null>(null);

  // The nodes a run could drive: an operation node, or one carrying a generation
  // spec. Anything else is a run the server would only refuse.
  const runnable = selection.nodeIds.flatMap((id) => {
    const node = canvasDoc?.nodes.find((entry) => entry.id === id);
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
  const groupsSelected = selection.nodeIds.some(
    (id) => canvasDoc?.nodes.find((node) => node.id === id)?.kind === "group",
  );

  const startRun = async () => {
    if (!canvasDoc || runnableIds.length === 0) return;
    try {
      await useRunStore.getState().start(canvasDoc.id, runnableIds);
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

  /**
   * Opens the add-node menu under the button. A node made from the bar lands at
   * the middle of what the canvas is showing, which is where the eye already
   * is; the document's viewport is the same point when no canvas is mounted.
   */
  const openAddNode = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    useEditorStore.getState().openNodeMenu({
      x: rect.left,
      y: rect.bottom + 4,
      world: viewCenterWorld() ?? {
        x: canvasDoc?.viewport.x ?? 0,
        y: canvasDoc?.viewport.y ?? 0,
      },
      connectFrom: null,
    });
  };

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
      <div aria-label="Structure" className="tool-group" role="group">
        <button
          aria-haspopup="menu"
          onClick={openAddNode}
          title="Add a node at the middle of the view"
          type="button"
        >
          Add node
        </button>
        <button
          disabled={selection.nodeIds.length < 2}
          onClick={() => groupSelection()}
          title="Group the selected nodes"
          type="button"
        >
          Group
        </button>
        <button
          disabled={!groupsSelected}
          onClick={() => ungroupSelection()}
          title="Take the selected groups apart"
          type="button"
        >
          Ungroup
        </button>
      </div>
      <button
        className="run-button"
        disabled={
          runnableIds.length === 0 || starting || runActive || waitingOnProvider
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
        onClick={() => fileInput.current?.click()}
        title="Add files from this machine to the project"
        type="button"
      >
        Import…
      </button>
      <input
        aria-label="Import files into the project"
        hidden
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          // The resource panel shows the progress; here the files only have to
          // arrive, and land as nodes where the view is pointing.
          if (files.length > 0) void importFiles(files, { addNodes: true });
        }}
        ref={fileInput}
        type="file"
      />
      <button
        onClick={() => useModelStore.getState().openSettings()}
        type="button"
      >
        Settings
      </button>
      <button onClick={onExport} type="button">
        Export
      </button>
      <button
        disabled={!canvasDoc || canvasDoc.nodes.length === 0}
        onClick={() => void exportCanvasImage()}
        title="Save the canvas as a PNG image"
        type="button"
      >
        Export image
      </button>
    </header>
  );
}
