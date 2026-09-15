import { describe, expect, it } from "vitest";
import { createTimeline } from "../../../shared/domain";
import type { Point, TimelineDocument } from "../../../shared/domain";
import {
  buildCutMokaFile,
  cutFixtureIds,
  timelineIds,
  buildTimelineMokaFile,
} from "../../../shared/domain/fixtures";
import {
  CLIP_EDGE_PX,
  DEFAULT_PX_PER_SEC,
  MAJOR_TICK_MIN_PX,
  MAX_PX_PER_SEC,
  MINOR_TICK_MIN_PX,
  MIN_CONTENT_MS,
  MIN_PX_PER_SEC,
  RULER_H,
  TAIL_MS,
  TRACK_HEIGHT,
  clampPxPerSec,
  clipRect,
  contentHeight,
  contentMs,
  contentWidth,
  cutEndMs,
  edgeAt,
  hitTest,
  msAt,
  tickLadder,
  trackRows,
  transitionCenterX,
  viewAfterZoom,
  visibleRange,
  xAt,
  zoomAnchorMs,
  type TimelineView,
} from "./geometry";

/** The cut fixture: every kind of clip, a transition, and both fades. */
function cut(): TimelineDocument {
  return buildCutMokaFile().timelines![0];
}

const VIEW: TimelineView = { pxPerSec: DEFAULT_PX_PER_SEC, scrollLeftPx: 0 };

function widthPx(ms: number, pxPerSec: number): number {
  return (ms / 1_000) * pxPerSec;
}

describe("x and ms", () => {
  it("read back and forth within a frame at every scale", () => {
    for (const pxPerSec of [MIN_PX_PER_SEC, 60, 137.5, MAX_PX_PER_SEC]) {
      const view = { pxPerSec, scrollLeftPx: 1_234 };
      for (const ms of [0, 33.333, 1_000, 12_345.678, 3_600_000]) {
        expect(msAt(xAt(ms, view), view)).toBeCloseTo(ms, 6);
      }
    }
  });

  it("puts the scroll's worth of content behind the left edge", () => {
    expect(xAt(5_000, { pxPerSec: 60, scrollLeftPx: 300 })).toBe(0);
    expect(msAt(0, { pxPerSec: 60, scrollLeftPx: 300 })).toBe(5_000);
  });
});

describe("rows", () => {
  it("draws the document's tracks in reverse, tallest row on the bottom", () => {
    const rows = trackRows(cut());
    expect(rows.map((row) => row.track.name)).toEqual([
      "Text 1",
      "Audio 1",
      "Video 1",
    ]);
    expect(rows.map((row) => row.track.kind)).toEqual([
      "text",
      "audio",
      "video",
    ]);
    expect(rows.map((row) => row.top)).toEqual([28, 64, 120]);
    expect(rows.map((row) => row.height)).toEqual([36, 56, 64]);
  });

  it("keeps the tops accumulating whatever the mix of heights", () => {
    const timeline = createTimeline("Mixed");
    const rows = trackRows(timeline);
    const fromBottom = [...timeline.tracks].reverse();
    rows.forEach((row, index) => {
      expect(row.track).toBe(fromBottom[index]);
      expect(row.height).toBe(TRACK_HEIGHT[row.track.kind]);
    });
    expect(rows[rows.length - 1].top + rows[rows.length - 1].height).toBe(
      contentHeight(timeline),
    );
  });
});

