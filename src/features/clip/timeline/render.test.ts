import { describe, expect, it } from "vitest";
import { createTimeline } from "../../../shared/domain";
import type { TimelineDocument } from "../../../shared/domain";
import { buildCutMokaFile } from "../../../shared/domain/fixtures";
import type { DraftClip } from "../interactions/gestures";
import { TIMELINE_PALETTE } from "./palette";
import { renderTimeline, type TimelineRenderModel } from "./render";
import { xAt } from "./geometry";

interface RecordedCall {
  name: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
}

/**
 * A context that only writes down what it was asked to draw.
 *
 * The drawing is pure and the screen is pixels a test cannot read, so the
 * calls are the picture: which colours were laid where, and in what order.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = (name: string) =>
    function (
      this: { fillStyle: string; strokeStyle: string },
      ...args: number[]
    ) {
      calls.push({
        name,
        args,
        fillStyle: String(this.fillStyle),
        strokeStyle: String(this.strokeStyle),
      });
    };
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    shadowColor: "",
    shadowBlur: 0,
    beginPath: record("beginPath"),
    closePath: record("closePath"),
    roundRect: record("roundRect"),
    rect: record("rect"),
    clip: record("clip"),
    fill: record("fill"),
    stroke: record("stroke"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    arc: record("arc"),
    fillRect: record("fillRect"),
    fillText: record("fillText"),
    drawImage: record("drawImage"),
    save: record("save"),
    restore: record("restore"),
    setLineDash(lines: number[]) {
      calls.push({
        name: "setLineDash",
        args: [lines],
        fillStyle: String(this.fillStyle),
        strokeStyle: String(this.strokeStyle),
      });
    },
    measureText(text: string) {
      return { width: text.length * 6 } as TextMetrics;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function cut(): TimelineDocument {
  return buildCutMokaFile().timelines![0];
}

function model(patch: Partial<TimelineRenderModel> = {}): TimelineRenderModel {
  return {
    timeline: cut(),
    view: { pxPerSec: 60, scrollLeftPx: 0 },
    viewport: { width: 800, height: 300, scrollTopPx: 0 },
    playheadMs: 2_000,
    selection: { clipIds: [], transitionId: null },
    decor: null,
    ...patch,
  };
}

function named(calls: RecordedCall[], name: string): RecordedCall[] {
  return calls.filter((call) => call.name === name);
}

describe("drawing a screen of the timeline", () => {
  it("draws the clips the window holds and nothing outside it", () => {
    const clipColours = Object.values(TIMELINE_PALETTE.clip);
    const paintedClips = (calls: RecordedCall[]) =>
      named(calls, "fill").filter((call) =>
        clipColours.includes(call.fillStyle),
      );

    const shown = recordingContext();
    renderTimeline(shown.ctx, model());
    expect(paintedClips(shown.calls).length).toBeGreaterThan(0);

    const past = recordingContext();
    renderTimeline(
      past.ctx,
      model({ view: { pxPerSec: 60, scrollLeftPx: 100_000 } }),
    );
    expect(paintedClips(past.calls)).toEqual([]);
    // The ruler is drawn wherever the content is scrolled to.
    expect(named(past.calls, "fillText").length).toBeGreaterThan(0);
  });

  it("fills the rows top-down from the last track, heights by kind", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(ctx, model());
    const rows = named(calls, "fillRect").filter(
      (call) =>
        call.fillStyle === TIMELINE_PALETTE.rowA ||
        call.fillStyle === TIMELINE_PALETTE.rowB,
    );
    expect(rows.map((call) => [call.args[1], call.args[3]])).toEqual([
      [28, 36],
      [64, 56],
      [120, 64],
    ]);
    expect(rows.map((call) => call.fillStyle)).toEqual([
      TIMELINE_PALETTE.rowA,
      TIMELINE_PALETTE.rowB,
      TIMELINE_PALETTE.rowA,
    ]);
  });

  it("drops the playhead where the view says, from the ruler to the canvas's foot", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(ctx, model());
    const line = named(calls, "fillRect").find(
      (call) =>
        call.fillStyle === TIMELINE_PALETTE.playhead &&
        Number(call.args[2]) === 1.5,
    );
    expect(line).toBeDefined();
    expect(Number(line!.args[0])).toBeCloseTo(
      xAt(2_000, { pxPerSec: 60, scrollLeftPx: 0 }) - 0.75,
    );
    expect(Number(line!.args[1])).toBeCloseTo(0);
    expect(Number(line!.args[3])).toBe(300);
  });

  it("keeps the rows of a cut with nothing on them, and draws no clips", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(ctx, model({ timeline: createTimeline("Empty") }));
    expect(named(calls, "roundRect")).toEqual([]);
    const rows = named(calls, "fillRect").filter(
      (call) =>
        call.fillStyle === TIMELINE_PALETTE.rowA ||
        call.fillStyle === TIMELINE_PALETTE.rowB,
    );
    // The three rows a new timeline is born with, where the first piece lands.
    expect(rows.map((call) => call.args[1])).toEqual([28, 64, 120]);
  });

  it("draws only the ruler for a timeline that has lost its rows", () => {
    const { ctx, calls } = recordingContext();
    const trackless = { ...createTimeline("Trackless"), tracks: [] };
    renderTimeline(ctx, model({ timeline: trackless }));
    expect(named(calls, "roundRect")).toEqual([]);
    expect(
      named(calls, "fillRect").filter(
        (call) =>
          call.fillStyle === TIMELINE_PALETTE.rowA ||
          call.fillStyle === TIMELINE_PALETTE.rowB,
      ),
    ).toEqual([]);
    // The ruler still reads, which is where the playhead is placed.
    expect(
      named(calls, "fillText").some((call) => call.args[0] === "00:00"),
    ).toBe(true);
  });

  it("strokes the chosen clip in the selection colour", () => {
    const { ctx, calls } = recordingContext();
    const clipId = cut().clips[0].id;
    renderTimeline(
      ctx,
      model({ selection: { clipIds: [clipId], transitionId: null } }),
    );
    expect(
      named(calls, "stroke").some(
        (call) => call.strokeStyle === TIMELINE_PALETTE.selection,
      ),
    ).toBe(true);
  });
});

describe("drawing what a gesture has in hand", () => {
  /** A draft's view of the fixture's first block, moved a second later. */
  function ghost(patch: Partial<DraftClip> = {}): DraftClip {
    const clip = cut().clips[0];
    return {
      clipId: clip.id,
      trackId: clip.trackId,
      kind: clip.kind,
      startMs: 1_000,
      durationMs: clip.durationMs,
      ...patch,
    };
  }

  it("draws a drag's ghost where the release would leave it, dashed", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(
      ctx,
      model({
        draft: {
          kind: "move",
          clips: [ghost()],
          guideMs: 1_000,
          rowTrackId: null,
        },
      }),
    );
    // The ghost is a block outline: roundRect at its own second, on its row.
    const outline = named(calls, "roundRect").find(
      (call) => Math.round(Number(call.args[0])) === 60,
    );
    expect(outline).toBeDefined();
    expect(Number(outline!.args[1])).toBeCloseTo(120.5);
    expect(Number(outline!.args[2])).toBeCloseTo(240);
    // Dashed, and stroked in the guide's colour, which the cut alone never is.
    expect(named(calls, "setLineDash").map((call) => call.args[0])).toEqual([
      [5, 3],
    ]);
    expect(
      named(calls, "stroke").some(
        (call) => call.strokeStyle === TIMELINE_PALETTE.snap,
      ),
    ).toBe(true);
    // The guide is the one-pixel line the snapping feedback promises.
    const guide = named(calls, "fillRect").find(
      (call) => call.fillStyle === TIMELINE_PALETTE.snap && call.args[2] === 1,
    );
    expect(guide).toBeDefined();
    expect(Number(guide!.args[0])).toBeCloseTo(59.5);
  });

  it("lights the row a cross-track drag is landing on", () => {
    const { ctx, calls } = recordingContext();
    const textTrack = cut().tracks[2];
    renderTimeline(
      ctx,
      model({
        draft: {
          kind: "move",
          clips: [ghost()],
          guideMs: null,
          rowTrackId: textTrack.id,
        },
      }),
    );
    const lit = named(calls, "fillRect").find(
      (call) =>
        call.fillStyle === TIMELINE_PALETTE.snap &&
        Number(call.args[1]) === 28 &&
        Number(call.args[3]) === 36,
    );
    expect(lit).toBeDefined();
  });

  it("draws a trim's outline and its duration bubble", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(
      ctx,
      model({
        draft: {
          kind: "trim",
          clip: ghost({ startMs: 0, durationMs: 2_500 }),
          edge: "end",
          guideMs: null,
        },
      }),
    );
    // The bubble reads the block's length on the document's clock.
    expect(named(calls, "fillText").map((call) => call.args[0])).toContain(
      "00:00:02:15",
    );
    expect(
      named(calls, "stroke").some(
        (call) => call.strokeStyle === TIMELINE_PALETTE.snap,
      ),
    ).toBe(true);
  });

  it("draws a marquee as a washed rectangle, outlined", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(
      ctx,
      model({
        draft: {
          kind: "marquee",
          rect: { x: 100, y: 40, width: 200, height: 80 },
        },
      }),
    );
    const wash = named(calls, "fillRect").find(
      (call) => call.fillStyle === TIMELINE_PALETTE.marqueeFill,
    );
    expect(wash).toBeDefined();
    expect(wash!.args.slice(0, 4).map(Number)).toEqual([100, 40, 200, 80]);
    const outline = named(calls, "rect").find(
      (call) => Math.round(Number(call.args[0])) === 100,
    );
    expect(outline).toBeDefined();
  });

  it("leaves the guide colours out of a cut nobody is dragging", () => {
    const { ctx, calls } = recordingContext();
    renderTimeline(ctx, model());
    expect(
      named(calls, "stroke").some(
        (call) => call.strokeStyle === TIMELINE_PALETTE.snap,
      ),
    ).toBe(false);
    expect(named(calls, "setLineDash")).toEqual([]);
  });
});
