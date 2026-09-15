import type {
  Point,
  Rect,
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
  TimelineTransition,
  TrackId,
  TrackKind,
} from "../../../shared/domain";

/**
 * The timeline's arithmetic, and nothing but arithmetic.
 *
 * Every function here is a pure reading of the document, the view, and the
 * sizes the room hands in: the canvas draws from it, the toolbar zooms with
 * it, and the packages that add dragging and trimming hit-test through it
 * rather than reasoning about pixels of their own. The row order is the
 * document's track list reversed — the last track is the top of the stack and
 * therefore the top row — and rows are measured from the ruler's bottom edge.
 */

export const MIN_PX_PER_SEC = 4;
export const MAX_PX_PER_SEC = 960;
export const DEFAULT_PX_PER_SEC = 60;
export const RULER_H = 28;
export const HEADER_W = 150;
export const TRACK_HEIGHT: Record<TrackKind, number> = {
  video: 64,
  audio: 56,
  text: 36,
};
export const MIN_CONTENT_MS = 30_000;
export const TAIL_MS = 4_000;
/** The badge a seam gets, square, centred on the seam. */
export const TRANSITION_BADGE_PX = 18;
/** How near a block's edge a pointer must be to be trimming rather than moving it. */
export const CLIP_EDGE_PX = 6;
/** How near a butted seam a pointer must be to be over its `+`. */
export const SEAM_HIT_PX = 6;
/** A major tick this far apart keeps its label off its neighbour's; a minor one reads at 48. */
export const MAJOR_TICK_MIN_PX = 72;
export const MINOR_TICK_MIN_PX = 48;

/** Where the timeline is scrolled and how tightly it is drawn. */
export interface TimelineView {
  pxPerSec: number;
  scrollLeftPx: number;
}

/** One row of the drawn timeline, in display order. */
export interface TrackRow {
  track: TimelineTrack;
  /** The top edge, from the ruler's bottom; content space. */
  top: number;
  height: number;
}

/** What a point on the canvas lands on, topmost first. */
export type TimelineHit =
  | { kind: "clip"; clip: TimelineClip }
  | { kind: "transition"; transition: TimelineTransition }
  /** A butted seam with nothing on it, where a transition may be laid down. */
  | { kind: "seam"; leader: TimelineClip; follower: TimelineClip }
  | { kind: "ruler" }
  | { kind: "empty"; trackId: TrackId | null };

/** Which of a block's two edges a pointer is over, when it is over either. */
export type ClipEdge = "start" | "end";

/** How long the content runs: the last tail, the playhead, or the floor, plus room past the end. */
export function contentMs(
  timeline: TimelineDocument,
  playheadMs: number,
): number {
  let lastEnd = 0;
  for (const clip of timeline.clips) {
    lastEnd = Math.max(lastEnd, clip.startMs + clip.durationMs);
  }
  return Math.max(lastEnd, playheadMs, MIN_CONTENT_MS) + TAIL_MS;
}

/** How wide the content is drawn at a scale. */
export function contentWidth(
  timeline: TimelineDocument,
  playheadMs: number,
  pxPerSec: number,
): number {
  return (contentMs(timeline, playheadMs) / 1_000) * pxPerSec;
}

/**
 * Where the cut ends: the last tail on a row that draws, or the head.
 *
 * The end 07's transport stops at and its keys jump to, and not the drawn
 * content's length — a cut three seconds long does not end where its scroller
 * does. A hidden row is a row that is not shown, so its clips are not where
 * the cut ends on screen.
 */
export function cutEndMs(timeline: TimelineDocument): number {
  return timeline.clips.reduce((end, clip) => {
    const track = timeline.tracks.find((row) => row.id === clip.trackId);
    if (!track || track.hidden) return end;
    return Math.max(end, clip.startMs + clip.durationMs);
  }, 0);
}

/** How tall the rows run, ruler included. */
export function contentHeight(timeline: TimelineDocument): number {
  return trackRows(timeline).reduce(
    (bottom, row) => Math.max(bottom, row.top + row.height),
    RULER_H,
  );
}

