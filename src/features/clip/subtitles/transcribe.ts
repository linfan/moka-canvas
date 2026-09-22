import type {
  AssetId,
  ClipId,
  TimelineClip,
  TimelineDocument,
} from "../../../shared/domain";
import { MIN_CLIP_DURATION_MS } from "../../../shared/domain";
import { frameAligned } from "../timeline/timecode";
import type { SrtCue } from "./srt";

/**
 * Putting a transcript on a timeline.
 *
 * What a recognizer answers with is timed against the recording it was given;
 * what the timeline holds is timed against itself. This is the one place the
 * two are put in terms of each other, and every rule it keeps — where the
 * clip's window begins, what a speed other than the material's own does to a
 * moment, which cues fall outside the window, how two cues that touch are told
 * apart — is stated here rather than at the call site.
 *
 * Pure: no store, no document, no provider.
 */

/** One clip's window of an asset. */
export interface ClipWindow {
  startMs: number;
  durationMs: number;
}

/**
 * The window of material a clip reads.
 *
 * A clip is sent as its own window rather than as the whole file, so this is
 * what recognition is asked about. `durationMs * speed === outPointMs -
 * inPointMs` holds for every clip a document accepts, so either side names the
 * same window; the out point is used because it is what the clip was built
 * from.
 */
export function windowOfClip(clip: TimelineClip): ClipWindow {
  return {
    startMs: clip.inPointMs,
    durationMs: Math.max(0, clip.outPointMs - clip.inPointMs),
  };
}

/**
 * A clip that holds sound, and therefore names the file it reads.
 *
 * A sound does, and so does a shot — its own track carries the audio. A
 * picture and a text clip hold nothing to listen to, and a clip built from a
 * factory that went wrong names nothing at all; neither is something a reading
 * can be asked of.
 */
export type SpeechClip = TimelineClip & { assetId: AssetId };

export function holdsSpeech(clip: TimelineClip): clip is SpeechClip {
  return (
    (clip.kind === "audio" || clip.kind === "video") &&
    clip.assetId !== undefined
  );
}

/**
 * The clip a transcript would be asked for: what is selected, or what the
 * playhead is standing on.
 *
 * A selection is what the reader has just pointed at and wins outright; with
 * nothing selected the question is what they are looking at, which the topmost
 * track under the playhead answers — the same way the picture is chosen. A cut
 * holding no sound has no answer to give and is passed over.
 *
 * What holds sound is not always a clip's own business: a still picture rides
 * the video track and looks exactly like a shot, so a caller with the asset
 * registry at hand says so through `audible` rather than the kinds deciding
 * alone. A caller with no registry to read leaves it out.
 */
export function sourceClip(
  timeline: TimelineDocument,
  clipIds: readonly ClipId[],
  playheadMs: number,
  audible: (clip: SpeechClip) => boolean = () => true,
): SpeechClip | null {
  const wanted = (clip: TimelineClip): clip is SpeechClip =>
    holdsSpeech(clip) && audible(clip);
  const chosen = timeline.clips.find((clip) => clipIds.includes(clip.id));
  if (chosen && wanted(chosen)) return chosen;
  const depth = new Map(timeline.tracks.map((track, at) => [track.id, at]));
  return (
    timeline.clips
      .filter(wanted)
      .filter(
        (clip) =>
          playheadMs >= clip.startMs &&
          playheadMs < clip.startMs + clip.durationMs,
      )
      .sort(
        (a, b) =>
          (depth.get(a.trackId) ?? 0) - (depth.get(b.trackId) ?? 0) ||
          b.startMs - a.startMs,
      )[0] ?? null
  );
}

/**
 * A transcript's cues, as the moments the timeline holds them at.
 *
 * A recognizer's times are measured from the beginning of the audio it was
 * sent — which is the clip's own window — so a moment lands at the clip's
 * start plus as much of that as the recording took. At a speed other than the
 * material's own, a second of recording is less than a second of timeline,
 * because that is what playing the clip does to it.
 *
 * Cues are then put on the frame clock, and anything outside the window is
 * dealt with rather than left to the track: one that begins past the end is
 * dropped, one that overhangs an end is cut at it. Cues that would overlap are
 * clamped to the one after them — a subtitle track holds one thing at a time,
 * and the recognizer's own timing is what decides where the boundary goes — and
 * a cue left too short to be seen at all is dropped, which the caller counts.
 */
export function timelineCues(
  cues: readonly SrtCue[],
  clip: TimelineClip,
  fps: number,
): SrtCue[] {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const opensAt = clip.startMs;
  const closesAt = clip.startMs + clip.durationMs;
  const mapped: SrtCue[] = [];
  for (const cue of cues) {
    const startMs = frameAligned(opensAt + cue.startMs / speed, fps);
    const endMs = frameAligned(opensAt + cue.endMs / speed, fps);
    // Rounding onto the clock can land half a frame earlier than the clip
    // does, and a cue that begins before the window is the window's own.
    const held = {
      startMs: Math.max(opensAt, startMs),
      endMs: Math.min(closesAt, endMs),
      text: cue.text,
    };
    if (startMs >= closesAt) continue;
    if (held.endMs - held.startMs < MIN_CLIP_DURATION_MS) continue;
    mapped.push(held);
  }
  mapped.sort((a, b) => a.startMs - b.startMs);
  const kept: SrtCue[] = [];
  for (const cue of mapped) {
    const previous = kept[kept.length - 1];
    if (previous && previous.endMs > cue.startMs) {
      previous.endMs = cue.startMs;
    }
    kept.push(cue);
  }
  // The clamp can leave a cue with nothing left to say, and a moment nobody
  // can see is not a cue.
  return kept.filter((cue) => cue.endMs - cue.startMs >= MIN_CLIP_DURATION_MS);
}
