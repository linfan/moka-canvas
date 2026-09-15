import { useEffect, useRef, useState } from "react";
import {
  CLIP_LABEL_MAX,
  MAX_CLIP_SPEED,
  MAX_CLIP_VOLUME,
  MIN_CLIP_SPEED,
  type ClipPatch,
  type TimelineClip,
  type TimelineDocument,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import {
  DuplicateIcon,
  ScissorsIcon,
  TrashIcon,
} from "../components/ClipIcons";
import {
  deleteSelection,
  detachAudio,
  duplicateSelection,
  materialOf,
  splitSelectionAtPlayhead,
} from "../interactions/clipActions";
import { useClipStore } from "../stores/clipStore";
import {
  formatTimecode,
  frameAligned,
  parseTimecode,
} from "../timeline/timecode";
import {
  clampFade,
  durationPatch,
  labelText,
  patchCommands,
  sharedValue,
  speedIsLocked,
  speedPatch,
  startPatch,
  wholeNumberIn,
} from "./clipFieldMath";

/**
 * What a clip is, and how it plays, as a form over the document.
 *
 * Every field commits on its own — a number on blur or Enter, a slider on
 * release — so one change is one entry of history and the undo of a volume
 * nudge never also takes back the trim that came before it. A selection of
 * several clips shows what they agree on: a value they do not share reads as
 * `Mixed`, and writing a value writes it to all of them in one step.
 *
 * The panel owns no draft beyond the text a reader is typing and a slider
 * held down: the document is only ever sent what a release decided.
 */

const SPEED_PRESETS = [0.5, 1, 1.5, 2] as const;

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

/** Text held locally while a field is being typed in, synced when it is not. */
function useTypedText(value: string) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  return { text, setText, focused };
}

/** A labelled clock field: `hh:mm:ss:ff`, parsed on the document's own rate. */
function TimecodeField({
  fps,
  label,
  ms,
  onCommit,
}: {
  fps: number;
  label: string;
  /** The moment the field stands for; null on a set of clips that disagree. */
  ms: number | null;
  onCommit: (ms: number) => void;
}) {
  const shown = ms === null ? "" : formatTimecode(ms, fps);
  const { text, setText, focused } = useTypedText(shown);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (text.trim().length === 0) {
      setBad(false);
      setText(shown);
      return;
    }
    const parsed = parseTimecode(text, fps);
    if (parsed === null) {
      // A reading that is not a timecode is shown going red rather than
      // jumping a clip somewhere the reader did not ask for.
      setBad(true);
      return;
    }
    setBad(false);
    if (ms !== null && parsed === ms) return;
    onCommit(parsed);
  };
  return (
    <label className={`clip-inspector-field${bad ? " is-invalid" : ""}`}>
      <span>{label}</span>
      <input
        inputMode="numeric"
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(event) => {
          setText(event.target.value);
          setBad(false);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder={ms === null ? "Mixed" : "hh:mm:ss:ff"}
        title={bad ? "Not a timecode" : undefined}
        value={text}
      />
    </label>
  );
}

/** A labelled whole-number field, milliseconds or a pace. */
function NumberField({
  label,
  max,
  min,
  onCommit,
  value,
}: {
  label: string;
  max: number;
  min: number;
  /** The number the field stands for; null on a set of clips that disagree. */
  value: number | null;
  onCommit: (value: number) => void;
}) {
  const shown = value === null ? "" : String(value);
  const { text, setText, focused } = useTypedText(shown);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (text.trim().length === 0) {
      setBad(false);
      setText(shown);
      return;
    }
    const parsed = wholeNumberIn(text, min, max);
    if (parsed === null) {
      setBad(true);
      return;
    }
    setBad(false);
    if (value !== null && parsed === value) return;
    onCommit(parsed);
  };
  return (
    <label className={`clip-inspector-field${bad ? " is-invalid" : ""}`}>
      <span>{label}</span>
      <input
        inputMode="numeric"
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(event) => {
          setText(event.target.value);
          setBad(false);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        placeholder={value === null ? "Mixed" : undefined}
        value={text}
      />
    </label>
  );
}

/** One line of facts that are read rather than written. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="inspector-row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export interface ClipFieldsProps {
  timeline: TimelineDocument;
  /** The chosen clips, in the order the timeline holds them. */
  clips: TimelineClip[];
}

