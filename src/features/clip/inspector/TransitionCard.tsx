import type {
  TimelineDocument,
  TimelineTransition,
  TransitionKind,
} from "../../../shared/domain";
import { followerOf } from "../../../shared/domain/timeline";
import { formatTimecode } from "../timeline/timecode";

/**
 * The seam a reader has chosen, told as facts.
 *
 * Read-only on purpose: changing a transition's kind or window is a rebuild
 * of the chain the seam sits in — released left to right, then laid back in
 * the shape the reader asked for — and that assembly is package 10's work.
 * Until it lands the card says what stands there and where the editing will
 * happen, rather than offering half a tool.
 */

const KIND_LABELS: Record<TransitionKind, string> = {
  none: "None",
  crossfade: "Crossfade",
  dipToBlack: "Dip to black",
  dipToWhite: "Dip to white",
  slideLeft: "Slide left",
  slideUp: "Slide up",
  wipe: "Wipe",
  zoomIn: "Zoom in",
};

export interface TransitionCardProps {
  timeline: TimelineDocument;
  transition: TimelineTransition;
}

export function TransitionCard({ timeline, transition }: TransitionCardProps) {
  const leader =
    timeline.clips.find((clip) => clip.id === transition.afterClipId) ?? null;
  const follower = leader ? followerOf(timeline, leader) : null;
  const seamMs = leader ? leader.startMs + leader.durationMs : null;

  return (
    <div className="clip-inspector-body" data-testid="clip-transition-card">
      <section className="inspector-section">
        <h3>Transition</h3>
        <div className="inspector-row">
          <span>Kind</span>
          <span>{KIND_LABELS[transition.kind]}</span>
        </div>
        <div className="inspector-row">
          <span>Window</span>
          <span>{transition.durationMs} ms</span>
        </div>
        {seamMs !== null && (
          <div className="inspector-row">
            <span>Seam</span>
            <span>{formatTimecode(seamMs, timeline.settings.fps)}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <h3>Cuts</h3>
        <div className="inspector-row">
          <span>Between</span>
          <span>
            {leader?.label ?? "A clip that is gone"} →{" "}
            {follower?.label ?? "nothing"}
          </span>
        </div>
      </section>

      <p className="inspector-note">
        Window and kind are edited on the seam itself
      </p>
    </div>
  );
}
