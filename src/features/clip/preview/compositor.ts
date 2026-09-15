import type {
  ClipAdjust,
  ClipId,
  Rect,
  TimelineClip,
  TimelineDocument,
} from "../../../shared/domain";
import { drawTransition, seamAt, type SeamMoment } from "./blend";
import { clipLook } from "./looks";
import { drawTextClip } from "./text";

/**
 * The frame the playhead is standing on, drawn.
 *
 * Everything below this is a reading of the document at one moment: the frame
 * is filled with the timeline's background, then each track draws what covers
 * the moment in the order the tracks are held — the last track is the top of
 * the stack. A clip draws its picture contained and centred, carrying its
 * opacity, its fades, its grade and its preset; a text clip draws its words.
 * Nothing here waits on the document: a moment with no clips on it is a frame
 * of background, which is the honest preview of a gap rather than an empty
 * state.
 */

/** A picture ready to be drawn, with the size it wants to be drawn at. */
export interface ClipPicture {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** How far the file stored the picture turned; 0 for a picture that is upright. */
  rotationDeg: number;
}

/** What a source could give for a clip's moment. */
export type FramePicture =
  { kind: "picture"; picture: ClipPicture } | { kind: "waiting" };

export interface FrameSources {
  /**
   * The picture a material clip reads at its material moment.
   *
   * `waiting` is a file on its way — the frame is drawn as loading rather than
   * as black — and null is a file that cannot be read at all.
   */
  frameFor(
    clip: TimelineClip,
    materialMs: number,
  ): Promise<FramePicture | null>;
}

export interface ComposeFrameOptions {
  /** The canvas's size in its own pixels; the timeline's shape is assumed to match. */
  width: number;
  height: number;
  timeline: TimelineDocument;
  atMs: number;
  sources: FrameSources;
  /** Whether the canvas takes a filter string; without it grades and looks are left off. */
  filter: boolean;
  /**
   * The grade a reader is dragging, standing in for the document's own.
   *
   * A clip the draft names wears the draft's adjust in this frame rather than
   * the grade the document holds, so the picture answers a held slider before
   * any command has been sent. Passed in rather than read from a store: the
   * composition stays a pure reading of what it is handed.
   */
  adjustDraft?: { clipIds: readonly ClipId[]; adjust: ClipAdjust } | null;
  /**
   * Asked once the pictures are in hand and before anything is drawn: a frame
   * the reader has already moved past is dropped rather than painted.
   */
  isCurrent?: () => boolean;
}

export interface FrameReport {
  /** The clips the frame read, in the order they were drawn, topmost last. */
  clips: TimelineClip[];
  /** Whether an ungraded picture was drawn because the canvas cannot filter. */
  coloursSkipped: boolean;
}

/**
 * The clip a track shows at a moment, outside any seam window.
 *
 * When two clips start together, the one the document orders first is the
 * leader. A seam's own moment is `seamAt`'s business — this is the plain
 * reading, and the fallback for a moment a window does not cover.
 */
function leaderAt(
  timeline: TimelineDocument,
  trackId: string,
  atMs: number,
): TimelineClip | null {
  let leader: TimelineClip | null = null;
  for (const clip of timeline.clips) {
    if (clip.trackId !== trackId) continue;
    if (atMs < clip.startMs || atMs >= clip.startMs + clip.durationMs) continue;
    if (
      leader === null ||
      clip.startMs < leader.startMs ||
      (clip.startMs === leader.startMs && clip.id < leader.id)
    )
      leader = clip;
  }
  return leader;
}

/** The moment of the material a clip reads, by its own clock and its speed. */
export function materialMoment(clip: TimelineClip, atMs: number): number {
  return Math.max(
    0,
    Math.round(clip.inPointMs + (atMs - clip.startMs) * clip.speed),
  );
}

/** How much of a clip's own presence a moment shows, from its two fades. */
export function fadeFactor(clip: TimelineClip, atMs: number): number {
  const rise = clip.fadeInMs > 0 ? (atMs - clip.startMs) / clip.fadeInMs : 1;
  const fall =
    clip.fadeOutMs > 0
      ? (clip.startMs + clip.durationMs - atMs) / clip.fadeOutMs
      : 1;
  return Math.max(0, Math.min(1, rise, fall));
}

