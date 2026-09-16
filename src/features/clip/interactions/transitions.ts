import {
  DEFAULT_TRANSITION_MS,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  type ClipId,
  type DocumentCommand,
  type IsoTimestamp,
  type TimelineDocument,
  type TimelineTransition,
  type TrackId,
  type TransitionId,
} from "../../../shared/domain";
import { followerOf } from "../../../shared/domain/timeline";
import type { SeamKind } from "../preview/blend";

/**
 * The editing arithmetic of a seam chain.
 *
 * A seam's transition cannot be taken out on its own: releasing its follower
 * would run into the segment behind it, or tear the seam behind that one out
 * from under it. The honest shape is a whole-chain edit — the suffix from the
 * seam being changed down to the last one comes apart left to right and is
 * laid back in the same order, with the edited record wearing the reader's
 * new kind or window. One command array, one step of history, one undo (01
 * §R4, §5 T14/T15).
 *
 * Everything here is a pure reading of the document: the functions return
 * command arrays and never touch one, so the rules are tested by their shape
 * and order alone and the UI never simulates seam geometry of its own (08 §7).
 */

/**
 * The transitions that sit on the seams of one track, ordered left to right.
 *
 * A transition belongs to the track of the clip it follows; one whose leader
 * is gone is not on any track and is left out.
 */
export function seamsOfTrack(
  timeline: TimelineDocument,
  trackId: TrackId,
): TimelineTransition[] {
  const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
  return timeline.transitions
    .filter((transition) => {
      const leader = byId.get(transition.afterClipId);
      return leader !== undefined && leader.trackId === trackId;
    })
    .sort((a, b) => {
      const left = byId.get(a.afterClipId)!;
      const right = byId.get(b.afterClipId)!;
      return left.startMs - right.startMs || (left.id < right.id ? -1 : 1);
    });
}

/**
 * From the named seam (inclusive) to the end of its track's chain, in the
 * same left-to-right order. An id the timeline does not hold reads as no
 * chain at all.
 */
export function suffixFrom(
  timeline: TimelineDocument,
  transitionId: TransitionId,
): TimelineTransition[] {
  const transition = timeline.transitions.find(
    (each) => each.id === transitionId,
  );
  if (!transition) return [];
  const leader = timeline.clips.find(
    (clip) => clip.id === transition.afterClipId,
  );
  if (!leader) return [];
  const seams = seamsOfTrack(timeline, leader.trackId);
  const at = seams.findIndex((each) => each.id === transitionId);
  return at < 0 ? [] : seams.slice(at);
}

/**
 * A window kept inside what the document allows: the floor and the document's
 * ceiling, and never longer than the shorter of the two clips it joins, since
 * a transition cannot outlast either side.
 */
export function clampSeamMs(
  timeline: TimelineDocument,
  transitionId: TransitionId,
  ms: number,
): number {
  const transition = timeline.transitions.find(
    (each) => each.id === transitionId,
  );
  const leader = transition
    ? timeline.clips.find((clip) => clip.id === transition.afterClipId)
    : undefined;
  const follower = leader ? followerOf(timeline, leader) : undefined;
  const ceiling = Math.max(
    MIN_TRANSITION_MS,
    Math.min(
      MAX_TRANSITION_MS,
      leader?.durationMs ?? MAX_TRANSITION_MS,
      follower?.durationMs ?? MAX_TRANSITION_MS,
    ),
  );
  const wanted = Math.round(Number.isFinite(ms) ? ms : MIN_TRANSITION_MS);
  return Math.min(Math.max(wanted, MIN_TRANSITION_MS), ceiling);
}

/** What the room says when even the smallest window will not fit the seam. */
export const SEAM_TOO_SHORT_MESSAGE = "clip:actions.seamTooShort";

/** What laying the default transition on a butted seam works out to. */
export type SeamAddPlan =
  | {
      ok: true;
      transition: TimelineTransition;
      commands: DocumentCommand[];
    }
  | { ok: false; reason: "no-seam" | "too-short" };