/** A view's scale kept inside the range the room cuts at. */
export function clampPxPerSec(pxPerSec: number): number {
  if (!Number.isFinite(pxPerSec)) return DEFAULT_PX_PER_SEC;
  const clamped = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, pxPerSec));
  // A hundredth of a pixel per second is finer than the slider asks for and
  // keeps the data attributes free of float tails.
  return Math.round(clamped * 100) / 100;
}

/** The x a moment draws at, in canvas pixels, for the view's scrolling. */
export function xAt(ms: number, view: TimelineView): number {
  return (ms / 1_000) * view.pxPerSec - view.scrollLeftPx;
}

/** The moment an x reads, the inverse of `xAt`. */
export function msAt(x: number, view: TimelineView): number {
  return ((x + view.scrollLeftPx) / view.pxPerSec) * 1_000;
}

/** The rows as they draw: last track first, tops accumulating down the ruler's hem. */
export function trackRows(timeline: TimelineDocument): TrackRow[] {
  const rows: TrackRow[] = [];
  let top = RULER_H;
  for (let i = timeline.tracks.length - 1; i >= 0; i -= 1) {
    const track = timeline.tracks[i];
    const height = TRACK_HEIGHT[track.kind];
    rows.push({ track, top, height });
    top += height;
  }
  return rows;
}

/**
 * A clip's block, from the document's own geometry.
 *
 * Seam pull-backs are already in `startMs` and `durationMs`, so a follower
 * reads where it is rather than where it would be without its transition.
 * The y is content space, from the ruler's bottom; the canvas moves it by the
 * viewport's vertical scroll on the way out.
 */
export function clipRect(
  clip: TimelineClip,
  rows: TrackRow[],
  view: TimelineView,
): Rect {
  const row = rows.find((candidate) => candidate.track.id === clip.trackId);
  return {
    x: xAt(clip.startMs, view),
    y: row?.top ?? RULER_H,
    width: (clip.durationMs / 1_000) * view.pxPerSec,
    height: row?.height ?? TRACK_HEIGHT[clip.kind],
  };
}

/**
 * Which edge of a block a point is over, or null when it is over the body.
 *
 * The block's own rect is what is measured, so a follower pulled back into a
 * seam has its edges read where it draws. The nearer edge takes a point that
 * is inside both margins — a block narrower than the two of them together
 * still offers both edges rather than refusing to be trimmed at a tight zoom.
 */
export function edgeAt(
  clip: TimelineClip,
  rows: TrackRow[],
  view: TimelineView,
  x: number,
): ClipEdge | null {
  const rect = clipRect(clip, rows, view);
  const toStart = Math.abs(x - rect.x);
  const toEnd = Math.abs(x - (rect.x + rect.width));
  if (toStart > CLIP_EDGE_PX && toEnd > CLIP_EDGE_PX) return null;
  return toStart <= toEnd ? "start" : "end";
}

/** The x a seam's badge centres on: the tail of the clip it follows, or null when that clip is gone. */
export function transitionCenterX(
  transition: TimelineTransition,
  clips: TimelineClip[],
  view: TimelineView,
): number | null {
  const leader = clips.find((clip) => clip.id === transition.afterClipId);
  if (!leader) return null;
  return xAt(leader.startMs + leader.durationMs, view);
}

/** The slice of time the screen shows. */
export function visibleRange(
  view: TimelineView,
  viewportPx: number,
): { startMs: number; endMs: number } {
  return { startMs: msAt(0, view), endMs: msAt(viewportPx, view) };
}

/** The frame-count rungs of the ladder, then the whole-second ones. */
const FRAME_STEPS = [1, 2, 5, 10, 15, 30, 60, 150, 300, 600, 900] as const;
const SECOND_STEPS = [30, 60, 120, 300, 600, 1_800, 3_600] as const;

/**
 * The ticks the ruler wears at this scale: the smallest rung whose width
 * leaves room for its label, and — when it reads at all — the rung below it.
 */