/** The largest box of the picture's own shape that fits the frame, centred in it. */
export function containRect(
  sourceWidth: number,
  sourceHeight: number,
  frameWidth: number,
  frameHeight: number,
): Rect {
  if (sourceWidth <= 0 || sourceHeight <= 0)
    return { x: 0, y: 0, width: frameWidth, height: frameHeight };
  const scale = Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (frameWidth - width) / 2,
    y: (frameHeight - height) / 2,
    width,
    height,
  };
}

function drawPictureClip(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  picture: ClipPicture,
  atMs: number,
  frameWidth: number,
  frameHeight: number,
  filterEnabled: boolean,
  draftedAdjust: ClipAdjust | undefined,
): boolean {
  const alpha = Math.max(0, Math.min(1, clip.opacity)) * fadeFactor(clip, atMs);
  if (alpha <= 0) return false;
  const look = clipLook({
    adjust: draftedAdjust ?? clip.adjust,
    filter: clip.filter,
  });
  // Without a filter on the canvas the grade is dropped, and the caller is
  // told: a picture shown ungraded is a fact to put on the badge.
  const filter = filterEnabled ? look.filter : "";
  const veil = filterEnabled ? look.veil : null;
  const coloursSkipped =
    !filterEnabled && (look.filter.length > 0 || look.veil !== null);

  // A picture stored turned is fitted by its turned shape, so what fills the
  // frame is what a viewer sees rather than what the file memorised.
  const turned = picture.rotationDeg === 90 || picture.rotationDeg === 270;
  const box = containRect(
    turned ? picture.height : picture.width,
    turned ? picture.width : picture.height,
    frameWidth,
    frameHeight,
  );
  // Whatever the context already carries is part of this clip's presence: a
  // seam blend sets its factor on the context, so the two multiply where the
  // clip's own opacity and fades are applied.
  const carried = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = alpha * carried;
  if (filter) ctx.filter = filter;
  if (picture.rotationDeg !== 0) {
    // The file asks for the turn and WebCodecs never applies it; package 12
    // lets ffmpeg autorotate from the same matrix, so both sides agree.
    ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
    ctx.rotate((picture.rotationDeg * Math.PI) / 180);
    ctx.drawImage(
      picture.source,
      -box.width / 2,
      -box.height / 2,
      box.width,
      box.height,
    );
  } else {
    ctx.drawImage(picture.source, box.x, box.y, box.width, box.height);
  }
  if (filter) ctx.filter = "none";
  if (veil) {
    ctx.globalAlpha = alpha * veil.alpha * carried;
    ctx.globalCompositeOperation = "soft-light";
    ctx.fillStyle = veil.color;
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }
  ctx.restore();
  return coloursSkipped;
}

