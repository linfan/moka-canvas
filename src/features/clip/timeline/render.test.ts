import { describe, expect, it } from "vitest";
import { createTimeline } from "../../../shared/domain";
import type { TimelineDocument } from "../../../shared/domain";
import { buildCutMokaFile } from "../../../shared/domain/fixtures";
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
    thumbs: null,
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
