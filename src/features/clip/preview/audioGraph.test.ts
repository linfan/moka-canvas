import { describe, expect, it } from "vitest";
import type {
  TimelineClip,
  TimelineDocument,
  TimelineTrack,
  TimelineTransition,
} from "../../../shared/domain";
import {
  audibleClipsAt,
  clipGainAt,
  needsResync,
  transitionGain,
} from "./audioGraph";

const T0 = "2024-01-01T00:00:00.000Z";

/** A clip of the shape a gain question needs, wearing the fixtures' spelling. */
function clip(patch: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: "clip-a",
    trackId: "track-a",
    kind: "audio",
    label: "score.mp3",
    assetId: "asset-a",
    startMs: 0,
    durationMs: 4_000,
    inPointMs: 0,
    outPointMs: 4_000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    opacity: 1,
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

function track(patch: Partial<TimelineTrack> = {}): TimelineTrack {
  return {
    id: "track-a",
    kind: "audio",
    name: "Audio 1",
    muted: false,
    hidden: false,
    locked: false,
    createdAt: T0,
    ...patch,
  };
}

describe("the level a clip's sound carries", () => {
  it("is the clip's own volume where nothing fades", () => {
    expect(clipGainAt(clip({ volume: 1.5 }), track(), 2_000)).toBe(1.5);
  });

  it("walks the fade-in linearly to the clip's volume at its end", () => {
    const fading = clip({ volume: 1.5, fadeInMs: 1_000 });
    expect(clipGainAt(fading, track(), 0)).toBe(0);
    expect(clipGainAt(fading, track(), 500)).toBe(0.75);
    expect(clipGainAt(fading, track(), 1_000)).toBe(1.5);
    expect(clipGainAt(fading, track(), 3_000)).toBe(1.5);
  });

  it("walks the fade-out down to silence at the tail", () => {
    const fading = clip({ volume: 1, fadeOutMs: 1_000 });
    expect(clipGainAt(fading, track(), 3_000)).toBe(1);
    expect(clipGainAt(fading, track(), 3_500)).toBe(0.5);
    expect(clipGainAt(fading, track(), 4_000)).toBe(0);
  });

  it("reads a fade of no length as no fade, without dividing by it", () => {
    expect(clipGainAt(clip({ volume: 0.8, fadeInMs: 0 }), track(), 0)).toBe(
      0.8,
    );
  });

  it("is silence when the clip is muted", () => {
    expect(clipGainAt(clip({ muted: true }), track(), 2_000)).toBe(0);
  });

  it("is silence when the row is muted", () => {
    expect(clipGainAt(clip(), track({ muted: true }), 2_000)).toBe(0);
  });

  it("is silence for a clip the moment stands outside of", () => {
    const faded = clip({ volume: 1, fadeInMs: 500, fadeOutMs: 500 });
    expect(clipGainAt(faded, track(), -250)).toBe(0);
    expect(clipGainAt(faded, track(), 4_250)).toBe(0);
  });
});

describe("when a source is pulled back to the clock", () => {
  it("leaves a difference inside the tenth-second band alone", () => {
    expect(needsResync(1_000, 950)).toBe(false);
    expect(needsResync(1_000, 1_050)).toBe(false);
    expect(needsResync(1_000, 1_049)).toBe(false);
    expect(needsResync(1_000, 901)).toBe(false);
  });

  it("corrects a source that has drifted past it", () => {
    expect(needsResync(1_000, 900)).toBe(true);
    expect(needsResync(1_000, 1_100)).toBe(true);
    expect(needsResync(1_000, 400)).toBe(true);
    expect(needsResync(1_000, 4_000)).toBe(true);
  });
});

describe("the share a seam window gives each side", () => {
  it("crosses linearly, meeting at the middle", () => {
    expect(transitionGain(0.5, "leader")).toBe(0.5);
    expect(transitionGain(0.5, "follower")).toBe(0.5);
  });

  it("sits at the ends: the leader whole at 0, the follower whole at 1", () => {
    expect(transitionGain(0, "leader")).toBe(1);
    expect(transitionGain(0, "follower")).toBe(0);
    expect(transitionGain(1, "leader")).toBe(0);
    expect(transitionGain(1, "follower")).toBe(1);
  });

  it("leaves a moment outside every window alone", () => {
    expect(transitionGain(null, "leader")).toBe(1);
    expect(transitionGain(null, "follower")).toBe(1);
  });
});

describe("the clips that sound at a moment", () => {
  /** One audio track whose A and B are joined by a 500ms seam. */
  function seamed(): TimelineDocument {
    return {
      id: "timeline-1",
      name: "Cut",
      schemaVersion: 1,
      settings: { fps: 30, width: 1920, height: 1080, background: "#000000" },
      tracks: [track()],
      clips: [
        clip({ id: "a", startMs: 0, durationMs: 4_000 }),
        clip({ id: "b", startMs: 3_500, durationMs: 2_000 }),
      ],
      transitions: [
        {
          id: "s1",
          afterClipId: "a",
          kind: "crossfade",
          durationMs: 500,
          createdAt: T0,
        } satisfies TimelineTransition,
      ],
      createdAt: T0,
      updatedAt: T0,
    };
  }

  it("sounds the two sides of a window together, nearest first", () => {
    // 3,700 is inside the window [3,500, 4,000): both sides are heard.
    expect(
      audibleClipsAt(seamed(), 3_700).map((entry) => entry.clip.id),
    ).toEqual(["b", "a"]);
    // Before the window only the leader sounds; after it, only the follower.
    expect(
      audibleClipsAt(seamed(), 1_000).map((entry) => entry.clip.id),
    ).toEqual(["a"]);
    expect(
      audibleClipsAt(seamed(), 4_500).map((entry) => entry.clip.id),
    ).toEqual(["b"]);
  });

  it("leaves a muted side out of the window's pair", () => {
    const timeline = seamed();
    timeline.clips = timeline.clips.map((entry) =>
      entry.id === "b" ? { ...entry, muted: true } : entry,
    );
    expect(
      audibleClipsAt(timeline, 3_700).map((entry) => entry.clip.id),
    ).toEqual(["a"]);
  });
});
