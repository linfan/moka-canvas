import { useEffect, useRef, useState } from "react";
import {
  TIMELINE_FPS_CHOICES,
  TIMELINE_NAME_MAX,
  TIMELINE_RESOLUTION_PRESETS,
  type TimelineDocument,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { cutEndMs } from "../timeline/geometry";
import { formatTimecode } from "../timeline/timecode";

/**
 * The cut itself, when nothing on it is chosen.
 *
 * The frame the timeline is cut in and the colour it cuts to: the name, the
 * rate, the resolution, the background. Nothing here touches the pieces that
 * are already laid down — a rate changed part-way through a cut would leave
 * their times where they were, which the one line of advice says — so the
 * reader can see the state of the cut without any of it moving under them.
 */

export interface TimelineCardProps {
  timeline: TimelineDocument;
}

export function TimelineCard({ timeline }: TimelineCardProps) {
  const [name, setName] = useState(timeline.name);
  const nameFocused = useRef(false);
  const settings = timeline.settings;

  useEffect(() => {
    if (!nameFocused.current) setName(timeline.name);
  }, [timeline.name]);

  const rename = () => {
    const trimmed = name.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > TIMELINE_NAME_MAX ||
      trimmed === timeline.name
    ) {
      setName(timeline.name);
      return;
    }
    execute("Rename timeline", [
      { type: "renameTimeline", timelineId: timeline.id, name: trimmed },
    ]);
  };

  const setSettings = (
    patch: Partial<typeof settings>,
    label: string,
  ): void => {
    execute(label, [
      {
        type: "updateTimelineSettings",
        timelineId: timeline.id,
        settings: patch,
      },
    ]);
  };

  return (
    <div className="clip-inspector-body" data-testid="clip-timeline-card">
      <section className="inspector-section">
        <h3>Timeline</h3>
        <label className="clip-inspector-field">
          <span>Name</span>
          <input
            maxLength={TIMELINE_NAME_MAX}
            onBlur={() => {
              nameFocused.current = false;
              rename();
            }}
            onChange={(event) => setName(event.target.value)}
            onFocus={() => {
              nameFocused.current = true;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            value={name}
          />
        </label>
        <label className="clip-inspector-field">
          <span>Frame rate</span>
          <select
            onChange={(event) =>
              setSettings(
                { fps: Number(event.target.value) },
                "Change frame rate",
              )
            }
            value={settings.fps}
          >
            {TIMELINE_FPS_CHOICES.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </label>
        <p className="inspector-note">
          Frame times of existing clips stay as they are
        </p>
        <div className="clip-inspector-presets">
          {TIMELINE_RESOLUTION_PRESETS.map((preset) => (
            <button
              aria-pressed={
                settings.width === preset.width &&
                settings.height === preset.height
              }
              key={preset.label}
              onClick={() =>
                setSettings(
                  { width: preset.width, height: preset.height },
                  "Change resolution",
                )
              }
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label className="clip-inspector-field">
          <span>Background</span>
          <input
            onChange={(event) => {
              const next = event.target.value.toLowerCase();
              if (next !== settings.background.toLowerCase())
                setSettings({ background: next }, "Change background");
            }}
            type="color"
            value={settings.background}
          />
        </label>
      </section>

      <section className="inspector-section">
        <h3>Cut</h3>
        <div className="inspector-row">
          <span>Length</span>
          <span>{formatTimecode(cutEndMs(timeline), settings.fps)}</span>
        </div>
        <div className="inspector-row">
          <span>Clips</span>
          <span>{timeline.clips.length}</span>
        </div>
        <div className="inspector-row">
          <span>Tracks</span>
          <span>{timeline.tracks.length}</span>
        </div>
      </section>

      <p className="inspector-note">Select a clip to edit how it plays.</p>
    </div>
  );
}