/** What a clip with no picture yet shows: a place being read rather than a black frame. */
function drawWaiting(
  ctx: CanvasRenderingContext2D,
  clip: TimelineClip,
  atMs: number,
  frameWidth: number,
  frameHeight: number,
): void {
  const alpha = Math.max(0, Math.min(1, clip.opacity)) * fadeFactor(clip, atMs);
  if (alpha <= 0) return;
  const inset = Math.min(frameWidth, frameHeight) * 0.06;
  // Like the picture path, whatever the context carries is part of the blend.
  const carried = ctx.globalAlpha;
  ctx.save();
  ctx.globalAlpha = alpha * 0.5 * carried;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(
    inset,
    inset,
    frameWidth - inset * 2,
    frameHeight - inset * 2,
    inset,
  );
  ctx.fill();
  ctx.globalAlpha = alpha * carried;
  ctx.fillStyle = "#5b5b5b";
  ctx.font = `${Math.max(10, Math.round(frameHeight * 0.04))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Loading", frameWidth / 2, frameHeight / 2);
  ctx.restore();
}

/**
 * One track's contribution to a frame: the clip it shows, or a seam's two
 * sides — both of which the track really is showing, so one cannot be dropped
 * in favour of the other.
 */
type FrameLayer =
  | { kind: "clip"; clip: TimelineClip; picture: FramePicture | null }
  | {
      kind: "seam";
      seam: SeamMoment;
      leaderPicture: FramePicture | null;
      followerPicture: FramePicture | null;
    };

/**
 * Draws the frame under a moment, and reports what it drew.
 *
 * The pictures are all in hand before anything is painted, so the drawing
 * itself is one unbroken turn: no frame is closed under a half-drawn picture,
 * and a stale composition is dropped without touching the canvas at all.
 */
export async function composeFrame(
  ctx: CanvasRenderingContext2D,
  options: ComposeFrameOptions,
): Promise<FrameReport | null> {
  const { timeline, atMs, width, height } = options;
  /** The picture a clip reads at this moment; words carry no file. */
  const pictureOf = (clip: TimelineClip): Promise<FramePicture | null> =>
    clip.kind === "video"
      ? options.sources.frameFor(clip, materialMoment(clip, atMs))
      : Promise.resolve(null);

  const chosen: FrameLayer[] = [];
  for (const track of timeline.tracks) {
    if (track.hidden) continue;
    // A row of sound is sound: it has no picture to put in the frame.
    if (track.kind === "audio") continue;
    // A seam window holds two clips; both are read and drawn, each with its
    // own material moment, so the blend is the same picture the clips would
    // show alone. Outside a window the track shows its one leader.
    const seam = seamAt(timeline, track.id, atMs);
    if (seam) {
      chosen.push({
        kind: "seam",
        seam,
        leaderPicture: await pictureOf(seam.leader),
        followerPicture: await pictureOf(seam.follower),
      });
      continue;
    }
    const clip = leaderAt(timeline, track.id, atMs);
    if (!clip) continue;
    chosen.push({ kind: "clip", clip, picture: await pictureOf(clip) });
  }
  if (options.isCurrent && !options.isCurrent()) return null;

  ctx.fillStyle = timeline.settings.background;
  ctx.fillRect(0, 0, width, height);

  let coloursSkipped = false;
  // The draft's named clips, looked up once per frame rather than per draw.
  const drafted =
    options.adjustDraft && options.adjustDraft.clipIds.length > 0
      ? {
          ids: new Set(options.adjustDraft.clipIds),
          adjust: options.adjustDraft.adjust,
        }
      : null;
  /** Draws one clip as the track would show it alone; says if a grade was dropped. */
  const drawOne = (
    target: CanvasRenderingContext2D,
    clip: TimelineClip,
    picture: FramePicture | null,
  ): boolean => {
    if (clip.kind === "text") {
      if (clip.text)
        drawTextClip(
          target,
          clip.text,
          { width, height },
          timeline.settings.width,
          Math.max(0, Math.min(1, clip.opacity)) * fadeFactor(clip, atMs),
        );
      return false;
    }
    if (picture?.kind === "picture")
      return drawPictureClip(
        target,
        clip,
        picture.picture,
        atMs,
        width,
        height,
        options.filter,
        drafted?.ids.has(clip.id) ? drafted.adjust : undefined,
      );
    if (picture?.kind === "waiting")
      drawWaiting(target, clip, atMs, width, height);
    return false;
  };
  for (const layer of chosen) {
    try {
      if (layer.kind === "clip") {
        coloursSkipped =
          drawOne(ctx, layer.clip, layer.picture) || coloursSkipped;
        continue;
      }
      // Both sides of the seam draw as regular clips, through the kind's own
      // blend; what one side would report about a dropped grade is folded in.
      let skipped = false;
      const side =
        (clip: TimelineClip, picture: FramePicture | null) =>
        (target: CanvasRenderingContext2D) => {
          skipped = drawOne(target, clip, picture) || skipped;
        };
      drawTransition(
        ctx,
        layer.seam.kind,
        layer.seam.progress,
        side(layer.seam.leader, layer.leaderPicture),
        side(layer.seam.follower, layer.followerPicture),
      );
      coloursSkipped = skipped || coloursSkipped;
    } catch {
      // A picture that will not draw — a frame already let go of, an element
      // that never had data — leaves its layer out rather than taking the rest
      // of the frame down with it.
    }
  }
  return {
    clips: chosen.flatMap((layer) =>
      layer.kind === "clip"
        ? [layer.clip]
        : [layer.seam.leader, layer.seam.follower],
    ),
    coloursSkipped,
  };
}
