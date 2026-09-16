import type { Point } from "../../../shared/domain";

/** How big a picture is, in its own pixels. */
export interface Size {
  width: number;
  height: number;
}

/** How a region is marked out. */
export type MarkTool = "brush" | "erase" | "box" | "outline";

export const MARK_TOOLS: readonly MarkTool[] = [
  "brush",
  "erase",
  "box",
  "outline",
];

export const MARK_LABELS: Record<MarkTool, string> = {
  brush: "editor:repaint.markToolBrush",
  erase: "editor:repaint.markToolErase",
  box: "editor:repaint.markToolBox",
  outline: "editor:repaint.markToolOutline",
};

export const MARK_HINTS: Record<MarkTool, string> = {
  brush: "editor:repaint.hintBrush",
  erase: "editor:repaint.hintErase",
  box: "editor:repaint.hintBox",
  outline: "editor:repaint.hintOutline",
};

/** How wide a brush gets, and how far an edge may fade, in the picture's pixels. */
export const BRUSH_NARROWEST = 2;
export const BRUSH_WIDEST = 160;
export const SOFTEST_PIXELS = 48;

/**
 * How many passes a soft edge is drawn in.
 *
 * A soft edge is made by drawing the same mark several times, each a little
 * wider and a little fainter, rather than by blurring what was drawn: the passes
 * add up to white in the middle and fade at the rim, which is what a soft edge
 * is, and nothing here has to ask a browser for a filter it may not have.
 */
const SOFT_PASSES = 4;

/** How near the first point of an outline a click has to be to close it. */
function closesAt(mark: Mark): number {
  return Math.max(8, mark.radius);
}

/**
 * One thing drawn on the picture, held as the points it went through rather
 * than as the pixels it made.
 *
 * Kept as points so that taking one back is dropping it from the list and
 * drawing the rest again: a picture can be tens of millions of pixels, and a
 * copy of it per stroke would cost more than the marks do.
 */
export interface Mark {
  tool: MarkTool;
  /** Half how wide a brush stroke is, in the picture's own pixels. */
  radius: number;
  /** How far the edge fades, out of 100. A box and an outline fade too. */
  softness: number;
  /** Where it went. A box holds its two corners, in the order they were given. */
  points: Point[];
  /** Whether an outline was finished. One still being drawn is stroked open. */
  closed: boolean;
}

export function newMark(
  tool: MarkTool,
  radius: number,
  softness: number,
): Mark {
  return { tool, radius, softness, points: [], closed: false };
}

/** Whether a mark has anything in it yet, which an empty drag does not. */
export function drawn(mark: Mark): boolean {
  if (mark.points.length === 0) return false;
  if (mark.tool === "outline") return mark.closed;
  if (mark.tool === "box") {
    const [one, two] = mark.points;
    return Math.abs(one.x - two.x) > 0.5 || Math.abs(one.y - two.y) > 0.5;
  }
  return true;
}

function trace(context: CanvasRenderingContext2D, mark: Mark, grow: number) {
  context.beginPath();
  switch (mark.tool) {
    case "brush":
    case "erase": {
      const [first, ...rest] = mark.points;
      if (rest.length === 0) {
        // A click is a dot, and a path of one point has no length to stroke.
        context.arc(first.x, first.y, mark.radius * (1 + grow), 0, Math.PI * 2);
        return;
      }
      context.moveTo(first.x, first.y);
      for (const point of rest) context.lineTo(point.x, point.y);
      return;
    }
    case "box": {
      const [one, two] = mark.points;
      context.rect(
        Math.min(one.x, two.x),
        Math.min(one.y, two.y),
        Math.abs(two.x - one.x),
        Math.abs(two.y - one.y),
      );
      return;
    }
    case "outline": {
      const [first, ...rest] = mark.points;
      context.moveTo(first.x, first.y);
      for (const point of rest) context.lineTo(point.x, point.y);
      if (mark.closed) context.closePath();
    }
  }
}

/** Whether a mark is filled in rather than drawn around. */
function fills(mark: Mark): boolean {
  return (
    mark.tool === "box" ||
    (mark.tool === "outline" && mark.closed) ||
    // A single click has no length to stroke, so the dot is filled instead.
    ((mark.tool === "brush" || mark.tool === "erase") && mark.points.length < 2)
  );
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark) {
  if (mark.points.length === 0) return;
  const soft = Math.min(100, Math.max(0, mark.softness)) / 100;
  const passes = soft === 0 ? 1 : 1 + SOFT_PASSES;
  const shaped = mark.tool === "box" || mark.tool === "outline";
  context.save();
  // Taking a mark off is the same drawing with the destination let go of, so
  // an erase can never leave a grey smear where white used to be.
  context.globalCompositeOperation =
    mark.tool === "erase" ? "destination-out" : "source-over";
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#ffffff";
  context.lineJoin = "round";
  context.lineCap = "round";
  for (let pass = 0; pass < passes; pass += 1) {
    const grow = (soft * pass) / SOFT_PASSES;
    context.globalAlpha = pass === 0 ? 1 : 1 / (2 * (pass + 1));
    // A brush widens with its fade; a shape stays where it was drawn and fades
    // into a stroke around itself.
    context.lineWidth = shaped
      ? 2 * grow * SOFTEST_PIXELS
      : 2 * mark.radius * (1 + grow);
    trace(context, mark, grow);
    if (fills(mark) && (pass === 0 || !shaped)) context.fill();
    else context.stroke();
  }
  context.restore();
}

/** Draws every mark over whatever is already there. */
export function drawMarks(
  context: CanvasRenderingContext2D,
  marks: readonly Mark[],
) {
  for (const mark of marks) drawMark(context, mark);
}

/**
 * Draws a set of marks as the picture a model is sent: white where the picture
 * may change, black where it must not, at the size of the picture it was marked
 * on.
 *
 * The size is not a choice. A mask that is a different shape from the picture it
 * covers says nothing anybody can act on, and a provider that takes one at all
 * turns the mismatch away.
 */
export function traceMask(
  context: CanvasRenderingContext2D,
  marks: readonly Mark[],
  size: Size,
) {
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, size.width, size.height);
  drawMarks(context, marks);
}

/**
 * Whether a finished mask marks anything at all.
 *
 * Asked of the pixels rather than of the marks: a region painted and then erased
 * all over leaves a list with something in it and a picture with nothing, and it
 * is the picture that gets sent. An unmarked mask would ask for the whole
 * picture to be repainted, which is not what anybody meant by marking part of it.
 */
export function marksAnything(data: ImageData): boolean {
  const pixels = data.data;
  for (let at = 0; at < pixels.length; at += 4) {
    if (pixels[at] > 127 && pixels[at + 3] > 0) return true;
  }
  return false;
}

/**
 * What a mask is filed as: the name of the picture it covers, with `-mask`
 * before the extension.
 *
 * Named after its picture rather than given a name of its own, so a project
 * full of repaints still says which mask belongs to which picture.
 */
export function maskName(sourceName: string): string {
  const dot = sourceName.lastIndexOf(".");
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  return `${stem}-mask.png`;
}

/** Whether a click near the first point of an outline is one that closes it. */
export function closesOutline(mark: Mark, at: Point): boolean {
  if (mark.tool !== "outline" || mark.points.length < 3) return false;
  const first = mark.points[0];
  const reach = closesAt(mark);
  return Math.abs(first.x - at.x) <= reach && Math.abs(first.y - at.y) <= reach;
}
