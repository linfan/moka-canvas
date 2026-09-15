import type { TimelineDocument } from "../../../shared/domain";
import { TimelineIcon } from "../components/ClipIcons";

interface TimelineAreaProps {
  timeline: TimelineDocument | null;
}

/**
 * The cut itself: the tracks, the pieces and the playhead.
 *
 * Package 04 draws it. Until then, a timeline with nothing on it says so
 * rather than showing empty rows, which is the same thing the reference says
 * at this size and one less thing to unbuild when the rows arrive.
 */
export function TimelineArea({ timeline }: TimelineAreaProps) {
  const empty = !timeline || timeline.clips.length === 0;

  return (
    <section aria-label="Timeline" className="clip-timeline">
      {empty && (
        <div className="clip-empty clip-empty-timeline">
          <TimelineIcon size={26} />
          <h3>Nothing here yet</h3>
          <p>Drop media on a track to build the cut.</p>
        </div>
      )}
    </section>
  );
}
