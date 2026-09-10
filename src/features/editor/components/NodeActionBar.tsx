import { useMemo } from "react";
import { findNode, type AssetId } from "../../../shared/domain";
import { worldToClient } from "../canvas/canvasControl";
import {
  buildIssueIndex,
  buildResourceIndex,
  type MediaState,
} from "../canvas/mediaCards";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { TOOL_LABELS, useToolPrefs, type BarEntry } from "../stores/toolPrefs";

/** Gap left between the bar and the node, and between it and a canvas edge. */
const GAP = 6;
/** How tall the row of buttons is, which is all the bar ever is. */
const BAR_HEIGHT = 30;
/** The widest the bar gets, which is with every tool it has showing. */
const BAR_WIDTH = 400;

/** What each tool does, said where it is offered rather than after it is used. */
const TOOL_HINTS: Record<BarEntry, string> = {
  crop: "Cut a region out as a picture of its own",
  split: "Divide into pieces, and make a node for each",
  resize:
    "Resample these pixels to another size. Nothing is invented here: a model is what adds detail.",
  tilt: "Turn it in perspective, as a plate to show a model",
  repaint:
    "Mark the part that may change and say what it should become. A model does the repainting, so it costs what an ask costs.",
};

/**
 * Why a picture on the canvas cannot be worked on, when the self-check says so.
 *
 * Stated on the bar rather than left to be discovered by pressing it: a tool
 * asked of a file that is not there fails in a moment that reads as the tool
 * breaking, and the fix is not the tool's.
 */
const BROKEN: Record<Exclude<MediaState, "ready">, string> = {
  missing: "The file is not in the project any more",
  changed: "The file on disk is not the one that was filed",
  empty: "There is nothing in the file to work on",
};

/**
 * The tools that work on the picture a node holds, offered on the node itself.
 *
 * A DOM row over the canvas rather than part of the card, for the reason the
 * generation panel is one: a card drawn on a canvas has no room for buttons, and
 * a child in it would take part in the canvas's own hit testing. It hugs the top
 * border, and is kept off the canvas edges by clamping in CSS rather than by
 * measuring, since on the first render there is nothing to measure yet.
 *
 * Which tools it offers is the reader's to choose and is kept on this machine
 * rather than in the document, so a bar somebody has tidied stays tidied without
 * the tidying travelling to whoever opens the project next.
 */
export function NodeActionBar() {
  const selected = useEditorStore((state) => state.selection.nodeIds);
  const gesture = useEditorStore((state) => state.gesture);
  const camera = useEditorStore((state) => state.camera);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const shown = useToolPrefs((state) => state.shown);

  // Built once per document rather than once per selection: a project may hold
  // thousands of assets and the bar asks after the one it is showing.
  const indexes = useMemo(
    () =>
      moka
        ? {
            assets: buildResourceIndex(moka),
            issues: buildIssueIndex(selfCheck),
          }
        : null,
    [moka, selfCheck],
  );

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  const node =
    selected.length === 1 && canvas ? findNode(canvas, selected[0]) : null;

  if (!node || !canvas || !indexes || node.kind !== "image") return null;
  // A bar that travels with a node being moved is a bar under the pointer, and
  // the press that ends the move would land on a tool.
  if (gesture.kind === "draggingNodes" || gesture.kind === "resizingNode") {
    return null;
  }

  const assetId = (node.data as { assetId?: AssetId }).assetId;
  const entry = assetId ? indexes.assets.get(assetId) : undefined;
  if (!assetId || !entry) return null;
  const mime = entry.mime ?? entry.probe?.mime ?? "";
  if (!mime.startsWith("image/")) return null;

  // The camera is read for its own sake as much as for the zoom: it is what
  // re-renders the bar as the view moves, since worldToClient answers from the
  // live camera without telling anyone it changed.
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  const origin = worldToClient({ x: node.bounds.x, y: node.bounds.y });
  const broken = indexes.issues.get(assetId);
  const style: React.CSSProperties = {
    left: `clamp(${GAP}px, ${origin?.x ?? 0}px, calc(100% - ${
      BAR_WIDTH + GAP
    }px))`,
    top: `clamp(${GAP}px, ${
      (origin?.y ?? 0) - GAP * zoom - BAR_HEIGHT
    }px, calc(100% - ${BAR_HEIGHT + GAP}px))`,
  };

  const ask = (tool: BarEntry) =>
    useEditorStore
      .getState()
      .openPictureTool({ nodeId: node.id, assetId, tool });

  return (
    <div
      aria-label={`Picture tools for ${node.title}`}
      className="node-bar"
      data-testid="node-action-bar"
      role="toolbar"
      style={style}
    >
      {broken ? (
        <span className="node-bar-blocked">{BROKEN[broken]}</span>
      ) : (
        shown.map((tool) => (
          <button
            key={tool}
            onClick={() => ask(tool)}
            title={TOOL_HINTS[tool]}
            type="button"
          >
            {TOOL_LABELS[tool]}
          </button>
        ))
      )}
    </div>
  );
}