describe("clip blocks", () => {
  it("reads a clip's place straight from the document, seam pull-backs included", () => {
    const timeline = cut();
    const ids = cutFixtureIds();
    const rows = trackRows(timeline);
    const clipA = timeline.clips.find((clip) => clip.id === ids.clipA)!;
    const clipB = timeline.clips.find((clip) => clip.id === ids.clipB)!;

    expect(clipRect(clipA, rows, VIEW)).toEqual({
      x: 0,
      y: 120,
      width: 240,
      height: 64,
    });
    // The follower starts inside the transition's window: 3.5s, half a second
    // before its leader ends, which is the document's geometry and not a
    // special case of this drawing.
    expect(clipB.startMs).toBe(3_500);
    expect(clipRect(clipB, rows, VIEW).x).toBeCloseTo(210);
    const rectA = clipRect(clipA, rows, VIEW);
    const rectB = clipRect(clipB, rows, VIEW);
    expect(rectB.x).toBeLessThan(rectA.x + rectA.width);
    expect(rectA.x + rectA.width).toBeCloseTo(240);
  });

  it("gives a text clip its own row's height", () => {
    const timeline = cut();
    const ids = cutFixtureIds();
    const clipD = timeline.clips.find((clip) => clip.id === ids.clipD)!;
    const rect = clipRect(clipD, trackRows(timeline), VIEW);
    expect(rect).toEqual({ x: 0, y: 28, width: 120, height: 36 });
  });

  it("centres a seam's badge on the tail of the clip it follows", () => {
    const timeline = cut();
    const transition = timeline.transitions[0];
    expect(transitionCenterX(transition, timeline.clips, VIEW)).toBe(240);
    expect(
      transitionCenterX(
        { ...transition, afterClipId: "gone" },
        timeline.clips,
        VIEW,
      ),
    ).toBeNull();
  });
});

describe("the visible slice", () => {
  it("reads the window's edges at the view's scale", () => {
    const range = visibleRange({ pxPerSec: 60, scrollLeftPx: 0 }, 800);
    expect(range.startMs).toBe(0);
    expect(range.endMs).toBeCloseTo(13_333.33, 1);
    const scrolled = visibleRange({ pxPerSec: 60, scrollLeftPx: 1_200 }, 800);
    expect(scrolled.startMs).toBe(20_000);
    expect(scrolled.endMs).toBeCloseTo(33_333.33, 1);
  });
});

describe("the tick ladder", () => {
  it("picks the first rung that leaves its label room", () => {
    // 30fps: two-second majors at 120px, one-second minors at 60px.
    expect(tickLadder(30, 60)).toEqual({ majorMs: 2_000, minorMs: 1_000 });
    // 30fps at the far end out: 20s majors at 80px, nothing finer reads.
    expect(tickLadder(30, 4)).toEqual({ majorMs: 20_000, minorMs: null });
    // 30fps tight in: five-frame majors at 80px.
    expect(tickLadder(30, 480).majorMs).toBeCloseTo(5_000 / 30, 6);
    expect(tickLadder(30, 480).minorMs).toBeNull();
    // 60fps in the middle: whole-second majors with the half-second (15f) minors
    // the reference wears.
    expect(tickLadder(60, 120)).toEqual({ majorMs: 1_000, minorMs: 500 });
  });

  it("holds its widths at every scale it can be asked for", () => {
    for (const fps of [24, 30, 60]) {
      for (const pxPerSec of [4, 7, 15, 30, 60, 120, 240, 480, 960]) {
        const { majorMs, minorMs } = tickLadder(fps, pxPerSec);
        const majorPx = widthPx(majorMs, pxPerSec);
        expect(majorPx).toBeGreaterThanOrEqual(MAJOR_TICK_MIN_PX);
        if (minorMs === null) continue;
        const minorPx = widthPx(minorMs, pxPerSec);
        expect(minorPx).toBeGreaterThanOrEqual(MINOR_TICK_MIN_PX);
        expect(minorPx).toBeLessThan(MAJOR_TICK_MIN_PX);
        expect(minorMs).toBeLessThan(majorMs);
      }
    }
  });
});

