import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSITION_MS,
  MIN_TRANSITION_MS,
  type TimelineClip,
  type TimelineDocument,
  type TimelineTransition,
  type TransitionKind,
} from "../../../shared/domain";
import {
  clampSeamMs,
  seamAddCommands,
  seamEditCommands,
  seamRemoveCommands,
  seamsOfTrack,
  suffixFrom,
} from "./transitions";

const T0 = "2026-01-01T00:00:00.000Z";

/** A clip of the identity the document holds: out − in = round(duration × speed). */
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

function transition(
  id: string,
  afterClipId: string,
  kind: TransitionKind,
  durationMs: number,
  createdAt = T0,
): TimelineTransition {
  return { id, afterClipId, kind, durationMs, createdAt };
}

/**
 * A chained cut: A runs 0–4,000; s1 pulls B back by 500 (B runs 3,500–4,700);
 * s2 pulls C back by 600 (C runs 4,100–5,100). Every record sits on its own
 * seam exactly as R1 promises.
 */
function chained(): TimelineDocument {
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
    clips: [
      clip("a", 0, 4_000),
      clip("b", 3_500, 1_200),
      clip("c", 4_100, 1_000),
    ],
    transitions: [
      transition("s1", "a", "crossfade", 500),
      transition("s2", "b", "dipToBlack", 600),
    ],
    createdAt: T0,
    updatedAt: T0,
  };
}

describe("the seams of one track", () => {
  it("reads its transitions left to right and leaves other tracks' out", () => {
    const timeline = chained();
    timeline.clips.push(clip("d", 0, 1_000, "track-other"));
    timeline.transitions.push(transition("s3", "d", "wipe", 300));
    expect(seamsOfTrack(timeline, "track-v").map((seam) => seam.id)).toEqual([
      "s1",
      "s2",
    ]);
    expect(
      seamsOfTrack(timeline, "track-other").map((seam) => seam.id),
    ).toEqual(["s3"]);
    // A transition whose leader has left the cut belongs to no track.
    timeline.transitions.push(transition("s4", "gone", "wipe", 300));
    expect(seamsOfTrack(timeline, "track-v").map((seam) => seam.id)).toEqual([
      "s1",
      "s2",
    ]);
  });
});

