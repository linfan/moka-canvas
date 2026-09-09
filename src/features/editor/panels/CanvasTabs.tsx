import { useState } from "react";
import {
  emptyCanvas,
  MAX_CANVAS_NAME_LENGTH,
  newId,
} from "../../../shared/domain";
import { execute, historyBoundary } from "../commands/execute";
import { nextCanvasName, useProjectStore } from "../stores/projectStore";
import { runsInFlight } from "../stores/runStore";
import { useAppStore } from "../stores/appStore";

export function CanvasTabs() {
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const maxCanvases = useAppStore(
    (state) => state.config?.limits.maxCanvasesPerProject ?? Infinity,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (!moka) return null;

  const switchTo = (canvasId: string, name: string) => {
    if (canvasId === activeCanvasId) return;
    // A run belongs to the project rather than to the canvas on screen, so
    // switching does not stop one; but its result lands somewhere the reader has
    // just stopped looking, which is worth a word.
    const going = activeCanvasId ? runsInFlight(activeCanvasId) : 0;
    const left = moka.canvas.find((canvas) => canvas.id === activeCanvasId);
    useProjectStore.getState().switchCanvas(canvasId);
    historyBoundary(`Switch to ${name}`);
    if (going > 0 && left) {
      useAppStore
        .getState()
        .pushToast(
          "info",
          `${going} ${going === 1 ? "generation is" : "generations are"} still running on ${left.name}`,
        );
    }
  };

  const addCanvas = () => {
    const canvas = emptyCanvas(newId(), nextCanvasName(moka));
    const applied = execute("Add canvas", [{ type: "addCanvas", canvas }]);
    if (applied) switchTo(canvas.id, canvas.name);
  };

  const commitRename = (canvasId: string) => {
    const name = draft.trim().slice(0, MAX_CANVAS_NAME_LENGTH);
    setRenamingId(null);
    if (!name || name === moka.canvas.find((c) => c.id === canvasId)?.name)
      return;
    execute("Rename canvas", [{ type: "renameCanvas", canvasId, name }]);
  };

  const removeCanvas = (canvasId: string, name: string, nodes: number) => {
    if (moka.canvas.length <= 1) return;
    if (
      nodes > 0 &&
      !window.confirm(`Delete “${name}” and its ${nodes} nodes?`)
    )
      return;
    execute("Delete canvas", [{ type: "removeCanvas", canvasId }]);
  };

  return (
    <nav aria-label="Canvases" className="canvas-tabs">
      {moka.canvas.map((canvas) => (
        <span
          className={`canvas-tab${canvas.id === activeCanvasId ? " is-active" : ""}`}
          key={canvas.id}
        >
          {renamingId === canvas.id ? (
            <input
              aria-label="Canvas name"
              autoFocus
              maxLength={MAX_CANVAS_NAME_LENGTH}
              onBlur={() => commitRename(canvas.id)}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename(canvas.id);
                if (event.key === "Escape") setRenamingId(null);
              }}
              value={draft}
            />
          ) : (
            <button
              onClick={() => switchTo(canvas.id, canvas.name)}
              onDoubleClick={() => {
                setDraft(canvas.name);
                setRenamingId(canvas.id);
              }}
              title={`${canvas.nodes.length} nodes · ${canvas.edges.length} edges`}
              type="button"
            >
              {canvas.name}
            </button>
          )}
          {moka.canvas.length > 1 && (
            <button
              aria-label={`Delete ${canvas.name}`}
              className="canvas-tab-close"
              onClick={() =>
                removeCanvas(canvas.id, canvas.name, canvas.nodes.length)
              }
              type="button"
            >
              ×
            </button>
          )}
        </span>
      ))}
      <button
        aria-label="Add canvas"
        className="canvas-tab-add"
        disabled={moka.canvas.length >= maxCanvases}
        onClick={addCanvas}
        type="button"
      >
        +
      </button>
    </nav>
  );
}
