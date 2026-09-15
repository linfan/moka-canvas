import { describe, expect, it } from "vitest";
import {
  newId,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTrack,
} from "../../../shared/domain";
import {
  buildCutMokaFile,
  cutFixtureIds,
} from "../../../shared/domain/fixtures";
import { RULER_H, trackRows } from "../timeline/geometry";
import { frameAligned } from "../timeline/timecode";
import {
  clipsInRect,
  marqueeRect,
  moveDraft,
  resolveRowDelta,
  trimDraft,
  type TrimMaterial,
} from "./gestures";
import { snapContext } from "./snapping";

function cut(): TimelineDocument {
  return buildCutMokaFile().timelines![0];
}

const VIEW = { pxPerSec: 60, scrollLeftPx: 0 };
const FPS = 30;

/** A material clip with the identity the document holds: out − in = round(duration × speed). */
function clipOn(
  track: TimelineTrack,
  patch: Partial<TimelineClip> = {},
): TimelineClip {
  const durationMs = patch.durationMs ?? 2_000;
  const speed = patch.speed ?? 1;
  const inPointMs = patch.inPointMs ?? 0;
  return {
    id: patch.id ?? newId(),
    trackId: track.id,
    kind: "video",
    label: "piece.mp4",
    assetId: patch.assetId ?? "asset-x",
    startMs: patch.startMs ?? 0,
    durationMs,
    inPointMs,
    outPointMs: inPointMs + Math.round(durationMs * speed),
    speed,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const MATERIAL: TrimMaterial = { ownClock: false, durationMs: null };
const STILL: TrimMaterial = { ownClock: true, durationMs: null };

function track(name: string, kind: TimelineTrack["kind"]): TimelineTrack {
  return {
    id: newId(),
    kind,
    name,
    muted: false,
    hidden: false,
    locked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("where a drag leaves its blocks", () => {
  it("shifts a same-track selection by one delta for all of it", () => {
    const timeline = cut();
    const video = timeline.tracks.find((each) => each.kind === "video")!;
    const a = clipOn(video, { id: "a", startMs: 0, durationMs: 4_000 });
    const b = clipOn(video, { id: "b", startMs: 4_000, durationMs: 2_000 });
    const draft = moveDraft({
      clips: [a, b],
      pressedId: "a",
      rows: trackRows(timeline),
      rowDelta: 0,
      deltaMs: 1_000,
      fps: FPS,
      ctx: snapContext(timeline, 0, ["a", "b"]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.clips.map((ghost) => ghost.startMs)).toEqual([1_000, 5_000]);
    expect(draft.rowTrackId).toBeNull();
  });

  it("stops the rigid group at the head of the cut", () => {
    const timeline = cut();
    const video = timeline.tracks[0];
    const a = clipOn(video, { id: "a", startMs: 500, durationMs: 1_000 });
    const b = clipOn(video, { id: "b", startMs: 2_000, durationMs: 1_000 });
    const draft = moveDraft({
      clips: [a, b],
      pressedId: "b",
      rows: trackRows(timeline),
      rowDelta: 0,
      deltaMs: -3_000,
      fps: FPS,
      ctx: snapContext(timeline, 0, ["a", "b"]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    // The earliest block lands on zero and the other keeps its two seconds.
    expect(draft.clips.map((ghost) => ghost.startMs)).toEqual([0, 1_500]);
  });

  it("keeps the frame when the delta is not a whole one", () => {
    const timeline = cut();
    const video = timeline.tracks[0];
    const a = clipOn(video, { id: "a", startMs: 0, durationMs: 1_000 });
    const draft = moveDraft({
      clips: [a],
      pressedId: "a",
      rows: trackRows(timeline),
      rowDelta: 0,
      deltaMs: 1_017,
      fps: FPS,
      ctx: snapContext(timeline, 0, ["a"]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.clips[0].startMs).toBe(frameAligned(1_017, FPS));
    expect(draft.clips[0].startMs % 1).toBe(0);
  });

  it("catches a moving edge on a candidate and says where it landed", () => {
    const timeline = cut();
    const video = timeline.tracks[0];
    const x = clipOn(video, { id: "x", startMs: 5_000, durationMs: 1_000 });
    const input = {
      clips: [x],
      pressedId: "x",
      rows: trackRows(timeline),
      rowDelta: 0,
      deltaMs: -1_020,
      fps: FPS,
      ctx: snapContext(timeline, 0, ["x"]),
      pxPerSec: 60,
    };
    // A's tail is at 4,000: 20ms away is inside the eight pixels at 60px/s.
    const caught = moveDraft({ ...input, snapEnabled: true });
    expect(caught.clips[0].startMs).toBe(4_000);
    expect(caught.guideMs).toBe(4_000);
    // With the magnet off the same drag lands where the pointer put it.
    const free = moveDraft({ ...input, snapEnabled: false });
    expect(free.clips[0].startMs).toBe(frameAligned(3_980, FPS));
    expect(free.guideMs).toBeNull();
  });

  it("lights the row a cross-track drag is landing on", () => {
    const timeline = cut();
    const second = track("Video 2", "video");
    timeline.tracks = [...timeline.tracks, second];
    const video = timeline.tracks.find((each) => each.kind === "video")!;
    const a = clipOn(video, { id: "a", startMs: 0, durationMs: 4_000 });
    const draft = moveDraft({
      clips: [a],
      pressedId: "a",
      rows: trackRows(timeline),
      rowDelta: -3,
      deltaMs: 0,
      fps: FPS,
      ctx: snapContext(timeline, 0, ["a"]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.clips[0].trackId).toBe(second.id);
    expect(draft.rowTrackId).toBe(second.id);
  });
});

describe("whether a group may change rows", () => {
  it("keeps the row when the kind does not match or the row is locked", () => {
    const timeline = cut();
    const rows = trackRows(timeline);
    const video = timeline.tracks[0];
    const audio = timeline.tracks[1];
    const a = clipOn(video, { id: "a", startMs: 0, durationMs: 1_000 });
    // The rows draw folded: video on the bottom, text over it, audio above.
    // A video block may not rise to the audio row (locked) nor to the text
    // row (kind), and a sound may not fall to the video row.
    expect(resolveRowDelta(rows, [a], -1)).toBe(0);
    expect(resolveRowDelta(rows, [a], -2)).toBe(0);
    const sound = { ...a, kind: "audio" as const, trackId: audio.id };
    expect(resolveRowDelta(rows, [sound], 1)).toBe(0);
    expect(resolveRowDelta(rows, [a, sound], 0)).toBe(0);
  });

  it("moves the whole group when every block has a row", () => {
    const timeline = cut();
    const second = track("Video 2", "video");
    timeline.tracks = [...timeline.tracks, second];
    const rows = trackRows(timeline);
    const video = timeline.tracks[0];
    const a = clipOn(video, { id: "a", startMs: 0, durationMs: 1_000 });
    const b = clipOn(video, { id: "b", startMs: 1_000, durationMs: 1_000 });
    expect(resolveRowDelta(rows, [a, b], -3)).toBe(-3);
    // One block with no row keeps all of them where they were.
    const sound = { ...a, id: "c", kind: "audio" as const };
    expect(resolveRowDelta(rows, [a, sound], -3)).toBe(0);
  });
});

describe("where a trim leaves the block", () => {
  it("opens a left edge further left and exposes material", () => {
    const video = cut().tracks[0];
    const clip = clipOn(video, {
      startMs: 2_000,
      durationMs: 2_000,
      inPointMs: 1_000,
      speed: 1,
    });
    const draft = trimDraft({
      clip,
      edge: "start",
      deltaMs: -500,
      fps: FPS,
      material: MATERIAL,
      ctx: snapContext(cut(), 0, [clip.id]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft).toEqual({
      startMs: 1_500,
      durationMs: 2_500,
      inPointMs: 500,
      outPointMs: 3_000,
      guideMs: null,
    });
  });

  it("stops a left edge at the material's head", () => {
    const video = cut().tracks[0];
    const clip = clipOn(video, {
      startMs: 2_000,
      durationMs: 2_000,
      inPointMs: 1_000,
      speed: 1,
    });
    const draft = trimDraft({
      clip,
      edge: "start",
      deltaMs: -1_500,
      fps: FPS,
      material: MATERIAL,
      ctx: snapContext(cut(), 0, [clip.id]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.startMs).toBe(1_000);
    expect(draft.inPointMs).toBe(0);
    expect(draft.durationMs).toBe(3_000);
    expect(draft.outPointMs).toBe(3_000);
  });

  it("stops a right edge at the file's measured end", () => {
    const video = cut().tracks[0];
    const clip = clipOn(video, {
      startMs: 2_000,
      durationMs: 2_000,
      inPointMs: 1_000,
      speed: 1,
    });
    const draft = trimDraft({
      clip,
      edge: "end",
      deltaMs: 5_000,
      fps: FPS,
      material: { ownClock: false, durationMs: 6_000 },
      ctx: snapContext(cut(), 0, [clip.id]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.durationMs).toBe(5_000);
    expect(draft.outPointMs).toBe(6_000);
  });

  it("leaves a picture free of any file's end", () => {
    const video = cut().tracks[0];
    const clip = clipOn(video, { startMs: 0, durationMs: 2_000 });
    const draft = trimDraft({
      clip,
      edge: "end",
      deltaMs: 9_000,
      fps: FPS,
      material: STILL,
      ctx: snapContext(cut(), 0, [clip.id]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.durationMs).toBe(11_000);
    expect(draft.inPointMs).toBe(0);
    expect(draft.outPointMs).toBe(11_000);
  });

  it("stops a block a whole frame short of closing", () => {
    const video = cut().tracks[0];
    const clip = clipOn(video, { startMs: 2_000, durationMs: 2_000 });
    const draft = trimDraft({
      clip,
      edge: "end",
      deltaMs: -100_000,
      fps: FPS,
      material: STILL,
      ctx: snapContext(cut(), 0, [clip.id]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.durationMs).toBe(100);
    expect(draft.durationMs).toBeGreaterThanOrEqual(100);
  });

  it("rounds the material window from the duration, whatever the speed", () => {
    const video = cut().tracks[0];
    const clip = clipOn(video, {
      startMs: 2_000,
      durationMs: 2_000,
      inPointMs: 1_000,
      speed: 1.5,
    });
    expect(clip.outPointMs).toBe(4_000);
    const draft = trimDraft({
      clip,
      edge: "end",
      deltaMs: 333,
      fps: FPS,
      material: MATERIAL,
      ctx: snapContext(cut(), 0, [clip.id]),
      pxPerSec: 60,
      snapEnabled: false,
    });
    expect(draft.durationMs).toBe(2_333);
    // The identity the document checks holds by construction.
    expect(Math.round(draft.durationMs * 1.5)).toBe(
      draft.outPointMs - draft.inPointMs,
    );
  });

  it("catches the trimmed edge on a candidate and holds the frame", () => {
    const timeline = cut();
    const video = timeline.tracks[0];
    const clip = clipOn(video, {
      id: "x",
      startMs: 2_000,
      durationMs: 1_950,
    });
    const draft = trimDraft({
      clip,
      edge: "end",
      deltaMs: 20,
      fps: FPS,
      material: STILL,
      ctx: snapContext(timeline, 0, ["x"]),
      pxPerSec: 60,
      snapEnabled: true,
    });
    // A's tail is at 4,000 and the dragged edge is 30ms short of it: caught.
    expect(draft.startMs + draft.durationMs).toBe(4_000);
    expect(draft.durationMs).toBe(2_000);
    expect(draft.guideMs).toBe(4_000);
    expect(frameAligned(draft.startMs, FPS)).toBe(draft.startMs);
  });
});

describe("the rectangle a marquee draws", () => {
  it("reads either direction as the same rectangle", () => {
    expect(marqueeRect({ x: 100, y: 40 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 80,
      height: 30,
    });
  });

  it("catches every block it overlaps and nothing else", () => {
    const timeline = cut();
    const rows = trackRows(timeline);
    const videoRow = rows.find((row) => row.track.kind === "video")!;
    const caught = clipsInRect(timeline, rows, VIEW, {
      x: 0,
      y: videoRow.top,
      width: 200,
      height: videoRow.height,
    });
    // A runs 0–240 and is caught; B starts at 210 and is not; the rows above
    // are outside the rectangle entirely.
    expect(caught).toEqual([cutFixtureIds().clipA]);
  });

  it("catches nothing with a rectangle that covers no ground", () => {
    const timeline = cut();
    expect(
      clipsInRect(timeline, trackRows(timeline), VIEW, {
        x: 60,
        y: RULER_H,
        width: 0,
        height: 0,
      }),
    ).toEqual([]);
  });
});
