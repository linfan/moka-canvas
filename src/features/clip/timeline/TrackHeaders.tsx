import { useState, type MouseEvent as ReactMouseEvent, type Ref } from "react";
import type { TimelineDocument, TrackKind } from "../../../shared/domain";
import {
  AudioIcon,
  ClipCanvasIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  MutedIcon,
  TextIcon,
  UnlockIcon,
  VolumeIcon,
} from "../components/ClipIcons";
import { TimelineMenu } from "../components/TimelineMenu";
import { setTrackFlag } from "../interactions/clipActions";
import { trackRows } from "./geometry";

interface TrackHeadersProps {
  timeline: TimelineDocument;
  /** Held by the canvas, which moves this column with the viewport's vertical scroll. */
  ref?: Ref<HTMLDivElement>;
}

interface HeaderMenu {
  x: number;
  y: number;
  trackId: string;
}

/** The mark a row leads with, one per kind of track. */
function kindGlyph(kind: TrackKind) {
  if (kind === "video") return <ClipCanvasIcon size={15} />;
  if (kind === "audio") return <AudioIcon size={15} />;
  return <TextIcon size={15} />;
}

/**
 * The rows' names and switches, beside the canvas.
 *
 * What a track is called and what state it is in, and the one press each
 * toggle takes to change either: a row's mute is not offered on a text row,
 * since words have no sound to hold back. Every switch is one command and
 * one step of history, so a row muted by mistake is one undo from speaking
 * again. The column follows the viewport's vertical scroll by the canvas's
 * hand, since the scroller is the only place a scroll happens.
 */
export function TrackHeaders({ timeline, ref }: TrackHeadersProps) {
  const rows = trackRows(timeline);
  const [menu, setMenu] = useState<HeaderMenu | null>(null);

  const openMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, trackId });
  };

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
          onContextMenu={(event) => openMenu(event, row.track.id)}
          style={{ height: row.height }}
          title={row.track.name}
        >
          <span aria-hidden="true" className="clip-tl-track-kind">
            {kindGlyph(row.track.kind)}
          </span>
          <span className="clip-tl-track-name">{row.track.name}</span>
          <span className="clip-tl-track-flags">
            {row.track.kind !== "text" && (
              <button
                aria-label={`${row.track.muted ? "Unmute" : "Mute"} ${row.track.name}`}
                aria-pressed={row.track.muted}
                className="clip-tl-track-toggle"
                data-testid="track-mute"
                onClick={() =>
                  setTrackFlag(
                    timeline,
                    row.track.id,
                    "muted",
                    !row.track.muted,
                  )
                }
                title={`${row.track.muted ? "Unmute" : "Mute"} ${row.track.name}`}
                type="button"
              >
                {row.track.muted ? (
                  <MutedIcon size={13} />
                ) : (
                  <VolumeIcon size={13} />
                )}
              </button>
            )}
            <button
              aria-label={`${row.track.hidden ? "Show" : "Hide"} ${row.track.name}`}
              aria-pressed={row.track.hidden}
              className="clip-tl-track-toggle"
              data-testid="track-hide"
              onClick={() =>
                setTrackFlag(
                  timeline,
                  row.track.id,
                  "hidden",
                  !row.track.hidden,
                )
              }
              title={`${row.track.hidden ? "Show" : "Hide"} ${row.track.name}`}
              type="button"
            >
              {row.track.hidden ? (
                <EyeOffIcon size={13} />
              ) : (
                <EyeIcon size={13} />
              )}
            </button>
            <button
              aria-label={`${row.track.locked ? "Unlock" : "Lock"} ${row.track.name}`}
              aria-pressed={row.track.locked}
              className="clip-tl-track-toggle"
              data-testid="track-lock"
              onClick={() =>
                setTrackFlag(
                  timeline,
                  row.track.id,
                  "locked",
                  !row.track.locked,
                )
              }
              title={`${row.track.locked ? "Unlock" : "Lock"} ${row.track.name}`}
              type="button"
            >
              {row.track.locked ? (
                <LockIcon size={13} />
              ) : (
                <UnlockIcon size={13} />
              )}
            </button>
          </span>
        </div>
      ))}
      {menu && (
        <TimelineMenu
          onClose={() => setMenu(null)}
          target={{ kind: "track", trackId: menu.trackId }}
          timeline={timeline}
          x={menu.x}
          y={menu.y}
        />
      )}
    </div>
  );
}
