import type { TimelineDocument } from "../../../shared/domain";
import { redo, undo } from "../../editor/commands/execute";
import { useCanUndo } from "../../editor/panels/PageTopBar";
import { useHistoryStore } from "../../editor/stores/historyStore";
import {
  DuplicateIcon,
  FitIcon,
  RedoIcon,
  ScissorsIcon,
  TrashIcon,
  UndoIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../components/ClipIcons";
import {
  clipsCrossingPlayhead,
  deleteSelection,
  duplicateSelection,
  splitSelectionAtPlayhead,
} from "../interactions/clipActions";
import { useClipStore } from "../stores/clipStore";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, contentMs } from "./geometry";

/** One press of the buttons, and the step the slider's logarithm is anchored on. */
export const ZOOM_STEP = 1.5;

interface TimelineToolbarProps {
  timeline: TimelineDocument;
}

/**
 * The timeline's toolbar: the tools on the left, the view on the right.
 *
 * Every button here acts at once — pointer, razor and the rest of the modes
 * are not this room's, so nothing waits for a second click. The edit group
 * asks the same questions the actions do: a split with nothing under the
 * playhead, a duplicate or a deletion with nothing chosen, or an undo with
 * nothing to undo are each said by going quiet rather than by refusing.
 */
export function TimelineToolbar({ timeline }: TimelineToolbarProps) {
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const viewportPx = useClipStore((state) => state.viewportPx);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const selection = useClipStore((state) => state.selection);
  const zoomBy = useClipStore((state) => state.zoomBy);
  const zoomTo = useClipStore((state) => state.zoomTo);
  const fit = useClipStore((state) => state.fit);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);

  const splitsHere = clipsCrossingPlayhead(timeline, playheadMs).length > 0;
  const hasClips = selection.clipIds.length > 0;
  const hasSelection = hasClips || selection.transitionId !== null;

  return (
    <div className="clip-tl-toolbar">
      <div className="clip-tl-toolbar-actions">
        <button
          aria-label="Split at the playhead"
          className="clip-tl-button"
          data-testid="clip-split"
          disabled={!splitsHere}
          onClick={() => splitSelectionAtPlayhead()}
          title="Split at the playhead"
          type="button"
        >
          <ScissorsIcon size={16} />
        </button>
        <button
          aria-label="Duplicate the selection"
          className="clip-tl-button"
          data-testid="clip-duplicate"
          disabled={!hasClips}
          onClick={() => duplicateSelection()}
          title="Duplicate the selection"
          type="button"
        >
          <DuplicateIcon size={16} />
        </button>
        <button
          aria-label="Delete the selection"
          className="clip-tl-button"
          data-testid="clip-delete"
          disabled={!hasSelection}
          onClick={() => deleteSelection()}
          title="Delete the selection"
          type="button"
        >
          <TrashIcon size={16} />
        </button>
        <button
          aria-label="Undo"
          className="clip-tl-button"
          data-testid="clip-undo"
          disabled={!canUndo}
          onClick={() => undo()}
          title="Undo"
          type="button"
        >
          <UndoIcon size={16} />
        </button>
        <button
          aria-label="Redo"
          className="clip-tl-button"
          data-testid="clip-redo"
          disabled={!canRedo}
          onClick={() => redo()}
          title="Redo"
          type="button"
        >
          <RedoIcon size={16} />
        </button>
      </div>
      <div className="clip-tl-toolbar-view">
        <button
          aria-label="Zoom out"
          className="clip-tl-button"
          data-testid="clip-zoom-out"
          disabled={pxPerSec <= MIN_PX_PER_SEC}
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          title="Zoom out"
          type="button"
        >
          <ZoomOutIcon size={16} />
        </button>
        <input
          aria-label="Zoom"
          className="clip-tl-slider"
          data-testid="clip-zoom-slider"
          max={Math.log(MAX_PX_PER_SEC)}
          min={Math.log(MIN_PX_PER_SEC)}
          onChange={(event) => zoomTo(Math.exp(Number(event.target.value)))}
          step={0.01}
          type="range"
          value={Math.log(pxPerSec)}
        />
        <button
          aria-label="Zoom in"
          className="clip-tl-button"
          data-testid="clip-zoom-in"
          disabled={pxPerSec >= MAX_PX_PER_SEC}
          onClick={() => zoomBy(ZOOM_STEP)}
          title="Zoom in"
          type="button"
        >
          <ZoomInIcon size={16} />
        </button>
        <button
          aria-label="Fit to window"
          className="clip-tl-button"
          data-testid="clip-zoom-fit"
          onClick={() => fit(viewportPx, contentMs(timeline, playheadMs))}
          title="Fit to window"
          type="button"
        >
          <FitIcon size={16} />
        </button>
      </div>
    </div>
  );
}
