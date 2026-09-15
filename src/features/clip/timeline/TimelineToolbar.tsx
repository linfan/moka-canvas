import type { TimelineDocument } from "../../../shared/domain";
import { FitIcon, ZoomInIcon, ZoomOutIcon } from "../components/ClipIcons";
import { useClipStore } from "../stores/clipStore";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, contentMs } from "./geometry";

/** One press of the buttons, and the step the slider's logarithm is anchored on. */
const ZOOM_STEP = 1.5;

interface TimelineToolbarProps {
  timeline: TimelineDocument;
}

/**
 * The timeline's toolbar, view side only.
 *
 * Zooming is about looking at the cut rather than changing it, so it lives
 * here from this package on. The action group the other side will hold —
 * cutting, duplicating, keeping the seams — arrives with 05/08/10 and is
 * deliberately absent rather than shown disabled.
 */
export function TimelineToolbar({ timeline }: TimelineToolbarProps) {
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const viewportPx = useClipStore((state) => state.viewportPx);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const zoomBy = useClipStore((state) => state.zoomBy);
  const zoomTo = useClipStore((state) => state.zoomTo);
  const fit = useClipStore((state) => state.fit);

  return (
    <div className="clip-tl-toolbar">
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
