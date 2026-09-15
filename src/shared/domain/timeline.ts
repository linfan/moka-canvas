import {
  CLIP_FILTER_PRESETS,
  CLIP_LABEL_MAX,
  MAX_CLIP_SPEED,
  MAX_CLIP_VOLUME,
  MAX_TIMELINE_TEXT_CONTENT,
  MAX_TRANSITION_MS,
  MIN_CLIP_DURATION_MS,
  MIN_CLIP_SPEED,
  MIN_TRANSITION_MS,
  TRANSITION_KINDS,
} from "./constants";
import { CommandError } from "./commands";
import type {
  ClipPatch,
  MokaFile,
  TimelineClip,
  TimelineDocument,
  TimelineTransition,
  TimelineTrack,
  TrackId,
  ValidationIssue,
} from "./types";

// ---------------------------------------------------------------------------
// The cutting room: what a timeline may hold, and where a seam sits
// ---------------------------------------------------------------------------

export function checkHexColor(value: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value))
    throw new CommandError("VALIDATION_FAILED", "Colour is not #rrggbb");
}

/** Whether a track can hold clips of this kind, which is whether they match. */
export function trackAccepts(
  track: TimelineTrack,
  kind: TimelineClip["kind"],
): boolean {
  return track.kind === kind;
}

interface ClipInterval {
  startMs: number;
  endMs: number;
}

function clipInterval(clip: TimelineClip): ClipInterval {
  return { startMs: clip.startMs, endMs: clip.startMs + clip.durationMs };
}

/**
 * Whether two intervals overlap, counting the boundary as clear: two clips
 * that touch end-to-start hold different places, which a seam may want.
 */
