import type {
  AssetId,
  ClipId,
  TimelineClip,
  TimelineDocument,
  TransitionId,
} from "../../../shared/domain";
import {
  RULER_H,
  TRANSITION_BADGE_PX,
  clipRect,
  contentHeight,
  tickLadder,
  trackRows,
  transitionCenterX,
  visibleRange,
  xAt,
  type TimelineView,
  type TrackRow,
} from "./geometry";
import { TIMELINE_PALETTE, type TimelinePalette } from "./palette";
import { formatTickLabel } from "./timecode";

/** The pictures a clip's label leaves room for; 07 grows this into filmstrips and waveforms. */
export interface ThumbProvider {
  get(assetId: AssetId): CanvasImageSource | null;
}

export interface TimelineRenderModel {
  timeline: TimelineDocument;
  view: TimelineView;
  /** The visible screen: what the drawing is culled to, vertical scroll included. */
  viewport: { width: number; height: number; scrollTopPx: number };
  playheadMs: number;
  selection: { clipIds: readonly ClipId[]; transitionId: TransitionId | null };
  thumbs: ThumbProvider | null;
  /** 08's drag ghost; null here and always until then. */
  draft?: null;
  palette?: TimelinePalette;
}

const CLIP_FONT = "12px ui-sans-serif, system-ui, sans-serif";
const BADGE_FONT = "10px ui-sans-serif, system-ui, sans-serif";
const CLIP_RADIUS = 6;

/**
 * A whole screen of timeline: rows, clips, seams, the ruler and the playhead.
 *
 * Called once per frame with no state of its own, so what is drawn is always
 * what the model says. Everything outside the viewport is culled before it is
 * painted — at the tightest zoom the content is wider than any canvas a
 * browser will hand out, and a screenful is all anyone can see anyway.
 */
export function renderTimeline(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
): void {
  const palette = model.palette ?? TIMELINE_PALETTE;
  const { width, height, scrollTopPx } = model.viewport;
  ctx.fillStyle = palette.canvas;
  ctx.fillRect(0, 0, width, height);

  const rulerY = -scrollTopPx;
  // Rows are drawn for whatever tracks the timeline has, clips on them or
  // not: the header beside them reads out those tracks, and an empty row is
  // where the first piece will land. Only a timeline with no tracks at all is
  // a ruler over the background.
  const rows = trackRows(model.timeline);
  if (rows.length > 0) {
    drawRows(ctx, model, rows, palette);
    drawGrid(ctx, model, rows, palette);
    if (model.timeline.clips.length > 0) {
      drawClips(ctx, model, rows, palette);
      drawTransitions(ctx, model, rows, palette);
    }
  }
  drawRuler(ctx, model, palette, rulerY);
  drawPlayhead(ctx, model, palette, rulerY);
}

function drawRows(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  rows.forEach((row, index) => {
    const y = row.top - scrollTopPx;
    if (y > height || y + row.height < 0) return;
    ctx.fillStyle = index % 2 === 0 ? palette.rowA : palette.rowB;
    // A hidden track still shows through, washed out: it is why the picture
    // is missing, not a row that has gone.
    ctx.globalAlpha = row.track.hidden ? 0.45 : 1;
    ctx.fillRect(0, y, width, row.height);
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.rowLine;
    ctx.fillRect(0, y + row.height - 1, width, 1);
    if (row.track.locked) drawLockMark(ctx, 8, y + row.height / 2, palette);
  });
}

function drawLockMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  centreY: number,
  palette: TimelinePalette,
): void {
  ctx.strokeStyle = palette.lock;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(x, centreY - 1, 8, 6.5, 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 4, centreY - 1, 2.6, Math.PI, 0);
  ctx.stroke();
}

