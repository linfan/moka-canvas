import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  defaultTextStyle,
  type TextClipData,
  type TimelineClip,
} from "../../../shared/domain";
import { trackClipsInOrder } from "../../../shared/domain/timeline";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { TextFields } from "../inspector/TextFields";
import {
  MAX_SUBTITLE_FILE_BYTES,
  addTextClipAtPlayhead,
  cueSummary,
  importSrt,
} from "../interactions/textActions";
import { useClipStore } from "../stores/clipStore";
import { cueOfClip, serializeSrt } from "../subtitles/srt";
import { TEXT_STYLE_PRESETS, presetById } from "../textStyles";
import { formatTimecode } from "../timeline/timecode";

/**
 * The Text page: the words about to be laid down, and the words already on
 * the cut.
 *
 * The composer is a text clip's shape held as a form — one style, and the
 * words being written with it — and `Add at the playhead` turns it into a
 * clip through the same planning the inspector edits after the fact. Adding
 * costs the words and keeps the style, so a run of subtitles is written
 * without setting the same look again for each line.
 *
 * Below it the subtitle tools: an `.srt` brought in as a whole batch of clips
 * in one step of history, the first text track written back out as an `.srt`,
 * and the cue list — every text clip of that track, in time order — where a
 * click chooses the clip and takes the playhead to its words.
 *
 * The page reads the selection and never writes back to the composer: editing
 * a chosen clip is the inspector's job, and two forms over one clip would
 * take turns overwriting each other.
 */

/** A timeline's name as a file name: a cut is never a path. */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-");
}

function toast(kind: "info" | "success" | "error", message: string): void {
  useAppStore.getState().pushToast(kind, message);
}

export function TextPanel() {
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const clipIds = useClipStore((state) => state.selection.clipIds);
  const timeline =
    (moka?.timelines ?? []).find((each) => each.id === activeTimelineId) ??
    null;
  const [composer, setComposer] = useState<TextClipData>(() => ({
    content: "",
    style: defaultTextStyle(),
  }));
  const [presetId, setPresetId] = useState<string>("basic");
  const fileRef = useRef<HTMLInputElement | null>(null);

  // The subtitle tools read the first text track, which is the one a batch of
  // cues lands on and the one the list writes down.
  const textTrack =
    timeline?.tracks.find((track) => track.kind === "text") ?? null;
  const cues = useMemo(() => {
    if (!timeline || !textTrack) return [];
    return trackClipsInOrder(timeline, textTrack.id).filter(
      (clip) => clip.kind === "text",
    );
  }, [timeline, textTrack]);
  const fps = timeline?.settings.fps ?? 30;

  const applyPreset = (id: string) => {
    setPresetId(id);
    const preset = presetById(id);
    if (!preset) return;
    // A preset fills the whole style and never the words.
    setComposer((held) => ({
      content: held.content,
      style: { ...preset.style },
    }));
  };

  const add = () => {
    const clip = addTextClipAtPlayhead(composer.content, composer.style);
    if (!clip) return;
    // The words are spent, the style stays: the next line is the same look.
    setComposer((held) => ({ content: "", style: held.style }));
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The input lets go of the file at once, so choosing the same one twice
    // is still a change.
    event.target.value = "";
    if (!file || !timeline) return;
    if (file.size > MAX_SUBTITLE_FILE_BYTES) {
      toast("error", "That subtitles file is larger than 2MB.");
      return;
    }
    const text = await file.text();
    importSrt(text, composer.style);
  };

  const exportSrt = () => {
    if (!timeline || cues.length === 0) return;
    const blob = new Blob([serializeSrt(cues.map(cueOfClip))], {
      type: "application/x-subrip",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeFileName(timeline.name)}.srt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // The file is read from the URL after the click returns, so it is let go
    // on the next turn rather than under the download's feet.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  /** A cue row's click: choose the clip it stands for and go to its words. */
  const jump = (clip: TimelineClip) => {
    useClipStore.getState().select({ clipIds: [clip.id], transitionId: null });
    useClipStore.getState().setPlayhead(clip.startMs);
  };

  return (
    <div className="clip-text-page" data-testid="clip-text-panel">
      <label className="clip-text-field">
        <span className="clip-text-label">Preset</span>
        <select
          aria-label="Preset"
          onChange={(event) => applyPreset(event.target.value)}
          value={presetId}
        >
          {TEXT_STYLE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>

      <TextFields
        onChange={(next) => setComposer(next)}
        value={composer}
        words
      />

      <button
        className="clip-text-add"
        disabled={!timeline || composer.content.trim().length === 0}
        onClick={add}
        type="button"
      >
        Add at the playhead
      </button>

      <section className="clip-text-subtitles">
        <div className="clip-text-subtitle-head">
          <h3>Subtitles</h3>
          <div className="clip-text-subtitle-actions">
            <button
              disabled={!timeline}
              onClick={() => fileRef.current?.click()}
              type="button"
            >
              Import .srt
            </button>
            <button
              disabled={cues.length === 0}
              onClick={exportSrt}
              type="button"
            >
              Export .srt
            </button>
          </div>
        </div>
        <input
          accept=".srt,.txt"
          aria-label="Import subtitles"
          className="clip-text-file"
          onChange={(event) => void onFile(event)}
          ref={fileRef}
          type="file"
        />
        {cues.length === 0 ? (
          <p className="clip-text-hint">No text clips yet.</p>
        ) : (
          <div className="clip-subtitle-list">
            {cues.map((clip) => (
              <button
                className={
                  clipIds.includes(clip.id)
                    ? "clip-subtitle-row is-selected"
                    : "clip-subtitle-row"
                }
                data-clip-id={clip.id}
                data-testid="clip-subtitle-row"
                key={clip.id}
                onClick={() => jump(clip)}
                type="button"
              >
                <span className="clip-subtitle-time">
                  {formatTimecode(clip.startMs, fps)}
                </span>
                <span className="clip-subtitle-text">
                  {cueSummary(clip.text?.content ?? "")}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
