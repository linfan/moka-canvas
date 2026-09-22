import { describe, expect, it } from "vitest";
import type { TimelineClip, TimelineDocument } from "../../../shared/domain";
import { frameAligned } from "../timeline/timecode";
import { sourceClip, timelineCues, windowOfClip } from "./transcribe";

/**
 * Putting a transcript back on the cut.
 *
 * The numbers here are the whole point of the module: a recognizer answers in
 * milliseconds from the beginning of the audio it was sent, and a timeline
 * holds moments of its own. Every case states where the clip stands, what
 * speed it plays at, and where the cue has to land.
 */

const FPS = 30;

/** An audio clip reading `durationMs` of a file from its own second in. */
function clip(over: Partial<TimelineClip> = {}): TimelineClip {
  const inPointMs = over.inPointMs ?? 0;
  const outPointMs = over.outPointMs ?? inPointMs + 10_000;
  const speed = over.speed ?? 1;
  return {
    id: "clip-a",
    trackId: "track-audio",
    kind: "audio",
    label: "take-1.wav",
    assetId: "asset-1",
    startMs: 0,
    durationMs: frameAligned((outPointMs - inPointMs) / speed, FPS),
    inPointMs,
    outPointMs,
    speed,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const cue = (startMs: number, endMs: number, text = "cue") => ({
  startMs,
  endMs,
  text,
});

/** A cut holding one audio clip and one text clip, in that track order. */
function cutWith(clips: TimelineClip[]): TimelineDocument {
  return {
    id: "timeline-1",
    name: "Cut 1",
    schemaVersion: 1,
    settings: { fps: FPS, width: 1920, height: 1080, background: "#000000" },
    tracks: [
      {
        id: "track-audio",
        kind: "audio",
        name: "Audio 1",
        muted: false,
        hidden: false,
        locked: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "track-text",
        kind: "text",
        name: "Text 1",
        muted: false,
        hidden: false,
        locked: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    clips,
    transitions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("windowOfClip", () => {
  it("is the material the clip reads, not where the clip stands", () => {
    const held = clip({ startMs: 7_000, inPointMs: 500, outPointMs: 2_500 });
    expect(windowOfClip(held)).toEqual({ startMs: 500, durationMs: 2_000 });
  });

  it("reads an out point that is somehow before the in point as nothing", () => {
    const held = clip({ inPointMs: 900, outPointMs: 400 });
    expect(windowOfClip(held).durationMs).toBe(0);
  });
});

describe("sourceClip", () => {
  it("takes the selection outright, whenever it stands", () => {
    const chosen = clip({ id: "chosen", startMs: 9_000, outPointMs: 10_000 });
    const timeline = cutWith([clip({ id: "other" }), chosen]);
    expect(sourceClip(timeline, ["chosen"], 0)?.id).toBe("chosen");
  });

  it("falls back to what the playhead stands on", () => {
    const timeline = cutWith([
      clip({
        id: "under-playhead",
        startMs: 1_000,
        inPointMs: 0,
        outPointMs: 2_000,
      }),
    ]);
    expect(sourceClip(timeline, [], 1_500)?.id).toBe("under-playhead");
    // The moment it closes is not a moment it holds.
    expect(sourceClip(timeline, [], 3_000)).toBeNull();
  });

  it("passes over words, and over a shot the caller knows is a still", () => {
    const timeline = cutWith([
      clip({ id: "shot", kind: "video", startMs: 0, outPointMs: 4_000 }),
      clip({
        id: "words",
        kind: "text",
        assetId: undefined,
        startMs: 5_000,
        outPointMs: 6_000,
      }),
    ]);
    expect(sourceClip(timeline, [], 1_000)?.id).toBe("shot");
    // A word clip holds nothing to listen to, so the shot the playhead stands
    // on answers instead of it — the selection names a page, not a sound.
    expect(sourceClip(timeline, ["words"], 1_000)?.id).toBe("shot");
    // Standing on the words there is nothing to hear at all.
    expect(sourceClip(timeline, [], 5_500)).toBeNull();
    // A picture rides the video track and looks like a shot; what tells them
    // apart is the file behind it, which the caller reads from the registry.
    expect(sourceClip(timeline, [], 1_000, () => false)).toBeNull();
    expect(sourceClip(timeline, ["shot"], 1_000, () => false)).toBeNull();
  });
});

describe("timelineCues", () => {
  it("measures the cue from the clip's own start", () => {
    const held = clip({ startMs: 5_000, inPointMs: 2_000, outPointMs: 6_000 });
    const cues = timelineCues(
      [cue(0, 1_000, "one"), cue(1_000, 2_500, "two")],
      held,
      FPS,
    );
    expect(cues).toEqual([
      { startMs: 5_000, endMs: 6_000, text: "one" },
      { startMs: 6_000, endMs: 7_500, text: "two" },
    ]);
  });

  it("gives a sped-up clip less timeline per second of recording", () => {
    // Twice as fast: a second of the recording is half a second of the cut.
    const held = clip({ speed: 2, inPointMs: 0, outPointMs: 10_000 });
    expect(held.durationMs).toBe(5_000);
    const cues = timelineCues(
      [cue(0, 2_000, "one"), cue(2_000, 4_000, "two")],
      held,
      FPS,
    );
    expect(cues).toEqual([
      { startMs: 0, endMs: 1_000, text: "one" },
      { startMs: 1_000, endMs: 2_000, text: "two" },
    ]);
  });

  it("puts both ends on the frame clock", () => {
    const held = clip({ startMs: 1_000, inPointMs: 0, outPointMs: 4_000 });
    const cues = timelineCues([cue(1_010, 3_016)], held, FPS);
    expect(cues[0].startMs).toBe(frameAligned(2_010, FPS));
    expect(cues[0].startMs).toBe(2_000);
    expect(cues[0].endMs).toBe(frameAligned(4_016, FPS));
    expect(cues[0].endMs).toBe(4_000);
  });

  it("drops a cue that begins past the window and cuts one that overhangs", () => {
    const held = clip({ inPointMs: 0, outPointMs: 2_000 });
    const cues = timelineCues(
      [
        cue(0, 1_000, "kept"),
        cue(1_500, 5_000, "cut"),
        cue(2_500, 3_000, "past"),
      ],
      held,
      FPS,
    );
    expect(cues).toEqual([
      { startMs: 0, endMs: 1_000, text: "kept" },
      { startMs: 1_500, endMs: 2_000, text: "cut" },
    ]);
  });

  it("clamps a cue that would run into the one after it", () => {
    const held = clip({ inPointMs: 0, outPointMs: 10_000 });
    const cues = timelineCues(
      [cue(0, 5_000, "long"), cue(3_000, 6_000, "late")],
      held,
      FPS,
    );
    // A track holds one thing at a time, and the recognizer's own beginning is
    // what decides where the boundary goes.
    expect(cues).toEqual([
      { startMs: 0, endMs: 3_000, text: "long" },
      { startMs: 3_000, endMs: 6_000, text: "late" },
    ]);
  });

  it("keeps nothing that is too short to be seen, before or after clamping", () => {
    const held = clip({ inPointMs: 0, outPointMs: 10_000 });
    const cues = timelineCues(
      [
        // Rounds up to one frame at 25 fps, which is no time at all.
        cue(0, 40, "blink"),
        // Long enough on its own, and clamped to a sliver by its neighbour.
        cue(1_000, 2_000, "squeezed"),
        cue(1_040, 3_000, "kept"),
      ],
      held,
      25,
    );
    expect(cues).toEqual([{ startMs: 1_040, endMs: 3_000, text: "kept" }]);
  });

  it("answers in time order whatever order the cues arrive in", () => {
    const held = clip({ inPointMs: 0, outPointMs: 10_000 });
    const cues = timelineCues(
      [cue(4_000, 5_000, "second"), cue(0, 1_000, "first")],
      held,
      FPS,
    );
    expect(cues.map((each) => each.text)).toEqual(["first", "second"]);
  });
});
