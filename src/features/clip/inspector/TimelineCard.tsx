import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
    execute(t("clip:history.renameTimeline"), [
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
        <h3>{t("clip:timelineCard.title")}</h3>
        <label className="clip-inspector-field">
          <span>{t("clip:timelineCard.name")}</span>
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
          <span>{t("clip:timelineCard.frameRate")}</span>
          <select
            onChange={(event) =>
              setSettings(
                { fps: Number(event.target.value) },
                t("clip:history.changeFrameRate"),
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
        <p className="inspector-note">{t("clip:timelineCard.frameNote")}</p>
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
                  t("clip:history.changeResolution"),
                )
              }
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <label className="clip-inspector-field">
          <span>{t("clip:timelineCard.background")}</span>
          <input
            onChange={(event) => {
              const next = event.target.value.toLowerCase();
              if (next !== settings.background.toLowerCase())
                setSettings(
                  { background: next },
                  t("clip:history.changeBackground"),
                );
            }}
            type="color"
            value={settings.background}
          />
        </label>
      </section>

      <section className="inspector-section">
        <h3>{t("clip:timelineCard.cut")}</h3>
        <div className="inspector-row">
          <span>{t("clip:timelineCard.length")}</span>
          <span>{formatTimecode(cutEndMs(timeline), settings.fps)}</span>
        </div>
        <div className="inspector-row">
          <span>{t("clip:timelineCard.clips")}</span>
          <span>{timeline.clips.length}</span>
        </div>
        <div className="inspector-row">
          <span>{t("clip:timelineCard.tracks")}</span>
          <span>{timeline.tracks.length}</span>
        </div>
      </section>

      <p className="inspector-note">{t("clip:timelineCard.selectHint")}</p>
    </div>
  );
}