export function tickLadder(
  fps: number,
  pxPerSec: number,
): { majorMs: number; minorMs: number | null } {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const steps: number[] = [];
  for (const frames of FRAME_STEPS) steps.push((frames * 1_000) / rate);
  for (const seconds of SECOND_STEPS) steps.push(seconds * 1_000);
  // Sorted and deduped: off the 30fps clock a 900-frame rung can land past
  // the 30-second one, and a rung entered twice is one rung.
  const ladder = steps
    .sort((a, b) => a - b)
    .filter(
      (step, index, sorted) => index === 0 || step - sorted[index - 1] > 1e-6,
    );
  let major = ladder.findIndex(
    (step) => tickWidthPx(step, pxPerSec) >= MAJOR_TICK_MIN_PX,
  );
  if (major === -1) major = ladder.length - 1;
  const finer = major > 0 ? ladder[major - 1] : null;
  return {
    majorMs: ladder[major],
    minorMs:
      finer !== null && tickWidthPx(finer, pxPerSec) >= MINOR_TICK_MIN_PX
        ? finer
        : null,
  };
}

function tickWidthPx(ms: number, pxPerSec: number): number {
  return (ms / 1_000) * pxPerSec;
}

/**
 * The butted seam under an x on a row, or null.
 *
 * Two clips in track order whose head and tail meet exactly — a seam a
 * transition could land on. A seam that already carries one is pulled back by
 * its window and so is not butted; the badge is what that seam offers.
 */
export function buttedSeamAt(
  onTrack: TimelineClip[],
  view: TimelineView,
  x: number,
): { leader: TimelineClip; follower: TimelineClip } | null {
  const sorted = [...onTrack].sort(
    (a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1),
  );
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const leader = sorted[i];
    const follower = sorted[i + 1];
    if (follower.startMs !== leader.startMs + leader.durationMs) continue;
    if (Math.abs(x - xAt(follower.startMs, view)) <= SEAM_HIT_PX)
      return { leader, follower };
  }
  return null;
}

/**
 * What a point lands on, topmost first.
 *
 * The badge is the smallest target and is asked first; then a butted seam's
 * `+`, which sits over both blocks' edges and therefore beats them; then the
 * last clip to draw over the point, which within a row is the one that starts
 * latest. The point is in canvas pixels across and content space down, which
 * is what the canvas hands in.
 */
export function hitTest(
  timeline: TimelineDocument,
  view: TimelineView,
  point: Point,
): TimelineHit {
  if (point.y < RULER_H) return { kind: "ruler" };
  const rows = trackRows(timeline);
  const row = rows.find(
    (candidate) =>
      point.y >= candidate.top && point.y < candidate.top + candidate.height,
  );
  if (!row) return { kind: "empty", trackId: null };
  const onTrack = timeline.clips.filter(
    (clip) => clip.trackId === row.track.id,
  );
  const half = TRANSITION_BADGE_PX / 2;
  const rowCentre = row.top + row.height / 2;
  for (const transition of timeline.transitions) {
    if (!onTrack.some((clip) => clip.id === transition.afterClipId)) continue;
    const centre = transitionCenterX(transition, timeline.clips, view);
    if (centre === null) continue;
    if (
      Math.abs(point.x - centre) <= half &&
      Math.abs(point.y - rowCentre) <= half
    ) {
      return { kind: "transition", transition };
    }
  }
  const seam = buttedSeamAt(onTrack, view, point.x);
  if (seam) return { kind: "seam", ...seam };
  const ms = msAt(point.x, view);
  const sorted = [...onTrack].sort((a, b) => a.startMs - b.startMs);
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const clip = sorted[i];
    if (ms >= clip.startMs && ms < clip.startMs + clip.durationMs) {
      return { kind: "clip", clip };
    }
  }
  return { kind: "empty", trackId: row.track.id };
}

/** The moment a zoom without a pointer holds still: the playhead, or the screen's middle when it is out of sight. */
export function zoomAnchorMs(
  view: TimelineView,
  viewportPx: number,
  playheadMs: number,
): number {
  const x = xAt(playheadMs, view);
  return x >= 0 && x <= viewportPx ? playheadMs : msAt(viewportPx / 2, view);
}

/** The view after a zoom: the anchor keeps its place and the scroll stays inside the content. */
export function viewAfterZoom(
  pxPerSec: number,
  viewportPx: number,
  anchorMs: number,
  contentMsValue: number,
): TimelineView {
  const anchorX = (anchorMs / 1_000) * pxPerSec;
  const width = (contentMsValue / 1_000) * pxPerSec;
  const max = Math.max(0, width - viewportPx);
  return {
    pxPerSec,
    scrollLeftPx: Math.min(Math.max(0, anchorX - viewportPx / 2), max),
  };
}
