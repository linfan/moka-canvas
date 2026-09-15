import { useEffect, useState } from "react";
import type { TimelineDocument } from "../../../shared/domain";
import {
  ExitFullscreenIcon,
  FullscreenIcon,
  LoopIcon,
  PauseIcon,
  PlayIcon,
  SkipEndIcon,
  SkipStartIcon,
  SnapshotIcon,
  VolumeIcon,
} from "../components/ClipIcons";
import { useClipStore, type PreviewQuality } from "../stores/clipStore";
import { cutEndMs } from "../timeline/geometry";
import { formatTimecode } from "../timeline/timecode";

interface ClipTransportProps {
  timeline: TimelineDocument;
}

/** What the player reads, in the reference's order: skips, clock, sound, then the pane. */
const QUALITY_LABELS: { value: PreviewQuality; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "half", label: "Half" },
  { value: "quarter", label: "Quarter" },
];

/** A timeline's name as a file name: a cut is never a path. */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-");
}

/**
 * The row under the picture: everything that plays the cut.
 *
 * A reading of the store rather than a player of its own — pressing play sets
 * a flag, and the room's clock (07's transport hook) is what moves. The two
 * timecodes are the playhead and the end of the cut, and a cut with nothing
 * on a row that draws is all the row has to disable: skips, repeat, and the
 * camera have nowhere to go, while the frame badge still reads its rate.
 *
 * The snapshot is the preview's own canvas saved as a PNG, named for the
 * timeline and the moment, through the same blob-and-anchor path the board's
 * "export as image" uses. Fullscreen is asked of the preview pane, so the
 * picture and this row go to the whole window together and the button comes
 * back round to leave.
 */
export function ClipTransport({ timeline }: ClipTransportProps) {
  const playing = useClipStore((state) => state.playing);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const quality = useClipStore((state) => state.quality);
  const masterVolume = useClipStore((state) => state.masterVolume);
  const loop = useClipStore((state) => state.loop);
  const [fullscreen, setFullscreen] = useState(false);
  const fps = timeline.settings.fps;
  const endMs = cutEndMs(timeline);
  const empty = endMs <= 0;

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /** The frame under the playhead, saved where the reader asked for it. */
  const saveSnapshot = async (): Promise<void> => {
    const canvas = document.querySelector(".clip-preview-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(timeline.name)}-${formatTimecode(playheadMs, fps)}.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // The file is read from the URL after the click returns, so it is let go
    // on the next turn rather than under the download's feet.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  /** The whole pane to the window, or back: the button says which it will do. */
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const preview = document.querySelector(".clip-preview");
    if (preview instanceof HTMLElement)
      void preview.requestFullscreen().catch(() => {
        // A browser that will not go fullscreen leaves the pane as it is.
      });
  };

  return (
    <div className="clip-transport">
      <div className="clip-transport-group">
        <button
          aria-label="Back to start"
          className="clip-transport-button"
          disabled={empty}
          onClick={() => useClipStore.getState().setPlayhead(0)}
          title="Back to start"
          type="button"
        >
          <SkipStartIcon size={16} />
        </button>
        <button
          aria-label={playing ? "Pause" : "Play"}
          className="clip-transport-button is-play"
          disabled={empty}
          onClick={() => useClipStore.getState().togglePlay()}
          title={playing ? "Pause" : "Play"}
          type="button"
        >
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <button
          aria-label="To the end"
          className="clip-transport-button"
          disabled={empty}
          onClick={() => useClipStore.getState().setPlayhead(endMs)}
          title="To the end"
          type="button"
        >
          <SkipEndIcon size={16} />
        </button>
      </div>

      <span
        className="clip-transport-time"
        data-testid="transport-timecode"
        title="The playhead and the end of the cut"
      >
        {formatTimecode(playheadMs, fps)} /{" "}
        {formatTimecode(empty ? 0 : endMs, fps)}
      </span>

      <div className="clip-transport-group">
        <button
          aria-label="Repeat the cut"
          aria-pressed={loop}
          className={
            loop ? "clip-transport-button is-on" : "clip-transport-button"
          }
          disabled={empty}
          onClick={() => useClipStore.getState().toggleLoop()}
          title="Repeat the cut"
          type="button"
        >
          <LoopIcon size={16} />
        </button>
        <span className="clip-transport-volume">
          <VolumeIcon size={15} />
          <input
            aria-label="Master volume"
            className="clip-transport-slider"
            max={1}
            min={0}
            onChange={(event) =>
              useClipStore
                .getState()
                .setMasterVolume(Number(event.target.value))
            }
            step={0.01}
            title="Master volume"
            type="range"
            value={masterVolume}
          />
        </span>
      </div>

      <span className="clip-transport-fps" title="The cut's own frame rate">
        {fps}fps
      </span>

      <select
        aria-label="Preview quality"
        className="clip-transport-quality"
        onChange={(event) =>
          useClipStore
            .getState()
            .setQuality(event.target.value as PreviewQuality)
        }
        title="Preview quality"
        value={quality}
      >
        {QUALITY_LABELS.map((tier) => (
          <option key={tier.value} value={tier.value}>
            {tier.label}
          </option>
        ))}
      </select>

      <div className="clip-transport-group clip-transport-end">
        <button
          aria-label="Save snapshot"
          className="clip-transport-button"
          disabled={empty}
          onClick={() => void saveSnapshot()}
          title="Save snapshot"
          type="button"
        >
          <SnapshotIcon size={16} />
        </button>
        <button
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          className="clip-transport-button"
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          type="button"
        >
          {fullscreen ? (
            <ExitFullscreenIcon size={16} />
          ) : (
            <FullscreenIcon size={16} />
          )}
        </button>
      </div>
    </div>
  );
}
