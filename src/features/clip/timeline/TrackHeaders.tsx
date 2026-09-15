import type { Ref } from "react";
import type { TimelineDocument, TrackKind } from "../../../shared/domain";
import {
  AudioIcon,
  ClipCanvasIcon,
  EyeOffIcon,
  LockIcon,
  MutedIcon,
  TextIcon,
} from "../components/ClipIcons";
import { trackRows } from "./geometry";

interface TrackHeadersProps {
  timeline: TimelineDocument;
  /** Held by the canvas, which moves this column with the viewport's vertical scroll. */
  ref?: Ref<HTMLDivElement>;
}

/** The mark a row leads with, one per kind of track. */
function kindGlyph(kind: TrackKind) {
  if (kind === "video") return <ClipCanvasIcon size={15} />;
  if (kind === "audio") return <AudioIcon size={15} />;
  return <TextIcon size={15} />;
}

/**
 * The rows' names, beside the canvas.
 *
 * Read-only for now: what a track is called and what state it is in — the
 * toggles that change any of it are 08's. The column follows the viewport's
 * vertical scroll by the canvas's hand, since the scroller is the only place
 * a scroll happens.
 */
export function TrackHeaders({ timeline, ref }: TrackHeadersProps) {
  const rows = trackRows(timeline);

  return (
    <div className="clip-tl-headers" ref={ref}>
      {rows.map((row) => (
        <div
          className={
            row.track.hidden
              ? "clip-tl-header-row is-hidden"
              : "clip-tl-header-row"
          }
          data-track-id={row.track.id}
          key={row.track.id}
          style={{ height: row.height }}
          title={row.track.name}
        >
          <span aria-hidden="true" className="clip-tl-track-kind">
            {kindGlyph(row.track.kind)}
          </span>
          <span className="clip-tl-track-name">{row.track.name}</span>
          <span className="clip-tl-track-flags">
            {row.track.muted && (
              <span className="clip-tl-track-flag" title="Muted">
                <MutedIcon size={12} />
              </span>
            )}
            {row.track.hidden && (
              <span className="clip-tl-track-flag" title="Hidden">
                <EyeOffIcon size={12} />
              </span>
            )}
            {row.track.locked && (
              <span className="clip-tl-track-flag" title="Locked">
                <LockIcon size={12} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
