import type {
  TimelineClip,
  TimelineDocument,
  TimelineTransition,
  TrackId,
  TransitionKind,
} from "../../../shared/domain";
import { followerOf } from "../../../shared/domain/timeline";

/**
 * What two clips do while a seam window is open.
 *
 * A transition's window is the overlap its record pulled into the document
 * (01 §R1): from the follower's start — the leader's tail minus the window —
 * to the leader's tail. Inside it both clips play, and this module says where
 * the moment falls in that window and how the two frames combine. The drawing
 * is one function with one signature, used by the preview, by the inspector's
 * kind tiles, and (in shape) by package 12's export mapping — so a kind is
 * drawn in one place and the export's cross-check has one place to change.
 *
 * The side-drawing closures are the compositor's own "draw one clip": they
 * carry its contain fit, its grade, its opacity and its fades. Because a blend
 * scales a side by the context's own alpha rather than inside the closure,
 * the two multiply naturally: the closure multiplies its factor into
 * `globalAlpha` and this module sets the blend's factor on the way in.
 */

/** The seven real ways two clips can meet; "none" is a seam with no blend. */
export type SeamKind = Exclude<TransitionKind, "none">;

/** A moment inside a seam window, with both clips and how far it has run. */
export interface SeamMoment {
  transition: TimelineTransition;
  kind: SeamKind;
  leader: TimelineClip;
  follower: TimelineClip;
  /** 0 at the window's start, up to but never reaching 1 at its end. */
  progress: number;
}

/**
 * The seam window the moment stands in on a track, or null.
 *
 * The window is half-open — `[follower.startMs, follower.startMs + w)` — so
 * the window's start reads p = 0 (the last frame the leader is alone) and the
 * moment the window ends belongs to the follower alone. A transition whose
 * leader has left its track, or whose kind is the seam-less "none", is not a
 * blend and is passed over.
 */
export function seamAt(
  timeline: TimelineDocument,
  trackId: TrackId,
  atMs: number,
): SeamMoment | null {
  for (const transition of timeline.transitions) {
    if (transition.kind === "none") continue;
    const leader = timeline.clips.find(
      (clip) => clip.id === transition.afterClipId,
    );
    if (!leader || leader.trackId !== trackId) continue;
    const follower = followerOf(timeline, leader);
    if (!follower) continue;
    const startMs = follower.startMs;
    if (atMs < startMs || atMs >= startMs + transition.durationMs) continue;
    return {
      transition,
      kind: transition.kind,
      leader,
      follower,
      progress: (atMs - startMs) / transition.durationMs,
    };
  }
  return null;
}

/** How one side of a blend is drawn, into whatever the context is set to. */
export type DrawSeamSide = (ctx: CanvasRenderingContext2D) => void;

/**
 * The window a wipe has opened at p: the follower enters from the right edge
 * and the boundary walks left, so at p = 1 the whole frame is the follower's.
 *
 * One of the two "shape" single points: package 12 checks this rect against
 * ffmpeg's own `wipeleft` frames, and if the direction is the other way only
 * this function changes (`wiperight` on the export side).
 */
export function wipeRect(p: number, width: number, height: number) {
  return { x: width - p * width, y: 0, width: p * width, height };
}

/**
 * The centred box the follower has grown into at p: the frame's shape kept,
 * growing from the middle outward, full frame at p = 1.
 *
 * The other single point: package 12 checks the growth against ffmpeg's
 * `zoomin`, and only this function changes if the curve or the direction
 * parts ways.
 */
export function zoomRect(p: number, width: number, height: number) {
  const w = p * width;
  const h = p * height;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

/** The frame both slides travel across: the context's own canvas, when it has one. */
function frameSize(ctx: CanvasRenderingContext2D) {
  const canvas = ctx.canvas;
  return { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
}

/**
 * Draws a window's worth of two clips, according to the kind.
 *
 * `progress` is clamped, and the endpoints are exact in what they ask of the
 * sides: at 0 only the leader is drawn, at 1 only the follower — the call
 * that would draw the other side is never made. In between the seven kinds
 * are the spec's own seven, with the two dips laying an opaque plate so the
 * mid-window frame covers whatever is under the track (the exporter's
 * `fadeblack`/`fadewhite` frames agree). Every kind restores the context
 * before it returns: alpha and clipping are the caller's to keep.
 */
export function drawTransition(
  ctx: CanvasRenderingContext2D,
  kind: SeamKind,
  progress: number,
  drawLeader: DrawSeamSide,
  drawFollower: DrawSeamSide,
): void {
  const p = Math.max(0, Math.min(1, progress));
  if (p <= 0) {
    drawLeader(ctx);
    return;
  }
  if (p >= 1) {
    drawFollower(ctx);
    return;
  }
  const { width, height } = frameSize(ctx);
  ctx.save();
  switch (kind) {
    case "crossfade": {
      drawLeader(ctx);
      ctx.globalAlpha = p;
      drawFollower(ctx);
      break;
    }
    case "dipToBlack":
    case "dipToWhite": {
      // The plate first, opaque, so a half-run dip hides the lower tracks;
      // then the side whose half of the dip this moment is in, ramped from
      // nothing at the middle to the whole frame at either end.
      ctx.globalAlpha = 1;
      ctx.fillStyle = kind === "dipToBlack" ? "#000000" : "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = p < 0.5 ? 1 - 2 * p : 2 * p - 1;
      if (p < 0.5) drawLeader(ctx);
      else drawFollower(ctx);
      break;
    }
    case "slideLeft": {
      ctx.translate(-p * width, 0);
      drawLeader(ctx);
      ctx.translate(width, 0);
      drawFollower(ctx);
      break;
    }
    case "slideUp": {
      ctx.translate(0, -p * height);
      drawLeader(ctx);
      ctx.translate(0, height);
      drawFollower(ctx);
      break;
    }
    case "wipe": {
      drawLeader(ctx);
      const rect = wipeRect(p, width, height);
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      drawFollower(ctx);
      break;
    }
    case "zoomIn": {
      drawLeader(ctx);
      const rect = zoomRect(p, width, height);
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.translate(rect.x, rect.y);
      ctx.scale(p, p);
      drawFollower(ctx);
      break;
    }
  }
  ctx.restore();
}

/**
 * The ffmpeg `xfade` name each kind exports as (10 §8), which package 12
 * consumes: availability is probed once per install from `ffmpeg -h
 * filter=xfade`, and `zoomin` — which needs ffmpeg 5.0 or newer — falls back
 * to `fade` with a note when the build does not carry it.
 */
export const XFADE_NAMES: Record<SeamKind, string> = {
  crossfade: "fade",
  dipToBlack: "fadeblack",
  dipToWhite: "fadewhite",
  slideLeft: "slideleft",
  slideUp: "slideup",
  wipe: "wipeleft",
  zoomIn: "zoomin",
};