export function ClipFields({ timeline, clips }: ClipFieldsProps) {
  const fps = timeline.settings.fps;
  const playheadMs = useClipStore((state) => state.playheadMs);
  const many = clips.length > 1;
  const single = clips.length === 1 ? clips[0] : null;
  const playhead = frameAligned(playheadMs, fps);

  /**
   * One change, sent over every chosen clip as one step of history.
   *
   * The window, the frame clock and the material ceiling are decided by the
   * pure arithmetic in clipFields; the command layer still has the last word
   * about a neighbour a move would land on, and says so where it refuses.
   */
  const commit = (patches: { clipId: string; patch: ClipPatch }[]) => {
    const filled = patches.filter(
      (entry) => Object.keys(entry.patch).length > 0,
    );
    if (filled.length === 0) return;
    execute(
      many ? "Edit clips" : "Edit clip",
      patchCommands(timeline.id, filled),
    );
  };

  // The pace of a picture is its own length, so the speed controls are shut
  // for any set that holds one rather than offering a move that is refused.
  const materials = clips.map((clip) => materialOf(clip));
  const speedLocked = materials.some((material) => speedIsLocked(material));
  const speed = sharedValue(clips.map((clip) => clip.speed));

  const applySpeed = (next: number) => {
    const built = clips.map((clip, index) => ({
      clipId: clip.id,
      patch: speedPatch(clip, next, materials[index].ownClock),
    }));
    if (built.some((entry) => entry.patch === null)) {
      toast("error", "Too short to run that fast.");
      return;
    }
    commit(
      built.map((entry) => ({
        clipId: entry.clipId,
        patch: entry.patch ?? {},
      })),
    );
  };

  const start = sharedValue(clips.map((clip) => clip.startMs));
  const earliest = Math.min(...clips.map((clip) => clip.startMs));
  const applyStart = (wantedMs: number) => {
    // A set that disagrees moves rigidly, measured from its earliest head:
    // typing one moment into a mixed field says where the front of the run
    // goes rather than setting every block onto the same place.
    const delta = wantedMs - (start ?? earliest);
    commit(
      clips.map((clip) => ({
        clipId: clip.id,
        patch: startPatch(clip, clip.startMs + delta, fps),
      })),
    );
  };

  const duration = sharedValue(clips.map((clip) => clip.durationMs));
  const applyDuration = (wantedMs: number) => {
    commit(
      clips.map((clip, index) => ({
        clipId: clip.id,
        patch: durationPatch(clip, wantedMs, fps, materials[index]),
      })),
    );
  };

  const volume = sharedValue(clips.map((clip) => clip.volume));
  const muted = sharedValue(clips.map((clip) => clip.muted));
  const [heldVolume, setHeldVolume] = useState<number | null>(null);
  const volumeShown = heldVolume ?? volume ?? 1;

  const fadeIn = sharedValue(clips.map((clip) => clip.fadeInMs));
  const fadeOut = sharedValue(clips.map((clip) => clip.fadeOutMs));
  const longest = Math.max(...clips.map((clip) => clip.durationMs));

  const applyFade = (which: "in" | "out", valueMs: number) => {
    // A mixed pair of fades is written per clip from what that clip holds
    // as the other, so a set can share one number without losing its own.
    commit(
      clips.map((clip) => {
        const other = which === "in" ? clip.fadeOutMs : clip.fadeInMs;
        const own = clampFade(valueMs, clip.durationMs, other);
        return {
          clipId: clip.id,
          patch:
            which === "in"
              ? { fadeInMs: own, fadeOutMs: clip.fadeOutMs }
              : { fadeInMs: clip.fadeInMs, fadeOutMs: own },
        };
      }),
    );
  };

  const opacityClips = clips.filter((clip) => clip.kind !== "text");
  const opacity = sharedValue(opacityClips.map((clip) => clip.opacity));
  const [heldOpacity, setHeldOpacity] = useState<number | null>(null);
  const opacityShown = heldOpacity ?? opacity ?? 1;

  const applyOpacity = (value: number) => {
    commit(
      opacityClips.map((clip) => ({
        clipId: clip.id,
        patch: { opacity: value },
      })),
    );
  };

  const crossing = clips.filter(
    (clip) =>
      clip.startMs < playhead && playhead < clip.startMs + clip.durationMs,
  ).length;

  return (
    <div className="clip-inspector-body" data-testid="clip-fields">
      <section className="inspector-section">
        <h3>{many ? `${clips.length} clips` : (single?.label ?? "Clip")}</h3>
        <div className="clip-inspector-pair">
          <TimecodeField
            fps={fps}
            label="Start"
            ms={start}
            onCommit={applyStart}
          />
          <TimecodeField
            fps={fps}
            label="Duration"
            ms={duration}
            onCommit={applyDuration}
          />
        </div>
        {start !== null && duration !== null && (
          <Row label="End" value={formatTimecode(start + duration, fps)} />
        )}
        {single && single.kind !== "text" && single.assetId && (
          <>
            <Row label="In" value={formatTimecode(single.inPointMs, fps)} />
            <Row label="Out" value={formatTimecode(single.outPointMs, fps)} />
          </>
        )}
      </section>

      <section className="inspector-section">
        <h3>Speed</h3>
        <div className="clip-inspector-speed">
          {SPEED_PRESETS.map((preset) => (
            <button
              aria-label={`${preset}×`}
              aria-pressed={speed === preset}
              disabled={speedLocked}
              key={preset}
              onClick={() => applySpeed(preset)}
              type="button"
            >
              {preset}×
            </button>
          ))}
        </div>
        <NumberField
          label="Speed ×"
          max={MAX_CLIP_SPEED}
          min={MIN_CLIP_SPEED}
          onCommit={applySpeed}
          value={speed}
        />
        {speedLocked && (
          <p className="inspector-note">
            A still runs its own length, so it has no pace to change.
          </p>
        )}
      </section>

      <section className="inspector-section">
        <h3>Sound</h3>
        <div className="clip-inspector-slider">
          <input
            aria-label="Volume"
            max={MAX_CLIP_VOLUME}
            min={0}
            onChange={(event) => setHeldVolume(Number(event.target.value))}
            onBlur={() => {
              if (heldVolume !== null && heldVolume !== volume)
                commit(
                  clips.map((clip) => ({
                    clipId: clip.id,
                    patch: { volume: heldVolume },
                  })),
                );
              setHeldVolume(null);
            }}
            onPointerUp={() => {
              if (heldVolume !== null && heldVolume !== volume)
                commit(
                  clips.map((clip) => ({
                    clipId: clip.id,
                    patch: { volume: heldVolume },
                  })),
                );
              setHeldVolume(null);
            }}
            step={0.05}
            type="range"
            value={volumeShown}
          />
          <span>{volumeShown.toFixed(2)}</span>
        </div>
        <div className="clip-inspector-pair">
          <NumberField
            label="Fade in ms"
            max={longest}
            min={0}
            onCommit={(value) => applyFade("in", value)}
            value={fadeIn}
          />
          <NumberField
            label="Fade out ms"
            max={longest}
            min={0}
            onCommit={(value) => applyFade("out", value)}
            value={fadeOut}
          />
        </div>
        <button
          aria-label="Mute"
          aria-pressed={muted === true}
          onClick={() =>
            commit(
              clips.map((clip) => ({
                clipId: clip.id,
                patch: { muted: muted !== true },
              })),
            )
          }
          type="button"
        >
          Mute
        </button>
      </section>

      {opacityClips.length > 0 && (
        <section className="inspector-section">
          <h3>Opacity</h3>
          <div className="clip-inspector-slider">
            <input
              aria-label="Opacity"
              max={1}
              min={0}
              onChange={(event) => setHeldOpacity(Number(event.target.value))}
              onBlur={() => {
                if (heldOpacity !== null && heldOpacity !== opacity)
                  applyOpacity(heldOpacity);
                setHeldOpacity(null);
              }}
              onPointerUp={() => {
                if (heldOpacity !== null && heldOpacity !== opacity)
                  applyOpacity(heldOpacity);
                setHeldOpacity(null);
              }}
              step={0.01}
              type="range"
              value={opacityShown}
            />
            <span>{opacityShown.toFixed(2)}</span>
          </div>
        </section>
      )}

      {single && (
        <section className="inspector-section">
          <h3>Name</h3>
          <label className="clip-inspector-field">
            <span>Label</span>
            <input
              defaultValue={single.label}
              key={single.id}
              maxLength={CLIP_LABEL_MAX}
              onBlur={(event) => {
                const next = labelText(event.target.value);
                if (next !== null && next !== single.label)
                  commit([{ clipId: single.id, patch: { label: next } }]);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        </section>
      )}

      <section className="inspector-section">
        <h3>Actions</h3>
        <div className="clip-inspector-actions">
          <button
            disabled={crossing === 0}
            onClick={() => splitSelectionAtPlayhead()}
            type="button"
          >
            <ScissorsIcon size={14} /> Split at playhead
          </button>
          <button onClick={() => duplicateSelection()} type="button">
            <DuplicateIcon size={14} /> Duplicate
          </button>
          {clips.some((clip) => clip.kind === "video") && (
            <button onClick={() => detachAudio()} type="button">
              Detach audio
            </button>
          )}
          <button
            className="danger"
            onClick={() => deleteSelection()}
            type="button"
          >
            <TrashIcon size={14} /> Delete
          </button>
        </div>
      </section>
    </div>
  );
}
