import { useRef } from "react";
import type { TimelineDocument } from "../../../shared/domain";
import { AddTrackButton } from "../components/TimelineMenu";
import { TimelineIcon } from "../components/ClipIcons";
import { useClipStore } from "../stores/clipStore";
import { TimelineCanvas } from "../timeline/TimelineCanvas";
import { TimelineToolbar } from "../timeline/TimelineToolbar";
import { TrackHeaders } from "../timeline/TrackHeaders";

interface TimelineAreaProps {
  timeline: TimelineDocument | null;
}

/**
 * The cut itself: the rows, the pieces, the seams and the playhead.
 *
 * A room with no timeline in it still says so rather than standing empty —
 * there is nothing to draw a canvas from. A timeline with nothing on it is
 * drawn all the same, since its rows are where the first piece will land; the
 * 02 copy lies over the empty canvas without taking a single click from the
 * ruler or the scroll underneath it.
 */
export function TimelineArea({ timeline }: TimelineAreaProps) {
  const headersRef = useRef<HTMLDivElement>(null);
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const playheadMs = useClipStore((state) => state.playheadMs);

  if (!timeline) {
    return (
      <section aria-label="Timeline" className="clip-timeline">
        <div className="clip-empty clip-empty-timeline">
          <TimelineIcon size={26} />
          <h3>Nothing here yet</h3>
          <p>Drop media on a track to build the cut.</p>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Timeline"
      className="clip-timeline"
      data-playhead-ms={playheadMs}
      data-px-per-sec={pxPerSec}
    >
      <TimelineToolbar timeline={timeline} />
      <div className="clip-tl-body">
        <div className="clip-tl-corner">
          <AddTrackButton timeline={timeline} />
        </div>
        <TrackHeaders ref={headersRef} timeline={timeline} />
        <TimelineCanvas headersRef={headersRef} timeline={timeline} />
      </div>
      {timeline.clips.length === 0 && (
        <div className="clip-empty clip-empty-timeline clip-tl-empty">
          <TimelineIcon size={26} />
          <h3>Nothing here yet</h3>
          <p>Drop media on a track to build the cut.</p>
        </div>
      )}
    </section>
  );
}