/**
 * The commands that land a transition on an empty seam, or why they cannot.
 *
 * The two clips must be butted exactly — a seam already pulled back by a
 * transition is not butted, so this is also the "that seam is taken" refusal.
 * The window is the default clamped by both clips (the same rule the drag and
 * the slider use); a pair where even the minimum will not fit is refused with
 * words rather than a command that would certainly be rejected. The pull-back
 * itself is the command's own doing, never the caller's (01 §R3): the UI
 * hands in the record and the id, and nothing else.
 */
export function seamAddCommands(
  timeline: TimelineDocument,
  leaderId: ClipId,
  kind: SeamKind,
  id: TransitionId,
  createdAt: IsoTimestamp,
): SeamAddPlan {
  const leader = timeline.clips.find((clip) => clip.id === leaderId);
  const follower = leader ? followerOf(timeline, leader) : undefined;
  if (
    !leader ||
    !follower ||
    follower.startMs !== leader.startMs + leader.durationMs
  )
    return { ok: false, reason: "no-seam" };
  const shortest = Math.min(leader.durationMs, follower.durationMs);
  if (shortest < MIN_TRANSITION_MS) return { ok: false, reason: "too-short" };
  const transition: TimelineTransition = {
    id,
    afterClipId: leaderId,
    kind,
    durationMs: Math.min(DEFAULT_TRANSITION_MS, shortest),
    createdAt,
  };
  return {
    ok: true,
    transition,
    commands: [
      {
        type: "addTransitions",
        timelineId: timeline.id,
        transitions: [transition],
      },
    ],
  };
}

export interface SeamEdit {
  kind?: SeamKind;
  durationMs?: number;
}

/**
 * The commands that give a transition a new kind or window, or null when the
 * edit would change nothing.
 *
 * The whole suffix from this seam comes apart in order and is laid back in
 * the same order, the edited record carrying its new kind or clamped window;
 * every id and `createdAt` is kept, so the selection does not move and the
 * inverse replays the old chain byte for byte. The pull-backs are the
 * commands' own business, so a reshaped window re-lays every seam behind it.
 */
export function seamEditCommands(
  timeline: TimelineDocument,
  transitionId: TransitionId,
  edit: SeamEdit,
): DocumentCommand[] | null {
  const transition = timeline.transitions.find(
    (each) => each.id === transitionId,
  );
  if (!transition) return null;
  const kind = edit.kind ?? transition.kind;
  const durationMs = clampSeamMs(
    timeline,
    transitionId,
    edit.durationMs ?? transition.durationMs,
  );
  if (kind === transition.kind && durationMs === transition.durationMs)
    return null;
  const suffix = suffixFrom(timeline, transitionId);
  if (suffix.length === 0) return null;
  const rebuilt = suffix.map((each) =>
    each.id === transitionId ? { ...each, kind, durationMs } : each,
  );
  return [
    {
      type: "removeTransitions",
      timelineId: timeline.id,
      transitionIds: suffix.map((each) => each.id),
    },
    {
      type: "addTransitions",
      timelineId: timeline.id,
      transitions: rebuilt,
    },
  ];
}

/**
 * The commands that take a transition out.
 *
 * A seam with nothing behind it is one release: the follower comes back
 * against its leader. A seam with a chain behind it releases the whole suffix
 * left to right and lays the seams that stay back in the same order, so each
 * follower ends against the new segment ahead of it. Nothing at all is an
 * empty array, which `execute` reads as nothing to do.
 */
export function seamRemoveCommands(
  timeline: TimelineDocument,
  transitionId: TransitionId,
): DocumentCommand[] {
  const suffix = suffixFrom(timeline, transitionId);
  if (suffix.length === 0) return [];
  if (suffix.length === 1)
    return [
      {
        type: "removeTransitions",
        timelineId: timeline.id,
        transitionIds: [transitionId],
      },
    ];
  const kept = suffix.filter((each) => each.id !== transitionId);
  return [
    {
      type: "removeTransitions",
      timelineId: timeline.id,
      transitionIds: suffix.map((each) => each.id),
    },
    {
      type: "addTransitions",
      timelineId: timeline.id,
      transitions: kept,
    },
  ];
}