function intervalsOverlap(a: ClipInterval, b: ClipInterval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * The clips of a track in timeline order, which is the order seams are read
 * in: a clip's neighbour is the next clip to start after it on the same track.
 */
export function trackClipsInOrder(
  timeline: TimelineDocument,
  trackId: TrackId,
): TimelineClip[] {
  return timeline.clips
    .filter((clip) => clip.trackId === trackId)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
}

/** The clip behind the given one on its track, which is the seam's follower. */
export function followerOf(
  timeline: TimelineDocument,
  leader: TimelineClip,
): TimelineClip | undefined {
  const ordered = trackClipsInOrder(timeline, leader.trackId);
  const at = ordered.findIndex((clip) => clip.id === leader.id);
  return ordered[at + 1];
}

function findAsset(moka: MokaFile, assetId: string) {
  for (const list of Object.values(moka.resources)) {
    const found = list.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  throw new CommandError("ASSET_MISSING", "Clip's asset is not in the project");
}

/**
 * Validates one clip as a whole: its shape, its timing identity, its material,
 * and the text a text clip carries. Returns the clip so callers can chain.
 */
export function checkClip(
  moka: MokaFile,
  timeline: TimelineDocument,
  clip: TimelineClip,
): TimelineClip {
  const track = timeline.tracks.find((t) => t.id === clip.trackId);
  if (!track)
    throw new CommandError("TRACK_NOT_FOUND", "Clip's track not found");
  if (!trackAccepts(track, clip.kind))
    throw new CommandError(
      "VALIDATION_FAILED",
      `A ${clip.kind} clip cannot sit on a ${track.kind} track`,
    );
  if (!Number.isInteger(clip.startMs) || clip.startMs < 0)
    throw new CommandError(
      "VALIDATION_FAILED",
      "Clip start is not a whole number of milliseconds",
    );
  if (
    !Number.isInteger(clip.durationMs) ||
    clip.durationMs < MIN_CLIP_DURATION_MS
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      `Clips run at least ${MIN_CLIP_DURATION_MS}ms`,
    );
  if (!Number.isInteger(clip.inPointMs) || clip.inPointMs < 0)
    throw new CommandError("VALIDATION_FAILED", "Clip in point is negative");
  if (!Number.isInteger(clip.outPointMs) || clip.outPointMs <= clip.inPointMs)
    throw new CommandError(
      "VALIDATION_FAILED",
      "Clip out point is at or before its in point",
    );
  if (clip.speed < MIN_CLIP_SPEED || clip.speed > MAX_CLIP_SPEED)
    throw new CommandError(
      "VALIDATION_FAILED",
      `Clip speed is outside ${MIN_CLIP_SPEED}–${MAX_CLIP_SPEED}`,
    );
  // The timing identity: duration on the timeline is the material window
  // over speed, so a clip that breaks it would play back the wrong material.
  if (
    Math.round(clip.durationMs * clip.speed) !==
    clip.outPointMs - clip.inPointMs
  ) {
    throw new CommandError(
      "VALIDATION_FAILED",
      "Clip duration does not match its in/out window over its speed",
    );
  }
  if (clip.volume < 0 || clip.volume > MAX_CLIP_VOLUME)
    throw new CommandError("VALIDATION_FAILED", "Clip volume is outside 0–2");
  if (clip.opacity < 0 || clip.opacity > 1)
    throw new CommandError("VALIDATION_FAILED", "Clip opacity is outside 0–1");
  if (
    !Number.isInteger(clip.fadeInMs) ||
    clip.fadeInMs < 0 ||
    !Number.isInteger(clip.fadeOutMs) ||
    clip.fadeOutMs < 0 ||
    clip.fadeInMs + clip.fadeOutMs > clip.durationMs
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      "Clip fades are negative or longer than the clip",
    );
  if (clip.label.length === 0 || clip.label.length > CLIP_LABEL_MAX)
    throw new CommandError(
      "VALIDATION_FAILED",
      "Clip label is empty or too long",
    );
  if (clip.filter !== undefined && !CLIP_FILTER_PRESETS.includes(clip.filter))
    throw new CommandError(
      "VALIDATION_FAILED",
      "Clip filter is not one of the presets",
    );
  if (clip.kind === "text") {
    if (!clip.text) {
      // A text clip without its text is read as one that always had it: older
      // documents (none yet) would not, but a caller making one must.
      throw new CommandError(
        "VALIDATION_FAILED",
        "A text clip carries no text",
      );
    }
    if (clip.text.content.length > MAX_TIMELINE_TEXT_CONTENT)
      throw new CommandError(
        "VALIDATION_FAILED",
        "Text clip content is too long",
      );
    if (clip.assetId !== undefined)
      throw new CommandError("VALIDATION_FAILED", "A text clip names no asset");
    // A text clip's material clock is its own duration, nothing else.
    if (clip.inPointMs !== 0 || clip.outPointMs !== clip.durationMs)
      throw new CommandError(
        "VALIDATION_FAILED",
        "A text clip's window is its own duration",
      );
    // The outline is what keeps white words readable over a bright picture,
    // so its width is a whole count of pixels and its colour a real one. A
    // zero width is the honest way to say "no outline" rather than leaving
    // the colour unread.
    if (
      !Number.isInteger(clip.text.style.strokeWidth) ||
      clip.text.style.strokeWidth < 0
    )
      throw new CommandError(
        "VALIDATION_FAILED",
        "Text outline width is not a whole count of pixels",
      );
    checkHexColor(clip.text.style.strokeColor);
  } else {
    if (!clip.assetId)
      throw new CommandError(
        "VALIDATION_FAILED",
        "A material clip names no asset",
      );
    const asset = findAsset(moka, clip.assetId);
    if (asset.mime?.startsWith("image/")) {
      // An image's material clock is its duration, like a text clip's.
      if (clip.inPointMs !== 0 || clip.outPointMs !== clip.durationMs)
        throw new CommandError(
          "VALIDATION_FAILED",
          "An image clip's window is its own duration",
        );
    }
    if (clip.text !== undefined)
      throw new CommandError(
        "VALIDATION_FAILED",
        "A material clip carries no text",
      );
  }
  return clip;
}

/**
 * Whether two clips hold the one overlap a track may carry: a transition
 * after the leader whose window is exactly how far the follower is pulled
 * back into it. The pair is given in track order, so adjacency has already
 * been decided by the caller.
 */
function isSeamOverlap(
  leader: TimelineClip,
  follower: TimelineClip,
  transitions: TimelineTransition[],
): boolean {
  const leaderEnd = leader.startMs + leader.durationMs;
  const followerEnd = follower.startMs + follower.durationMs;
  return transitions.some((transition) => {
    if (transition.afterClipId === leader.id)
      return follower.startMs === leaderEnd - transition.durationMs;
    if (transition.afterClipId === follower.id)
      return leader.startMs === followerEnd - transition.durationMs;
    return false;
  });
}

function describeOverlap(a: TimelineClip, b: TimelineClip): string {
  return `Clips ${a.id} and ${b.id} hold the same place on one track (${a.startMs}–${a.startMs + a.durationMs}ms and ${b.startMs}–${b.startMs + b.durationMs}ms)`;
}

/**
 * The first overlap among a set of clips that no seam allows, or undefined
 * when the set holds its places cleanly.
 *
 * A seam overlap is the only one the document allows, and it must be a pair
 * adjacent in track order: a third clip pressed into a transition's window
 * is not part of any promise the document made and is refused like any other
 * overlap. Checking neighbouring pairs in start order is enough — an
 * interval that overlaps a non-neighbour always overlaps something between.
 */
function firstOverlap(
  clips: TimelineClip[],
  transitions: TimelineTransition[],
): [TimelineClip, TimelineClip] | undefined {
  const byTrack = new Map<TrackId, TimelineClip[]>();
  for (const clip of clips) {
    const list = byTrack.get(clip.trackId) ?? [];
    list.push(clip);
    byTrack.set(clip.trackId, list);
  }
  for (const list of byTrack.values()) {
    const ordered = [...list].sort(
      (a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1),
    );
    for (let i = 0; i + 1 < ordered.length; i += 1) {
      const a = ordered[i];
      const b = ordered[i + 1];
      if (!intervalsOverlap(clipInterval(a), clipInterval(b))) continue;
      if (isSeamOverlap(a, b, transitions)) continue;
      return [a, b];
    }
  }
  return undefined;
}

/**
 * Checks a set of clips against the places already held on their tracks and
 * against each other. Only a transition's own overlap is allowed — the
 * follower pulled back into its leader by exactly the window — and that
 * exemption is read from the transitions the timeline holds plus the ones
 * the command is bringing in.
 */
export function checkNoOverlap(
  timeline: TimelineDocument,
  clips: TimelineClip[],
  {
    excludingIds = [],
    seams = [],
  }: { excludingIds?: string[]; seams?: TimelineTransition[] } = {},
): void {
  const excluded = new Set(excludingIds);
  const world = [
    ...timeline.clips.filter((clip) => !excluded.has(clip.id)),
    ...clips,
  ];
  const overlap = firstOverlap(world, [...timeline.transitions, ...seams]);
  if (overlap)
    throw new CommandError("CLIP_OVERLAP", describeOverlap(...overlap));
}

interface SeamFailure {
  code: string;
  message: string;
}

/** What a transition record says about itself: its kind and its window. */
function transitionFacts(
  transition: TimelineTransition,
): SeamFailure | undefined {
  if (transition.kind === "none" || !TRANSITION_KINDS.includes(transition.kind))
    return {
      code: "VALIDATION_FAILED",
      message: "Transition kind is not one of the eight",
    };
  if (
    !Number.isInteger(transition.durationMs) ||
    transition.durationMs < MIN_TRANSITION_MS ||
    transition.durationMs > MAX_TRANSITION_MS
  )
    return {
      code: "VALIDATION_FAILED",
      message: `Transition windows run ${MIN_TRANSITION_MS}–${MAX_TRANSITION_MS}ms`,
    };
  return undefined;
}

/**
 * The first thing wrong with the two clips a transition joins, as a code and
 * words, or undefined when they make the seam.
 *
 * `geometry` is the reading of the overlap being asked about: a transition
 * about to land needs the clips butted and pulls the follower back itself,
 * while one already stored must hold the pull-back the record says (R1).
 */
function seamShape(
  timeline: TimelineDocument,
  transition: TimelineTransition,
  geometry: "butted" | "pulled-back",
): SeamFailure | undefined {
  const after = timeline.clips.find(
    (clip) => clip.id === transition.afterClipId,
  );
  if (!after)
    return { code: "CLIP_NOT_FOUND", message: "Transition's clip not found" };
  const follower = followerOf(timeline, after);
  if (!follower)
    return {
      code: "VALIDATION_FAILED",
      message: "A transition needs a clip behind the one it follows",
    };
  const afterEnd = after.startMs + after.durationMs;
  const wantedStart = afterEnd - transition.durationMs;
  if (
    geometry === "butted"
      ? follower.startMs !== afterEnd
      : follower.startMs !== wantedStart
  )
    return {
      code: "VALIDATION_FAILED",
      message:
        geometry === "butted"
          ? "A transition lands on a butted seam; the clip behind is not against the one it follows"
          : "The clip behind is not pulled back by the transition's window",
    };
  if (transition.durationMs > Math.min(after.durationMs, follower.durationMs))
    return {
      code: "VALIDATION_FAILED",
      message: "A transition cannot outlast the shorter clip it joins",
    };
  return undefined;
}

function seamFailure(
  timeline: TimelineDocument,
  transition: TimelineTransition,
  geometry: "butted" | "pulled-back",
): SeamFailure | undefined {
  return (
    transitionFacts(transition) ?? seamShape(timeline, transition, geometry)
  );
}

/**
 * Checks a transition about to make a seam (R3): the clips must be butted,
 * the command itself pulls the follower back, and the seam must be free. A
 * seam that already carries a transition is named as such before the
 * geometry is read — the record is what stands in the way, not the pull.
 */
export function checkTransitionLanding(
  timeline: TimelineDocument,
  transition: TimelineTransition,
): void {
  const facts = transitionFacts(transition);
  if (facts) throw new CommandError(facts.code, facts.message);
  if (
    timeline.transitions.some(
      (existing) => existing.afterClipId === transition.afterClipId,
    )
  )
    throw new CommandError(
      "CONFLICT",
      "That seam already carries a transition",
    );
  const shape = seamShape(timeline, transition, "butted");
  if (shape) throw new CommandError(shape.code, shape.message);
}

/**
 * Checks a transition restored together with its clips (R6): the seam must
 * already hold the pull-back its window states — nothing in this path moves
 * a clip — and the record itself must be sound.
 */
export function checkTransitionRestoration(
  timeline: TimelineDocument,
  transition: TimelineTransition,
): void {
  const failure = seamFailure(timeline, transition, "pulled-back");
  if (failure) throw new CommandError(failure.code, failure.message);
}

/**
 * Checks a stored transition still holds its seam (R1, R5): the clips must
 * be there, still neighbours, still overlapped by exactly the window. Any
 * way it fails is the seam's breaking, which is what a caller repairing
 * geometry is told.
 */
export function checkExistingTransition(
  timeline: TimelineDocument,
  transition: TimelineTransition,
): void {
  const failure = seamFailure(timeline, transition, "pulled-back");
  if (failure)
    throw new CommandError(
      "TRANSITION_SEAM",
      `A stored transition no longer holds its seam: ${failure.message}`,
    );
}

/**
 * Re-checks a whole timeline as it would be: every clip against its own
 * rules, every transition against the seam it claims, and every pair of
 * clips against the one overlap the seams allow (R5, R7). Commands that
 * touch clips or transitions end on this, so a state the document should
 * never be in is refused before it is written rather than found by a reader.
 *
 * A broken seam is reported before the overlap it leaves behind, because the
 * overlap is a consequence: a caller told TRANSITION_SEAM knows which edit
 * went too far, while CLIP_OVERLAP would only say that two clips now share a
 * place.
 */
export function checkTimeline(
  moka: MokaFile,
  timeline: TimelineDocument,
): void {
  for (const clip of timeline.clips) checkClip(moka, timeline, clip);
  for (const transition of timeline.transitions)
    checkExistingTransition(timeline, transition);
  const overlap = firstOverlap(timeline.clips, timeline.transitions);
  if (overlap)
    throw new CommandError("CLIP_OVERLAP", describeOverlap(...overlap));
}

/**
 * The transitions on the seams of the given clips, which is what removing
 * those clips takes with them. A seam belongs to both of its clips: the clip
 * the transition follows, and the clip pulled back behind it — take away
 * either one and the seam is gone, and a transition left on a seam that is
 * no longer there would point at a clip that cannot be found.
 */
export function transitionsOfSeams(
  timeline: TimelineDocument,
  clipIds: string[],
): TimelineTransition[] {
  const removing = new Set(clipIds);
  return timeline.transitions.filter((transition) => {
    if (removing.has(transition.afterClipId)) return true;
    const after = timeline.clips.find(
      (clip) => clip.id === transition.afterClipId,
    );
    if (!after) return false;
    const follower = followerOf(timeline, after);
    return follower !== undefined && removing.has(follower.id);
  });
}

/**
 * Applies a patch to a clip: the fields it carries move, and a field it
 * carries as null goes. The null case is how an undo clears a field the
 * original patch brought in, since JSON has no way to say "leave it off"
 * about a key that is present.
 */
export function mergeClipPatch(
  clip: TimelineClip,
  patch: ClipPatch,
): TimelineClip {
  const merged: Record<string, unknown> = { ...clip };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as TimelineClip;
}

/**
 * The patch that puts back what a patch moved: every key the patch carried
 * gets the value the clip held, and a key the patch brought in — no old
 * value to restore — gets null, which the merge reads as "this key goes".
 * Without the null an undo would leave the introduced field behind.
 */
export function invertClipPatch(
  clip: TimelineClip,
  patch: ClipPatch,
): ClipPatch {
  const inverse: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const held = (clip as unknown as Record<string, unknown>)[key];
    if (value === null) {
      // Nothing was there to clear; the key is not this patch's to give back.
      if (held !== undefined) inverse[key] = held;
      continue;
    }
    inverse[key] = held === undefined ? null : held;
  }
  return inverse as ClipPatch;
}

/**
 * Everything wrong with one timeline, in a list rather than a throw: a
 * document validator reports every fault at once, so this is the collecting
 * twin of `checkTimeline` and shares its checks with it.
 */
export function validateTimeline(
  timeline: TimelineDocument,
  moka: MokaFile,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const duplicate = (
    id: string,
    message: string,
    ref: Pick<ValidationIssue, "trackId" | "clipId" | "transitionId">,
  ) => {
    if (seen.has(id))
      issues.push({
        code: "VALIDATION_FAILED",
        message,
        timelineId: timeline.id,
        ...ref,
      });
    seen.add(id);
  };
  for (const track of timeline.tracks)
    duplicate(`track:${track.id}`, `Duplicate track id ${track.id}`, {
      trackId: track.id,
    });
  for (const clip of timeline.clips)
    duplicate(`clip:${clip.id}`, `Duplicate clip id ${clip.id}`, {
      clipId: clip.id,
    });
  for (const transition of timeline.transitions)
    duplicate(
      `transition:${transition.id}`,
      `Duplicate transition id ${transition.id}`,
      { transitionId: transition.id },
    );
  for (const clip of timeline.clips) {
    try {
      checkClip(moka, timeline, clip);
    } catch (error) {
      const failure = error as CommandError;
      issues.push({
        code: failure.code,
        message: failure.message,
        timelineId: timeline.id,
        trackId: clip.trackId,
        clipId: clip.id,
      });
    }
  }
  for (const transition of timeline.transitions) {
    const failure = seamFailure(timeline, transition, "pulled-back");
    if (failure)
      issues.push({
        code: "TRANSITION_SEAM",
        message: `A stored transition no longer holds its seam: ${failure.message}`,
        timelineId: timeline.id,
        transitionId: transition.id,
      });
  }
  const overlap = firstOverlap(timeline.clips, timeline.transitions);
  if (overlap)
    issues.push({
      code: "CLIP_OVERLAP",
      message: describeOverlap(...overlap),
      timelineId: timeline.id,
      clipId: overlap[0].id,
    });
  return issues;
}