describe("hit testing", () => {
  const hit = (point: Point) => hitTest(cut(), VIEW, point);

  it("calls the ruler by its band", () => {
    expect(hit({ x: 100, y: RULER_H - 1 }).kind).toBe("ruler");
    expect(
      hitTest(buildTimelineMokaFile().timelines![0], VIEW, { x: 0, y: 0 }).kind,
    ).toBe("ruler");
  });

  it("finds the clip under the point, topmost row first", () => {
    const ids = cutFixtureIds();
    // The video row runs 120–184; the audio clip at the same x is behind it.
    const top = hit({ x: 60, y: 150 });
    expect(top).toMatchObject({ kind: "clip" });
    if (top.kind !== "clip") throw new Error("expected a clip");
    expect(top.clip.id).toBe(ids.clipA);

    const audio = hit({ x: 60, y: 90 });
    if (audio.kind !== "clip") throw new Error("expected a clip");
    expect(audio.clip.id).toBe(ids.clipC);

    const text = hit({ x: 60, y: 40 });
    if (text.kind !== "clip") throw new Error("expected a clip");
    expect(text.clip.id).toBe(ids.clipD);
  });

  it("gives the seam badge the point it sits on, ahead of both clips", () => {
    const ids = cutFixtureIds();
    // The seam centres on 240; the window under it is held by both clips.
    const seam = hit({ x: 240, y: 152 });
    expect(seam).toMatchObject({ kind: "transition" });
    if (seam.kind !== "transition") throw new Error("expected a transition");
    expect(seam.transition.id).toBe(ids.transition);
  });

  it("hands an overlapped point outside the badge to the clip drawn over it", () => {
    const ids = cutFixtureIds();
    // 225 is inside the window but clear of the 18px badge: the follower
    // starts later, draws later, and so is the one on top.
    const overlap = hit({ x: 225, y: 152 });
    if (overlap.kind !== "clip") throw new Error("expected a clip");
    expect(overlap.clip.id).toBe(ids.clipB);
  });

  it("names the row a point lands on when it lands on nothing", () => {
    const ids = cutFixtureIds();
    expect(hit({ x: 400, y: 40 })).toEqual({
      kind: "empty",
      trackId: ids.textTrack,
    });
    expect(hit({ x: 60, y: 200 })).toEqual({ kind: "empty", trackId: null });
  });

  describe("the seam an empty boundary offers", () => {
    /** The fixture with its transition taken out and its follower butted. */
    function butted(): TimelineDocument {
      const timeline = cut();
      const ids = cutFixtureIds();
      timeline.transitions = [];
      timeline.clips = timeline.clips.map((clip) =>
        clip.id === ids.clipB ? { ...clip, startMs: 4_000 } : clip,
      );
      return timeline;
    }

    it("calls a butted boundary within the six pixels its + reaches", () => {
      const ids = cutFixtureIds();
      const timeline = butted();
      // A runs 0–240 at 60px/s and B butts against it: the boundary is at 240.
      for (const x of [234, 240, 246]) {
        const seam = hitTest(timeline, VIEW, { x, y: 152 });
        expect(seam).toMatchObject({ kind: "seam" });
        if (seam.kind !== "seam") throw new Error("expected a seam");
        expect(seam.leader.id).toBe(ids.clipA);
        expect(seam.follower.id).toBe(ids.clipB);
      }
      // Outside the reach the blocks go back to being blocks.
      expect(hitTest(timeline, VIEW, { x: 233, y: 152 })).toMatchObject({
        kind: "clip",
      });
      expect(hitTest(timeline, VIEW, { x: 247, y: 152 })).toMatchObject({
        kind: "clip",
      });
    });

    it("leaves other rows and pulled-back seams alone", () => {
      // The audio row's single clip has no neighbour to be butted against.
      expect(hitTest(butted(), VIEW, { x: 240, y: 90 }).kind).toBe("clip");
      // The cut fixture's seam carries a transition, so its clips are pulled
      // back and there is no boundary left to lay anything on.
      expect(hitTest(cut(), VIEW, { x: 240, y: 152 }).kind).toBe("transition");
    });
  });
});