/** The major ticks drop a faint line through the rows, tying ruler to content. */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  const ladder = tickLadder(model.timeline.settings.fps, model.view.pxPerSec);
  const { endMs } = visibleRange(model.view, width);
  const top = Math.max(0, rows[0].top - scrollTopPx);
  const bottom = Math.min(height, contentHeight(model.timeline) - scrollTopPx);
  if (bottom <= top) return;
  ctx.fillStyle = palette.grid;
  for (let i = 1; i * ladder.majorMs <= endMs; i += 1) {
    const x = xAt(i * ladder.majorMs, model.view);
    if (x < 0 || x > width) continue;
    ctx.fillRect(x, top, 1, bottom - top);
  }
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  palette: TimelinePalette,
  rulerY: number,
): void {
  const { width } = model.viewport;
  ctx.fillStyle = palette.ruler;
  ctx.fillRect(0, rulerY, width, RULER_H);
  ctx.fillStyle = palette.rulerLine;
  ctx.fillRect(0, rulerY + RULER_H - 1, width, 1);

  const fps = model.timeline.settings.fps;
  const ladder = tickLadder(fps, model.view.pxPerSec);
  const { endMs } = visibleRange(model.view, width);
  const step = ladder.minorMs ?? ladder.majorMs;
  ctx.font = BADGE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (let i = 0; i * step <= endMs; i += 1) {
    const ms = i * step;
    const x = xAt(ms, model.view);
    if (x < 0 || x > width) continue;
    const major = isMultipleOf(ms, ladder.majorMs);
    const tickH = major ? 8 : 4;
    ctx.fillStyle = major ? palette.tick : palette.tickMinor;
    ctx.fillRect(x, rulerY + RULER_H - tickH, 1, tickH);
    ctx.fillStyle = palette.label;
    ctx.fillText(formatTickLabel(ms, fps), x + 4, rulerY + 10);
  }
}

function isMultipleOf(ms: number, step: number): boolean {
  const ratio = ms / step;
  return Math.abs(ratio - Math.round(ratio)) < 1e-6;
}

function drawClips(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  for (const row of rows) {
    const rowY = row.top - scrollTopPx;
    if (rowY > height || rowY + row.height < 0) continue;
    // Sorted by where they start, which is also the order they overlap in:
    // the follower of a seam draws over the tail it was pulled back into.
    const onTrack = model.timeline.clips
      .filter((clip) => clip.trackId === row.track.id)
      .sort((a, b) => a.startMs - b.startMs);
    for (const clip of onTrack) {
      const rect = { ...clipRect(clip, rows, model.view), y: rowY };
      if (rect.x + rect.width < 0 || rect.x > width) continue;
      ctx.save();
      ctx.globalAlpha = row.track.hidden ? 0.45 : 1;
      drawClip(ctx, clip, rect, model, palette);
      ctx.restore();
    }
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  model: TimelineRenderModel,
  palette: TimelinePalette,
): void {
  const selected = model.selection.clipIds.includes(clip.id);
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y + 0.5, rect.width, rect.height - 1, CLIP_RADIUS);
  ctx.fillStyle = palette.clip[clip.kind];
  ctx.fill();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? palette.selection : palette.clipStroke;
  if (selected) {
    ctx.shadowColor = palette.selectionGlow;
    ctx.shadowBlur = 8;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (rect.width < 8) return;
  drawFades(ctx, clip, rect, model, palette);

  const thumb = clip.kind === "text" ? null : thumbOf(clip, model);
  let textLeft = rect.x + 8;
  if (thumb && rect.height >= 26) {
    const thumbH = rect.height - 10;
    const thumbW = (thumbH * 16) / 9;
    const thumbX = rect.x + 5;
    const thumbY = rect.y + 5;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(thumbX, thumbY, thumbW, thumbH, 4);
    ctx.clip();
    ctx.drawImage(thumb, thumbX, thumbY, thumbW, thumbH);
    ctx.restore();
    textLeft = thumbX + thumbW + 6;
  }
  if (clip.kind === "text") {
    drawTextMark(ctx, rect, palette);
    textLeft = rect.x + 24;
  }

  const label = clipName(clip);
  const labelWidth = rect.x + rect.width - 8 - textLeft;
  if (labelWidth < 8) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.font = CLIP_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = palette.ink;
  ctx.fillText(fitLabel(ctx, label, labelWidth), textLeft, rect.y + 6);
  ctx.restore();

  if (clip.speed !== 1) drawSpeedBadge(ctx, clip, rect, palette);
}

function thumbOf(
  clip: TimelineClip,
  model: TimelineRenderModel,
): CanvasImageSource | null {
  if (!clip.assetId || !model.thumbs) return null;
  return model.thumbs.get(clip.assetId);
}

function clipName(clip: TimelineClip): string {
  if (clip.kind === "text" && clip.text) {
    const first = clip.text.content.split("\n")[0].trim();
    if (first.length > 0) return first;
  }
  return clip.label;
}

/** Text over a clip is cut to the room it has; a word that does not fit is shown by its beginning. */
function fitLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** The two fades are read-only ramps in a clip's corners; 08 and 09 move the lengths. */
function drawFades(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  model: TimelineRenderModel,
  palette: TimelinePalette,
): void {
  const pxPerMs = model.view.pxPerSec / 1_000;
  if (clip.fadeInMs > 0) {
    drawFade(ctx, rect, clip.fadeInMs * pxPerMs, "in", palette);
  }
  if (clip.fadeOutMs > 0) {
    drawFade(ctx, rect, clip.fadeOutMs * pxPerMs, "out", palette);
  }
}

function drawFade(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  width: number,
  side: "in" | "out",
  palette: TimelinePalette,
): void {
  const ramp = Math.min(width, rect.width);
  if (ramp <= 0) return;
  ctx.fillStyle = palette.fade;
  ctx.beginPath();
  if (side === "in") {
    ctx.moveTo(rect.x, rect.y);
    ctx.lineTo(rect.x + ramp, rect.y);
    ctx.lineTo(rect.x, rect.y + rect.height);
  } else {
    ctx.moveTo(rect.x + rect.width, rect.y);
    ctx.lineTo(rect.x + rect.width - ramp, rect.y);
    ctx.lineTo(rect.x + rect.width, rect.y + rect.height);
  }
  ctx.closePath();
  ctx.fill();
}

/** The T a text clip leads with, in place of the picture a media clip would show. */
function drawTextMark(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; height: number },
  palette: TimelinePalette,
): void {
  const x = rect.x + 13;
  const y = rect.y + rect.height / 2;
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x - 4.5, y - 5);
  ctx.lineTo(x + 4.5, y - 5);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.stroke();
}

