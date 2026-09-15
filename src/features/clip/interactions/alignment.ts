import type { ClipId, TimelineClip } from "../../../shared/domain";

/**
 * Tidying a set of blocks up against each other.
 *
 * All three modes read the blocks as they stand and answer with the places
 * they should take; nothing here touches a track or a neighbour, so a set
 * that is already tidy answers with no moves at all. What the document then
 * makes of the moves — an overlap refused, a seam torn — is the command
 * layer's to say, in the command layer's words.
 */

/** The three ways a selection is tidied. */
export type AlignMode = "left" | "distribute" | "butted";

/** One block's new place, in the shape a `moveClips` command reads. */
export interface ClipMove {
  clipId: ClipId;
  startMs: number;
}

/** The blocks in the order they read along the cut, left to right. */
function inReadingOrder(clips: readonly TimelineClip[]): TimelineClip[] {
  return [...clips].sort(
    (a, b) =>
      a.startMs - b.startMs ||
      (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * The moves that tidy the given blocks, or none when they are already tidy.
 *
 * `left` puts every head on the earliest one; `distribute` needs three blocks
 * to have gaps to even out and holds the two outer ones where they are;
 * `butted` runs them end to end in the order they already read, leaving no
 * gap and no overlap. Two blocks have no distribution to do, and one block
 * has nothing to tidy against.
 */
export function alignMoves(
  clips: readonly TimelineClip[],
  mode: AlignMode,
): ClipMove[] {
  if (clips.length < 2) return [];
  const ordered = inReadingOrder(clips);

  if (mode === "left") {
    const earliest = ordered[0].startMs;
    return ordered
      .filter((clip) => clip.startMs !== earliest)
      .map((clip) => ({ clipId: clip.id, startMs: earliest }));
  }

  if (mode === "distribute") {
    if (ordered.length < 3) return [];
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const span = last.startMs + last.durationMs - first.startMs;
    const widths = ordered.reduce((sum, clip) => sum + clip.durationMs, 0);
    const gap = (span - widths) / (ordered.length - 1);
    const moves: ClipMove[] = [];
    // The two outer blocks stay; only what sits between them walks, onto the
    // even spacing its own reading of the run gives.
    let cursor = first.startMs;
    for (let index = 1; index < ordered.length - 1; index += 1) {
      cursor += ordered[index - 1].durationMs + gap;
      const startMs = Math.round(cursor);
      if (startMs !== ordered[index].startMs)
        moves.push({ clipId: ordered[index].id, startMs });
    }
    return moves;
  }

  const moves: ClipMove[] = [];
  let cursor = ordered[0].startMs;
  for (let index = 1; index < ordered.length; index += 1) {
    cursor += ordered[index - 1].durationMs;
    const startMs = Math.round(cursor);
    if (startMs !== ordered[index].startMs)
      moves.push({ clipId: ordered[index].id, startMs });
  }
  return moves;
}