describe("the edges a pointer can catch", () => {
  const clip = () => cut().clips[0];

  it("calls an edge within its own margin and the body beyond it", () => {
    const rows = trackRows(cut());
    // The block runs 0–240 at 60px/s; six pixels either side is the margin.
    expect(edgeAt(clip(), rows, VIEW, 0)).toBe("start");
    expect(edgeAt(clip(), rows, VIEW, CLIP_EDGE_PX)).toBe("start");
    expect(edgeAt(clip(), rows, VIEW, 240)).toBe("end");
    expect(edgeAt(clip(), rows, VIEW, 240 - CLIP_EDGE_PX)).toBe("end");
    expect(edgeAt(clip(), rows, VIEW, 120)).toBeNull();
    expect(edgeAt(clip(), rows, VIEW, CLIP_EDGE_PX + 1)).toBeNull();
  });

  it("gives a block narrower than its two margins the nearer edge", () => {
    const rows = trackRows(cut());
    const tiny = { ...clip(), durationMs: 100 };
    // 100ms at 60px/s is six pixels wide: both edges want every point in it.
    expect(edgeAt(tiny, rows, VIEW, 0)).toBe("start");
    expect(edgeAt(tiny, rows, VIEW, 6)).toBe("end");
    expect(edgeAt(tiny, rows, VIEW, 3)).toBe("start");
  });
});

describe("content and zoom arithmetic", () => {
  it("runs at least the floor, plus room past the end", () => {
    expect(contentMs(createTimeline("Empty"), 0)).toBe(
      MIN_CONTENT_MS + TAIL_MS,
    );
    // The cut is only 8s long, so the 30s floor is what the room shows.
    expect(contentMs(cut(), 0)).toBe(MIN_CONTENT_MS + TAIL_MS);
    // A playhead past the floor is what the room reaches to.
    expect(contentMs(cut(), 90_000)).toBe(94_000);
    expect(contentWidth(cut(), 0, 60)).toBe(2_040);
    expect(contentHeight(cut())).toBe(184);
  });

  it("holds the playhead still while it is on screen, the screen's middle otherwise", () => {
    expect(zoomAnchorMs(VIEW, 800, 5_000)).toBe(5_000);
    const scrolled = { pxPerSec: 60, scrollLeftPx: 9_000 };
    expect(zoomAnchorMs(scrolled, 800, 5_000)).toBeCloseTo(
      msAt(400, scrolled),
      6,
    );
  });

  it("puts the anchor back where it was, and keeps the scroll inside the content", () => {
    const next = viewAfterZoom(90, 800, 5_000, 34_000);
    expect(next.scrollLeftPx).toBe(50);
    expect(xAt(5_000, next)).toBeCloseTo(400);
    // 33s of anchor wants a further offset than 34s of content at 90px/s allows.
    const clamped = viewAfterZoom(90, 800, 33_000, 34_000);
    expect(clamped.scrollLeftPx).toBe(2_260);
    // Content narrower than the screen cannot be scrolled at all.
    expect(viewAfterZoom(4, 800, 5_000, 34_000).scrollLeftPx).toBe(0);
  });

  it("keeps the scale inside the room it may take", () => {
    expect(clampPxPerSec(1)).toBe(MIN_PX_PER_SEC);
    expect(clampPxPerSec(10_000)).toBe(MAX_PX_PER_SEC);
    expect(clampPxPerSec(90.123_456)).toBe(90.12);
    expect(clampPxPerSec(Number.NaN)).toBe(DEFAULT_PX_PER_SEC);
  });

  it("ends the cut at the last tail on a row that draws", () => {
    // The cut fixture runs to 8s: the video track's follower is pulled back
    // into its seam and the audio track runs the full length.
    expect(cutEndMs(cut())).toBe(8_000);
    const trackless = { ...createTimeline("Trackless"), clips: cut().clips };
    expect(cutEndMs(trackless)).toBe(0);
    // A hidden row does not draw, so its clips are not where the cut ends.
    const hidden = cut();
    expect(
      cutEndMs({
        ...hidden,
        tracks: hidden.tracks.map((track) =>
          track.id === cutFixtureIds().audioTrack
            ? { ...track, hidden: true }
            : track,
        ),
      }),
    ).toBe(5_500);
  });
});

describe("the timeline fixture's own rows", () => {
  it("matches the plan's Text/Audio/Video order", () => {
    const timeline = buildTimelineMokaFile().timelines![0];
    const rows = trackRows(timeline);
    expect(rows.map((row) => row.track.id)).toEqual([
      timelineIds().textTrack,
      timelineIds().audioTrack,
      timelineIds().videoTrack,
    ]);
  });
});
