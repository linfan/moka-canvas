import { useEffect } from "react";
import { useOpenCanvases } from "../stores/openCanvases";
import { useProjectStore } from "../stores/projectStore";
import {
  closeCanvas,
  openCanvas,
  reconcileTabs,
} from "../interactions/canvasTree";

/**
 * The boards being looked at.
 *
 * The strip across the top used to be every canvas the project has, which made
 * it a second copy of the tree beside the canvas and a long one for a project
 * with a dozen boards in it. It is now the boards that are open: a board is
 * opened from the tree and put down here, and putting it down touches nothing —
 * a tab is a way of looking at a board and not the board itself, so closing one
 * is never a question about unsaved work.
 *
 * What a board is called and where it is filed is the tree's business, not this
 * strip's: one place renames and one place opens, so neither has to guess what
 * the other meant.
 */
export function CanvasTabs() {
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const openIds = useOpenCanvases((state) => state.ids);

  // A board taken out of the document — deleted from the tree, or an undo of the
  // add that made it — takes its tab with it, wherever the deletion came from.
  const held = moka ? moka.canvas.map((canvas) => canvas.id).join(" ") : "";
  useEffect(() => {
    reconcileTabs();
  }, [held]);

  if (!moka) return null;

  // In the order the project holds them rather than the order they were opened,
  // so the strip reads the same way the tree does and does not rearrange itself
  // under the pointer as boards are opened and put down.
  const open = moka.canvas.filter((canvas) => openIds.includes(canvas.id));

  return (
    <nav aria-label="Open canvases" className="canvas-tabs">
      {open.map((canvas) => (
        <span
          className={`canvas-tab${
            canvas.id === activeCanvasId ? " is-active" : ""
          }`}
          key={canvas.id}
        >
          <button
            data-testid={`canvas-tab-${canvas.name}`}
            onClick={() => openCanvas(canvas.id)}
            title={`${canvas.nodes.length} nodes · ${canvas.edges.length} edges`}
            type="button"
          >
            {canvas.name}
          </button>
          {open.length > 1 && (
            <button
              aria-label={`Close ${canvas.name}`}
              className="canvas-tab-close"
              data-testid={`canvas-tab-close-${canvas.name}`}
              onClick={() => closeCanvas(canvas.id)}
              title="Close this canvas — it stays in the project"
              type="button"
            >
              ×
            </button>
          )}
        </span>
      ))}
      <span
        className="canvas-tabs-hint"
        title="Open a canvas from the project tree"
      >
        {moka.canvas.length} in project
      </span>
    </nav>
  );
}
