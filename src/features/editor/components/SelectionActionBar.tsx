import { useTranslation } from "react-i18next";
import { findNode, type WorkflowNode } from "../../../shared/domain";
import { worldToClient } from "../canvas/canvasControl";
import {
  alignNodes,
  distributeNodes,
  equalizeNodes,
  groupSelection,
  deleteSelection,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas } from "../stores/projectStore";

/** Gap left between the bar and the selection, and between it and a canvas edge. */
const GAP = 6;
/** How tall the row of buttons is, which is all the bar ever is. */
const BAR_HEIGHT = 30;
/** The widest the bar gets, which is with every button it has showing. */
const BAR_WIDTH = 620;

function unionBounds(nodes: WorkflowNode[]) {
  const minX = Math.min(...nodes.map((node) => node.bounds.x));
  const minY = Math.min(...nodes.map((node) => node.bounds.y));
  return {
    x: minX,
    y: minY,
    width:
      Math.max(...nodes.map((node) => node.bounds.x + node.bounds.width)) -
      minX,
    height:
      Math.max(...nodes.map((node) => node.bounds.y + node.bounds.height)) -
      minY,
  };
}

/**
 * What can be done to a selection as a group, offered over the selection itself.
 *
 * A DOM row over the canvas for the reason the picture tools are one: cards
 * drawn on a canvas have no room for buttons. It sits over the top edge of the
 * room the selection takes up and is kept off the canvas edges by clamping in
 * CSS rather than by measuring, since on the first render there is nothing to
 * measure yet. Arrangements work on the members of a group rather than on a
 * frame standing for them, so a frame is not counted here.
 */
export function SelectionActionBar() {
  const { t } = useTranslation();
  const selected = useEditorStore((state) => state.selection.nodeIds);
  const gesture = useEditorStore((state) => state.gesture);
  const camera = useEditorStore((state) => state.camera);
  const canvas = useActiveCanvas();

  const nodes = canvas
    ? selected
        .map((nodeId) => findNode(canvas, nodeId))
        .filter((node): node is WorkflowNode => node !== undefined)
    : [];
  // A bar that travels with a selection being moved is a bar under the pointer,
  // and the press that ends the move would land on a button.
  if (gesture.kind === "draggingNodes" || gesture.kind === "resizingNode") {
    return null;
  }
  if (!canvas || nodes.length < 2) return null;

  const movable = nodes.filter((node) => node.kind !== "group");
  const spreadable = movable.length >= 3;
  const arranged = movable.length >= 2;

  // The camera is read for its own sake as much as for the zoom: it is what
  // re-renders the bar as the view moves, since worldToClient answers from the
  // live camera without telling anyone it changed.
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  const frame = unionBounds(nodes);
  const origin = worldToClient({ x: frame.x, y: frame.y });
  const style: React.CSSProperties = {
    left: `clamp(${GAP}px, ${origin?.x ?? 0}px, calc(100% - ${
      BAR_WIDTH + GAP
    }px))`,
    top: `clamp(${GAP}px, ${
      (origin?.y ?? 0) - GAP * zoom - BAR_HEIGHT
    }px, calc(100% - ${BAR_HEIGHT + GAP}px))`,
  };

  return (
    <div
      aria-label={t("editor:selectionBar.aria", { count: nodes.length })}
      className="node-bar selection-bar"
      data-testid="selection-action-bar"
      role="toolbar"
      style={style}
    >
      <button
        disabled={!arranged}
        onClick={() => groupSelection()}
        title={t("editor:selectionBar.groupHint")}
        type="button"
      >
        {t("editor:action.group")}
      </button>
      <button
        aria-label={t("editor:selectionBar.alignLeft")}
        disabled={!arranged}
        onClick={() => alignNodes("left")}
        title={t("editor:selectionBar.alignLeftHint")}
        type="button"
      >
        ⇤
      </button>
      <button
        aria-label={t("editor:selectionBar.alignCenters")}
        disabled={!arranged}
        onClick={() => alignNodes("center")}
        title={t("editor:selectionBar.alignCentersHint")}
        type="button"
      >
        ↔
      </button>
      <button
        aria-label={t("editor:selectionBar.alignRight")}
        disabled={!arranged}
        onClick={() => alignNodes("right")}
        title={t("editor:selectionBar.alignRightHint")}
        type="button"
      >
        ⇥
      </button>
      <button
        aria-label={t("editor:selectionBar.alignTop")}
        disabled={!arranged}
        onClick={() => alignNodes("top")}
        title={t("editor:selectionBar.alignTopHint")}
        type="button"
      >
        ⇧
      </button>
      <button
        aria-label={t("editor:selectionBar.alignMiddles")}
        disabled={!arranged}
        onClick={() => alignNodes("middle")}
        title={t("editor:selectionBar.alignMiddlesHint")}
        type="button"
      >
        ↕
      </button>
      <button
        aria-label={t("editor:selectionBar.alignBottom")}
        disabled={!arranged}
        onClick={() => alignNodes("bottom")}
        title={t("editor:selectionBar.alignBottomHint")}
        type="button"
      >
        ⇩
      </button>
      <button
        disabled={!arranged}
        onClick={() => equalizeNodes("width")}
        title={t("editor:selectionBar.sameWidthHint")}
        type="button"
      >
        {t("editor:selectionBar.sameWidth")}
      </button>
      <button
        disabled={!arranged}
        onClick={() => equalizeNodes("height")}
        title={t("editor:selectionBar.sameHeightHint")}
        type="button"
      >
        {t("editor:selectionBar.sameHeight")}
      </button>
      <button
        aria-label={t("editor:selectionBar.distributeHorizontally")}
        disabled={!spreadable}
        onClick={() => distributeNodes("horizontal")}
        title={t("editor:selectionBar.distributeHint")}
        type="button"
      >
        {t("editor:selectionBar.distributeHorizontallyLabel")}
      </button>
      <button
        aria-label={t("editor:selectionBar.distributeVertically")}
        disabled={!spreadable}
        onClick={() => distributeNodes("vertical")}
        title={t("editor:selectionBar.distributeHint")}
        type="button"
      >
        {t("editor:selectionBar.distributeVerticallyLabel")}
      </button>
      <button
        onClick={() => deleteSelection()}
        title={t("editor:selectionBar.deleteHint")}
        type="button"
      >
        {t("editor:action.delete")}
      </button>
    </div>
  );
}
