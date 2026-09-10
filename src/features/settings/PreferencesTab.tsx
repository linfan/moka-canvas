import { useEffect, useState } from "react";
import type {
  AudioPreferences,
  GenerationPreferences,
  ImagePreferences,
  PreferencesPatch,
  VideoPreferences,
} from "../../api";
import {
  MAX_AUDIO_SPEED,
  MAX_IMAGES_PER_RUN,
  MAX_VIDEO_SECONDS,
  MIN_AUDIO_SPEED,
} from "../../shared/domain";
import { useProviderStore } from "./providerStore";
import {
  BAR_ENTRIES,
  PICTURE_TOOLS,
  TOOL_LABELS,
  useToolPrefs,
} from "../editor/stores/toolPrefs";

/** A blank number field keeps its last value rather than becoming zero. */
function toNumber(value: string, fallback: number): number {
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** These are plain data, so comparing them is comparing their serialisation. */
function differs(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** The groups are objects, so adopting the stored preferences means copying. */
function clone(preferences: GenerationPreferences): GenerationPreferences {
  return {
    ...preferences,
    image: { ...preferences.image },
    video: { ...preferences.video },
    audio: { ...preferences.audio },
  };
}

/**
 * The generation defaults a node inherits.
 *
 * Only what moved is sent: a group travels whole because half of a
 * size-and-quality pair means nothing, but an untouched group is left alone so
 * that saving here cannot undo a change made somewhere else.
 */
function GenerationDefaults() {
  const view = useProviderStore((state) => state.view);
  const saving = useProviderStore((state) => state.saving);
  const [draft, setDraft] = useState<GenerationPreferences | null>(() =>
    view ? clone(view.preferences) : null,
  );

  useEffect(() => {
    if (view) setDraft(clone(view.preferences));
  }, [view]);

  if (!view || !draft) {
    return <p className="settings-hint">Loading configuration…</p>;
  }

  const stored = view.preferences;
  const patch: PreferencesPatch = {};
  if (draft.systemPrompt !== stored.systemPrompt) {
    patch.systemPrompt = draft.systemPrompt;
  }
  if (draft.reasoningEffort !== stored.reasoningEffort) {
    patch.reasoningEffort = draft.reasoningEffort;
  }
  if (differs(draft.image, stored.image)) patch.image = draft.image;
  if (differs(draft.video, stored.video)) patch.video = draft.video;
  if (differs(draft.audio, stored.audio)) patch.audio = draft.audio;
  const changed = Object.keys(patch).length > 0;

  const edit = (next: Partial<GenerationPreferences>) =>
    setDraft((state) => state && { ...state, ...next });
  const editImage = (next: Partial<ImagePreferences>) =>
    setDraft(
      (state) => state && { ...state, image: { ...state.image, ...next } },
    );
  const editVideo = (next: Partial<VideoPreferences>) =>
    setDraft(
      (state) => state && { ...state, video: { ...state.video, ...next } },
    );
  const editAudio = (next: Partial<AudioPreferences>) =>
    setDraft(
      (state) => state && { ...state, audio: { ...state.audio, ...next } },
    );

  return (
    <div className="settings-section">
      <label className="dialog-field">
        <span>System prompt</span>
        <textarea
          onChange={(event) => edit({ systemPrompt: event.target.value })}
          placeholder="Applies to every text node that does not carry its own"
          rows={3}
          value={draft.systemPrompt}
        />
      </label>

      <label className="dialog-field">
        <span>Reasoning effort</span>
        <input
          onChange={(event) => edit({ reasoningEffort: event.target.value })}
          placeholder="auto"
          value={draft.reasoningEffort}
        />
      </label>

      <section aria-label="Image defaults" className="settings-section">
        <h3 className="settings-heading">Image</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>Size</span>
            <input
              onChange={(event) => editImage({ size: event.target.value })}
              placeholder="1:1"
              value={draft.image.size}
            />
          </label>
          <label className="dialog-field">
            <span>Quality</span>
            <input
              onChange={(event) => editImage({ quality: event.target.value })}
              placeholder="auto"
              value={draft.image.quality}
            />
          </label>
          <label className="dialog-field">
            <span>Background</span>
            <input
              onChange={(event) =>
                editImage({ background: event.target.value })
              }
              placeholder="auto"
              value={draft.image.background}
            />
          </label>
          <label className="dialog-field">
            <span>Images per run</span>
            <input
              max={MAX_IMAGES_PER_RUN}
              min={1}
              onChange={(event) =>
                editImage({ count: toNumber(event.target.value, 1) })
              }
              step={1}
              type="number"
              value={draft.image.count}
            />
          </label>
        </div>
      </section>

      <section aria-label="Video defaults" className="settings-section">
        <h3 className="settings-heading">Video</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>Seconds</span>
            <input
              max={MAX_VIDEO_SECONDS}
              min={1}
              onChange={(event) =>
                editVideo({ seconds: toNumber(event.target.value, 1) })
              }
              step={1}
              type="number"
              value={draft.video.seconds}
            />
          </label>
          <label className="dialog-field">
            <span>Resolution</span>
            <input
              onChange={(event) =>
                editVideo({ resolution: event.target.value })
              }
              placeholder="720"
              value={draft.video.resolution}
            />
          </label>
          <label className="dialog-field">
            <span>Mode</span>
            <input
              onChange={(event) => editVideo({ mode: event.target.value })}
              placeholder="auto"
              value={draft.video.mode}
            />
          </label>
        </div>
        <label className="settings-check">
          <input
            checked={draft.video.generateAudio}
            onChange={(event) =>
              editVideo({ generateAudio: event.target.checked })
            }
            type="checkbox"
          />
          <span>Generate audio</span>
        </label>
        <label className="settings-check">
          <input
            checked={draft.video.watermark}
            onChange={(event) => editVideo({ watermark: event.target.checked })}
            type="checkbox"
          />
          <span>Watermark</span>
        </label>
      </section>

      <section aria-label="Audio defaults" className="settings-section">
        <h3 className="settings-heading">Audio</h3>
        <div className="settings-columns">
          <label className="dialog-field">
            <span>Voice</span>
            <input
              onChange={(event) => editAudio({ voice: event.target.value })}
              placeholder="alloy"
              value={draft.audio.voice}
            />
          </label>
          <label className="dialog-field">
            <span>Format</span>
            <input
              onChange={(event) => editAudio({ format: event.target.value })}
              placeholder="mp3"
              value={draft.audio.format}
            />
          </label>
          <label className="dialog-field">
            <span>Speed</span>
            <input
              max={MAX_AUDIO_SPEED}
              min={MIN_AUDIO_SPEED}
              onChange={(event) =>
                editAudio({ speed: toNumber(event.target.value, 1) })
              }
              step={0.05}
              type="number"
              value={draft.audio.speed}
            />
          </label>
        </div>
        <label className="dialog-field">
          <span>Voice instructions</span>
          <input
            onChange={(event) =>
              editAudio({ instructions: event.target.value })
            }
            placeholder="Spoken as directions to the voice"
            value={draft.audio.instructions}
          />
        </label>
      </section>

      <div className="dialog-actions">
        <button
          className="primary"
          disabled={saving || !changed}
          onClick={() =>
            void useProviderStore.getState().savePreferences(patch)
          }
          type="button"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </div>
  );
}

/**
 * Which picture tools the row over a node offers.
 *
 * Kept on this machine rather than in the document, so what somebody has tidied
 * stays tidied for them and travels in no package. Unticking a tool hides it from
 * the row and nothing else: it is not removed from the project, and whatever it
 * already made stays exactly where it was put.
 */
function NodeToolChoices() {
  const shown = useToolPrefs((state) => state.shown);
  const toggleShown = useToolPrefs((state) => state.toggleShown);
  return (
    <section aria-label="Picture tools" className="settings-section">
      <h3 className="settings-heading">Picture tools on a node</h3>
      <div className="settings-columns">
        {BAR_ENTRIES.map((tool) => (
          <label className="settings-check" key={tool}>
            <input
              checked={shown.includes(tool)}
              onChange={() => toggleShown(tool)}
              type="checkbox"
            />
            <span>{TOOL_LABELS[tool]}</span>
          </label>
        ))}
      </div>
      <p className="settings-hint">
        {PICTURE_TOOLS.map((tool) => TOOL_LABELS[tool]).join(", ")} work on the
        pixels a picture already has, so they cost nothing and give the same
        answer twice. {TOOL_LABELS.repaint} is the one that does not: it marks a
        region and hands it to a model, so it costs what an ask costs.
      </p>
      <p className="settings-hint">
        None of them rewrites the file a node holds: what they make is filed
        beside it and given a node of its own.
      </p>
    </section>
  );
}

export function PreferencesTab() {
  return (
    <div className="settings-section">
      <NodeToolChoices />
      <GenerationDefaults />
    </div>
  );
}
