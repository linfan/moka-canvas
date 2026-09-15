import type { TimelineDocument } from "../../../shared/domain";

interface PreviewStageProps {
  timeline: TimelineDocument | null;
}

/**
 * The picture the cut is being judged against.
 *
 * A frame and a readout for now: the timecode stands at the head, where it
 * will read the playhead once there is one, and the badge says the frame the
 * timeline is cut in, which is a fact of the document and reads right even
 * while the frame itself is still grey. Package 06 fills the frame.
 */
export function PreviewStage({ timeline }: PreviewStageProps) {
  const fps = timeline?.settings.fps ?? 30;

  return (
    <section aria-label="Preview" className="clip-preview">
      <div className="clip-preview-frame" />
      <div className="clip-preview-bar">
        <span className="clip-timecode">00:00:00:00</span>
        <span className="clip-preview-badge">{`${fps}fps Full`}</span>
      </div>
    </section>
  );
}
