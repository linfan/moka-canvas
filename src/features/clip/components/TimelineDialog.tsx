import { useEffect, useState, type FormEvent } from "react";
import {
  TIMELINE_FPS_CHOICES,
  TIMELINE_NAME_MAX,
  TIMELINE_RESOLUTION_PRESETS,
  createTimeline,
  nextTimelineName,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";

/** The preset a cut starts on: 1080p, the frame most screens are cut for. */
const DEFAULT_PRESET = TIMELINE_RESOLUTION_PRESETS.findIndex(
  (preset) => preset.width === 1920 && preset.height === 1080,
);

/**
 * The question a new timeline is added under: what it is called, and the frame
 * it is cut in.
 *
 * The name is filled in with the one the document would have been given anyway
 * — one more than the count, past any name taken — so a reader who wants
 * nothing but a cut can press the button. The frame is asked now rather than
 * changed later because it is a decision about the whole cut, and a project
 * that changes it afterwards has a timeline whose settings never matched the
 * pieces that were laid on it.
 */
export function TimelineDialog() {
  const moka = useProjectStore((state) => state.moka);
  const [name, setName] = useState(() => (moka ? nextTimelineName(moka) : ""));
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  const [fps, setFps] = useState<number>(30);

  const close = () => useClipStore.getState().setNewTimelineOpen(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const resolution = TIMELINE_RESOLUTION_PRESETS[preset];
    const timeline = createTimeline(trimmed, {
      fps,
      width: resolution.width,
      height: resolution.height,
      background: "#000000",
    });
    // A command the document refuses — the timeline limit, a conflict — toasts
    // its reason and leaves the dialog standing, since the ask is still the
    // reader's and throwing it away would be losing their words for them.
    const done = execute("Add timeline", [{ type: "addTimeline", timeline }]);
    if (!done) return;
    useClipStore.getState().setActiveTimeline(timeline.id);
    close();
  };

  return (
    <div
      aria-label="New timeline"
      aria-modal="true"
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="dialog"
    >
      <form className="dialog" onSubmit={submit}>
        <h2>New timeline</h2>
        <label className="dialog-field">
          <span>Name</span>
          <input
            autoFocus
            maxLength={TIMELINE_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="dialog-field">
          <span>Resolution</span>
          <select
            onChange={(event) => setPreset(Number(event.target.value))}
            value={preset}
          >
            {TIMELINE_RESOLUTION_PRESETS.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="dialog-field">
          <span>Frame rate</span>
          <select
            onChange={(event) => setFps(Number(event.target.value))}
            value={fps}
          >
            {TIMELINE_FPS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {`${choice} fps`}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button onClick={close} type="button">
            Cancel
          </button>
          <button disabled={name.trim().length === 0} type="submit">
            Create timeline
          </button>
        </div>
      </form>
    </div>
  );
}
