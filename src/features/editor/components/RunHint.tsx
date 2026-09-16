import { useTranslation } from "react-i18next";
import { findNode, LOW_DETAIL_ZOOM } from "../../../shared/domain";
import { worldToClient } from "../canvas/canvasControl";
import { NODE_HEADER_HEIGHT } from "../canvas/theme";
import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas } from "../stores/projectStore";
import { useNodeRunError } from "../stores/runStore";

const NOTE_WIDTH = 248;
const NOTE_HEIGHT = 84;
const GAP = 8;

/**
 * Why the ask a node made did not finish, held beside the card that says so.
 *
 * A card keeps what it held before a run gave up and adds one mark, because the
 * mark is small and the reason is not: the reason is asked for where the mark
 * is, and written down in full in the inspector for anybody not pointing at it.
 */
export function RunHint() {
  const { t } = useTranslation();
  const hovered = useEditorStore((state) => state.hoveredNodeId);
  // Read for its own sake as much as for the zoom: it is what brings the note
  // back as the view moves, since worldToClient answers from the live camera
  // without telling anyone it changed.
  const camera = useEditorStore((state) => state.camera);
  const canvas = useActiveCanvas();
  const failure = useNodeRunError(hovered);
  const node = hovered && canvas ? findNode(canvas, hovered) : null;
  // A card to sit beside, and something worth saying about it.
  if (!canvas || !node || !failure || failure.trim() === "") return null;

  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  // The mark the note explains is only drawn while the card carries detail, so
  // a note below that threshold would point at nothing.
  if (zoom < LOW_DETAIL_ZOOM) return null;
  const origin = worldToClient({
    x: node.bounds.x + node.bounds.width,
    y: node.bounds.y,
  });
  const style: React.CSSProperties = {
    left: `clamp(${GAP}px, ${(origin?.x ?? 0) + GAP}px, calc(100% - ${
      NOTE_WIDTH + GAP
    }px))`,
    // Below the header line rather than at the top edge: where there is no room
    // to the right the clamp drops the note onto the card, and the mark it
    // explains sits in that header corner.
    top: `clamp(${GAP}px, ${
      (origin?.y ?? 0) + NODE_HEADER_HEIGHT * zoom + GAP
    }px, calc(100% - ${NOTE_HEIGHT + GAP}px))`,
    width: NOTE_WIDTH,
  };

  return (
    <div
      className="run-note"
      data-testid="run-note"
      role="tooltip"
      style={style}
    >
      <strong className="run-note-head">
        {t("editor:run.thisAskDidNotFinish")}
      </strong>
      <p className="run-note-why">{failure}</p>
    </div>
  );
}
