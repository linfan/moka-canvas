import { describe, expect, it } from "vitest";
import type {
  TimelineClip,
  TimelineDocument,
  TimelineTransition,
} from "../../../shared/domain";
import {
  XFADE_NAMES,
  drawTransition,
  seamAt,
  type DrawSeamSide,
  type SeamKind,
} from "./blend";

const T0 = "2026-01-01T00:00:00.000Z";

function clip(
  id: string,
  startMs: number,
  durationMs: number,
  trackId = "track-v",
): TimelineClip {
  return {
    id,
    trackId,
    kind: "video",
    label: `${id}.mp4`,
    assetId: `asset-${id}`,
    startMs,
    durationMs,
    inPointMs: 0,
    outPointMs: durationMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: T0,
    updatedAt: T0,
  };
}

function transition(durationMs: number, afterClipId = "a"): TimelineTransition {
  return {
    id: "s1",
    afterClipId,
    kind: "crossfade",
    durationMs,
    createdAt: T0,
  };
}

/** A cut with A 0–4,000 and B pulled back 500 into it: the window [3,500, 4,000). */
function cut(patch: Partial<TimelineDocument> = {}): TimelineDocument {
  return {
    id: "timeline-1",
    name: "Cut",
    schemaVersion: 1,
    settings: { fps: 30, width: 1920, height: 1080, background: "#000000" },
    tracks: [
      {
        id: "track-v",
        kind: "video",
        name: "Video 1",
        muted: false,
        hidden: false,
        locked: false,
        createdAt: T0,
      },
    ],
    clips: [clip("a", 0, 4_000), clip("b", 3_500, 1_200)],
    transitions: [transition(500)],
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

interface RecordedEvent {
  name: string;
  args: number[];
  globalAlpha: number;
  fillStyle: string;
}

/**
 * A context that writes down what it was asked to draw.
 *
 * The picture is pixels a test cannot read, so the events are the picture:
 * which side was drawn when, with what alpha and offsets, and — for the dips
 * — that the plate was laid before the side. `globalAlpha` is a real property
 * that save and restore move, so the reset promise is a fact of the stub
 * rather than an assumption.
 */
function recordingContext(
  width: number,
  height: number,
): {
  ctx: CanvasRenderingContext2D;
  events: RecordedEvent[];
  restingAlpha: () => number;
} {
  const events: RecordedEvent[] = [];
  const stack: number[] = [];
  let alpha = 1;
  let fillStyle = "";
  const push = (name: string, args: number[] = []) => {
    events.push({ name, args, globalAlpha: alpha, fillStyle });
  };
  const ctx = {
    canvas: { width, height },
    fillStyle,
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(value: number) {
      alpha = value;
    },
    save() {
      stack.push(alpha);
      push("save");
    },
    restore() {
      alpha = stack.pop() ?? 1;
      push("restore");
    },
    fillRect(...args: number[]) {
      push("fillRect", args);
    },
    rect(...args: number[]) {
      push("rect", args);
    },
    clip() {
      push("clip");
    },
    translate(...args: number[]) {
      push("translate", args);
    },
    scale(...args: number[]) {
      push("scale", args);
    },
    beginPath() {
      push("beginPath");
    },
  };
  const target = new Proxy(ctx, {
    set(object, property, value) {
      if (property === "fillStyle") fillStyle = String(value);
      return Reflect.set(object, property, value);
    },
  });
  return {
    ctx: target as unknown as CanvasRenderingContext2D,
    events,
    restingAlpha: () => alpha,
  };
}

/** A side that records itself, so the blend's order is visible. */
function side(name: string, events: RecordedEvent[]): DrawSeamSide {
  return (ctx) => {
    events.push({
      name,
      args: [],
      globalAlpha: ctx.globalAlpha,
      fillStyle: "",
    });
  };
}

/** Runs one draw and hands back what the context and the sides saw. */
function draw(kind: SeamKind, progress: number): RecordedEvent[] {
  const { ctx, events } = recordingContext(800, 600);
  drawTransition(
    ctx,
    kind,
    progress,
    side("leader", events),
    side("follower", events),
  );
  return events;
}

function named(events: RecordedEvent[], name: string): RecordedEvent[] {
  return events.filter((event) => event.name === name);
}

describe("where a moment stands in a seam window", () => {
  it("reads the window's head as p = 0 and its last millisecond short of 1", () => {
    const timeline = cut();
    const start = seamAt(timeline, "track-v", 3_500);
    expect(start?.progress).toBe(0);
    expect(start?.leader.id).toBe("a");
    expect(start?.follower.id).toBe("b");
    expect(start?.transition.id).toBe("s1");
    expect(seamAt(timeline, "track-v", 3_999)?.progress).toBeCloseTo(0.998, 6);
  });

  it("reads the window's end and the moments before it as no blend", () => {
    const timeline = cut();
    expect(seamAt(timeline, "track-v", 3_499)).toBeNull();
    expect(seamAt(timeline, "track-v", 4_000)).toBeNull();
    expect(seamAt(timeline, "track-v", 4_500)).toBeNull();
  });

  it("leaves a gap of clips and another track's seams alone", () => {
    const gapped = cut({
      clips: [clip("a", 0, 4_000), clip("b", 4_100, 1_200)],
      transitions: [],
    });
    expect(seamAt(gapped, "track-v", 3_700)).toBeNull();
    expect(seamAt(gapped, "track-v", 4_150)).toBeNull();
    expect(seamAt(cut(), "track-other", 3_700)).toBeNull();
  });

  it("passes over a transition whose kind is no blend at all", () => {
    const timeline = cut();
    timeline.transitions = [{ ...transition(500), kind: "none" }];
    expect(seamAt(timeline, "track-v", 3_700)).toBeNull();
  });
});

describe("the endpoints of every blend", () => {
  const kinds: SeamKind[] = [
    "crossfade",
    "dipToBlack",
    "dipToWhite",
    "slideLeft",
    "slideUp",
    "wipe",
    "zoomIn",
  ];

  it("asks only the leader at p = 0", () => {
    for (const kind of kinds) {
      expect(draw(kind, 0).map((event) => event.name)).toEqual(["leader"]);
    }
  });

  it("asks only the follower at p = 1", () => {
    for (const kind of kinds) {
      expect(draw(kind, 1).map((event) => event.name)).toEqual(["follower"]);
    }
  });

  it("clamps a progress outside the window to its nearer end", () => {
    expect(draw("crossfade", -1).map((event) => event.name)).toEqual([
      "leader",
    ]);
    expect(draw("crossfade", 2).map((event) => event.name)).toEqual([
      "follower",
    ]);
  });
});

describe("each kind's own drawing", () => {
  const canvas = { width: 800, height: 600 };

  it("fades the follower over the leader", () => {
    const events = draw("crossfade", 0.5);
    expect(events.map((event) => event.name)).toEqual([
      "save",
      "leader",
      "follower",
      "restore",
    ]);
    expect(events[1].globalAlpha).toBe(1);
    expect(events[2].globalAlpha).toBe(0.5);
  });

  it("dips through an opaque black plate, ramping each half", () => {
    const early = draw("dipToBlack", 0.25);
    expect(early[1]).toMatchObject({
      name: "fillRect",
      args: [0, 0, canvas.width, canvas.height],
      fillStyle: "#000000",
      globalAlpha: 1,
    });
    expect(early[2]).toMatchObject({ name: "leader", globalAlpha: 0.5 });

    const late = draw("dipToBlack", 0.75);
    expect(late[2]).toMatchObject({ name: "follower", globalAlpha: 0.5 });
  });

  it("dips through white where the kind says white", () => {
    const events = draw("dipToWhite", 0.25);
    expect(events[1]).toMatchObject({
      name: "fillRect",
      fillStyle: "#ffffff",
    });
  });

  it("slides the leader out left and the follower in from the right", () => {
    const events = draw("slideLeft", 0.5);
    expect(named(events, "translate").map((event) => event.args)).toEqual([
      [-canvas.width / 2, 0],
      [canvas.width, 0],
    ]);
    expect(
      events.filter((event) => event.name === "leader")[0].globalAlpha,
    ).toBe(1);
  });

  it("slides the pair up the frame", () => {
    const events = draw("slideUp", 0.5);
    expect(named(events, "translate").map((event) => event.args)).toEqual([
      [0, -canvas.height / 2],
      [0, canvas.height],
    ]);
  });

  it("wipes the follower in from the right edge, boundary walking left", () => {
    const events = draw("wipe", 0.5);
    expect(named(events, "rect").map((event) => event.args)).toEqual([
      [canvas.width / 2, 0, canvas.width / 2, canvas.height],
    ]);
    expect(events.map((event) => event.name)).toContain("clip");
    // The clip is set before the follower is drawn, and the leader is whole.
    const order = events.map((event) => event.name);
    expect(order.indexOf("leader")).toBeLessThan(order.indexOf("clip"));
    expect(order.indexOf("clip")).toBeLessThan(order.indexOf("follower"));
  });

  it("grows the follower out of the frame's middle, its shape kept", () => {
    const events = draw("zoomIn", 0.5);
    expect(named(events, "rect").map((event) => event.args)).toEqual([
      [
        canvas.width / 4,
        canvas.height / 4,
        canvas.width / 2,
        canvas.height / 2,
      ],
    ]);
    expect(named(events, "translate").map((event) => event.args)).toEqual([
      [canvas.width / 4, canvas.height / 4],
    ]);
    expect(named(events, "scale").map((event) => event.args)).toEqual([
      [0.5, 0.5],
    ]);
  });

  it("puts the context back as it found it, alpha and clipping alike", () => {
    for (const kind of ["crossfade", "dipToBlack", "wipe", "zoomIn"] as const) {
      const { ctx, events, restingAlpha } = recordingContext(800, 600);
      ctx.globalAlpha = 0.5;
      drawTransition(
        ctx,
        kind,
        0.5,
        side("leader", events),
        side("follower", events),
      );
      expect(restingAlpha()).toBe(0.5);
      expect(named(events, "save").length).toBe(
        named(events, "restore").length,
      );
    }
  });
});

describe("the export mapping the kinds carry", () => {
  it("names the ffmpeg xfade transition each kind exports as", () => {
    expect(XFADE_NAMES).toEqual({
      crossfade: "fade",
      dipToBlack: "fadeblack",
      dipToWhite: "fadewhite",
      slideLeft: "slideleft",
      slideUp: "slideup",
      wipe: "wipeleft",
      zoomIn: "zoomin",
    });
  });
});