function drawSpeedBadge(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  rect: { x: number; y: number; width: number; height: number },
  palette: TimelinePalette,
): void {
  ctx.font = BADGE_FONT;
  const text = `${clip.speed}×`;
  const badgeW = ctx.measureText(text).width + 9;
  const badgeH = 14;
  if (rect.width < badgeW + 10) return;
  const x = rect.x + 5;
  const y = rect.y + rect.height - badgeH - 5;
  ctx.beginPath();
  ctx.roundRect(x, y, badgeW, badgeH, 4);
  ctx.fillStyle = palette.speedFill;
  ctx.fill();
  ctx.fillStyle = palette.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 4.5, y + badgeH / 2);
}

/**
 * The seam badges, over the clips they join.
 *
 * The glyph is the two overlapped triangles every crossfade wears; the kinds
 * that will want glyphs of their own are 10's business.
 */
function drawTransitions(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  rows: TrackRow[],
  palette: TimelinePalette,
): void {
  const { width, height, scrollTopPx } = model.viewport;
  const half = TRANSITION_BADGE_PX / 2;
  for (const transition of model.timeline.transitions) {
    const centreX = transitionCenterX(
      transition,
      model.timeline.clips,
      model.view,
    );
    if (centreX === null) continue;
    const leader = model.timeline.clips.find(
      (clip) => clip.id === transition.afterClipId,
    );
    if (!leader) continue;
    const row = rows.find((candidate) => candidate.track.id === leader.trackId);
    if (!row) continue;
    const centreY = row.top + row.height / 2 - scrollTopPx;
    if (centreX < -half || centreX > width + half) continue;
    if (centreY < -half || centreY > height + half) continue;
    const selected = model.selection.transitionId === transition.id;
    ctx.beginPath();
    ctx.roundRect(
      centreX - half,
      centreY - half,
      TRANSITION_BADGE_PX,
      TRANSITION_BADGE_PX,
      5,
    );
    ctx.fillStyle = palette.badgeFill;
    ctx.fill();
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? palette.selection : palette.badgeStroke;
    ctx.stroke();
    ctx.strokeStyle = palette.badgeGlyph;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(centreX - 5, centreY - 3.5);
    ctx.lineTo(centreX + 0.5, centreY);
    ctx.lineTo(centreX - 5, centreY + 3.5);
    ctx.moveTo(centreX + 5, centreY - 3.5);
    ctx.lineTo(centreX - 0.5, centreY);
    ctx.lineTo(centreX + 5, centreY + 3.5);
    ctx.stroke();
  }
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  model: TimelineRenderModel,
  palette: TimelinePalette,
  rulerY: number,
): void {
  const { width, height } = model.viewport;
  const x = xAt(model.playheadMs, model.view);
  if (x < -1 || x > width + 1) return;
  ctx.fillStyle = palette.playhead;
  ctx.fillRect(x - 0.75, rulerY, 1.5, height - rulerY);
  ctx.beginPath();
  ctx.moveTo(x - 4, rulerY + RULER_H - 6);
  ctx.lineTo(x + 4, rulerY + RULER_H - 6);
  ctx.lineTo(x, rulerY + RULER_H);
  ctx.closePath();
  ctx.fill();
}