describe("the suffix a seam edit works on", () => {
  it("runs from the named seam to the end of the chain, in order", () => {
    expect(suffixFrom(chained(), "s1").map((seam) => seam.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("reads the last seam as a chain of its own", () => {
    expect(suffixFrom(chained(), "s2").map((seam) => seam.id)).toEqual(["s2"]);
  });

  it("reads an unknown id as no chain at all", () => {
    expect(suffixFrom(chained(), "gone")).toEqual([]);
  });
});

describe("clamping a window to what the document allows", () => {
  it("keeps the floor and the document's ceiling", () => {
    const timeline = chained();
    expect(clampSeamMs(timeline, "s1", 50)).toBe(MIN_TRANSITION_MS);
    expect(clampSeamMs(timeline, "s1", 750)).toBe(750);
    // Two four-second clips still cap at the document's own 2,000.
    const long: TimelineDocument = {
      ...timeline,
      clips: [clip("a", 0, 4_000), clip("b", 3_500, 4_000)],
      transitions: [transition("s1", "a", "crossfade", 500)],
    };
    expect(clampSeamMs(long, "s1", 90_000)).toBe(2_000);
  });

  it("never outlasts the shorter clip it joins", () => {
    // s1 joins A (4,000) and B (1,200): s2 joins B (1,200) and C (1,000).
    expect(clampSeamMs(chained(), "s1", 90_000)).toBe(1_200);
    expect(clampSeamMs(chained(), "s2", 90_000)).toBe(1_000);
  });

  it("rounds the asked window to a whole millisecond", () => {
    expect(clampSeamMs(chained(), "s1", 500.6)).toBe(501);
  });
});

describe("laying a transition on an empty seam", () => {
  it("builds one add command carrying the default window, clamped by both clips", () => {
    const timeline = chained();
    timeline.transitions = [];
    timeline.clips = [clip("a", 0, 4_000), clip("b", 4_000, 300)];
    const plan = seamAddCommands(timeline, "a", "crossfade", "new-1", T0);
    expect(plan).toMatchObject({
      ok: true,
      transition: {
        id: "new-1",
        afterClipId: "a",
        kind: "crossfade",
        durationMs: 300,
        createdAt: T0,
      },
    });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.commands).toEqual([
      {
        type: "addTransitions",
        timelineId: "timeline-1",
        transitions: [plan.transition],
      },
    ]);
    // The pull-back is the command's business: nothing here moves a clip.
    expect(plan.transition.durationMs).toBeLessThan(DEFAULT_TRANSITION_MS);
  });

  it("refuses a seam too short for even the smallest window", () => {
    const timeline = chained();
    timeline.transitions = [];
    timeline.clips = [clip("a", 0, 150), clip("b", 150, 150)];
    expect(seamAddCommands(timeline, "a", "crossfade", "new-1", T0)).toEqual({
      ok: false,
      reason: "too-short",
    });
  });

  it("refuses a pair that is not butted or not there", () => {
    const timeline = chained();
    timeline.transitions = [];
    // A gap between the two clips is a gap, not a seam.
    timeline.clips = [clip("a", 0, 4_000), clip("b", 4_100, 4_000)];
    expect(seamAddCommands(timeline, "a", "crossfade", "new-1", T0)).toEqual({
      ok: false,
      reason: "no-seam",
    });
    // A leader with nothing behind it has no seam either.
    expect(seamAddCommands(timeline, "b", "crossfade", "new-1", T0)).toEqual({
      ok: false,
      reason: "no-seam",
    });
    expect(seamAddCommands(timeline, "gone", "crossfade", "new-1", T0)).toEqual(
      {
        ok: false,
        reason: "no-seam",
      },
    );
  });
});

describe("changing a transition's kind or window", () => {
  it("takes the chain down and lays it back with the new kind, ids and dates kept", () => {
    const timeline = chained();
    const commands = seamEditCommands(timeline, "s1", { kind: "dipToWhite" });
    expect(commands).toEqual([
      {
        type: "removeTransitions",
        timelineId: "timeline-1",
        transitionIds: ["s1", "s2"],
      },
      {
        type: "addTransitions",
        timelineId: "timeline-1",
        transitions: [
          {
            id: "s1",
            afterClipId: "a",
            kind: "dipToWhite",
            durationMs: 500,
            createdAt: T0,
          },
          {
            id: "s2",
            afterClipId: "b",
            kind: "dipToBlack",
            durationMs: 600,
            createdAt: T0,
          },
        ],
      },
    ]);
  });

  it("measures the new window against the two clips it joins", () => {
    const commands = seamEditCommands(chained(), "s1", { durationMs: 90_000 });
    expect(commands?.[1]).toMatchObject({
      type: "addTransitions",
      transitions: [
        { id: "s1", durationMs: 1_200 },
        { id: "s2", durationMs: 600 },
      ],
    });
  });

  it("edits the last seam alone, in one command pair", () => {
    const commands = seamEditCommands(chained(), "s2", { durationMs: 900 });
    expect(commands).toEqual([
      {
        type: "removeTransitions",
        timelineId: "timeline-1",
        transitionIds: ["s2"],
      },
      {
        type: "addTransitions",
        timelineId: "timeline-1",
        transitions: [
          {
            id: "s2",
            afterClipId: "b",
            kind: "dipToBlack",
            durationMs: 900,
            createdAt: T0,
          },
        ],
      },
    ]);
  });

  it("carries a chain change as one left-to-right batch", () => {
    const commands = seamEditCommands(chained(), "s1", { durationMs: 800 });
    expect(commands?.[0]).toMatchObject({ transitionIds: ["s1", "s2"] });
    const added =
      commands?.[1].type === "addTransitions" ? commands[1].transitions : [];
    expect(added.map((seam) => seam.id)).toEqual(["s1", "s2"]);
    expect(added[0].durationMs).toBe(800);
  });

  it("sends nothing when neither kind nor window moved", () => {
    const timeline = chained();
    expect(
      seamEditCommands(timeline, "s1", {
        kind: "crossfade",
        durationMs: 500,
      }),
    ).toBeNull();
    expect(seamEditCommands(timeline, "s1", {})).toBeNull();
  });

  it("sends nothing for a transition the timeline does not hold", () => {
    expect(seamEditCommands(chained(), "gone", { durationMs: 700 })).toBeNull();
  });
});

describe("taking a transition out", () => {
  it("releases a lone seam with one remove command", () => {
    expect(seamRemoveCommands(chained(), "s2")).toEqual([
      {
        type: "removeTransitions",
        timelineId: "timeline-1",
        transitionIds: ["s2"],
      },
    ]);
  });

  it("re-lays the seams behind the removed one, in order", () => {
    expect(seamRemoveCommands(chained(), "s1")).toEqual([
      {
        type: "removeTransitions",
        timelineId: "timeline-1",
        transitionIds: ["s1", "s2"],
      },
      {
        type: "addTransitions",
        timelineId: "timeline-1",
        transitions: [
          {
            id: "s2",
            afterClipId: "b",
            kind: "dipToBlack",
            durationMs: 600,
            createdAt: T0,
          },
        ],
      },
    ]);
  });

  it("sends nothing for a transition the timeline does not hold", () => {
    expect(seamRemoveCommands(chained(), "gone")).toEqual([]);
  });
});
