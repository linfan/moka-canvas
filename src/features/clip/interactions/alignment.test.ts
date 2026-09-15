import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../shared/domain";
import { alignMoves } from "./alignment";

/** A block with only the geometry alignment reads; the rest is filler. */
function block(id: string, startMs: number, durationMs: number): TimelineClip {
  return {
    id,
    trackId: "track-1",
    kind: "video",
    label: id,
    assetId: "asset-1",
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("aligning a selection to the left", () => {
  it("puts every head on the earliest one", () => {
    const moves = alignMoves(
      [block("a", 1_000, 500), block("b", 4_000, 500), block("c", 0, 500)],
      "left",
    );
    // The block already on the earliest head has nowhere to go.
    expect(moves).toEqual([
      { clipId: "a", startMs: 0 },
      { clipId: "b", startMs: 0 },
    ]);
  });

  it("has nothing to do when they already share a head", () => {
    expect(
      alignMoves([block("a", 500, 100), block("b", 500, 900)], "left"),
    ).toEqual([]);
  });
});

describe("distributing a selection evenly", () => {
  it("holds the two outer blocks and evens the gaps between them", () => {
    // 0–1,000 and 5,000–6,000 with a 1,000-wide block between: the run is
    // 6,000 long with 3,000 of blocks in it, so each gap is 1,500.
    const moves = alignMoves(
      [
        block("a", 0, 1_000),
        block("b", 1_500, 1_000),
        block("c", 5_000, 1_000),
      ],
      "distribute",
    );
    expect(moves).toEqual([{ clipId: "b", startMs: 2_500 }]);
  });

  it("has nothing to do when the gaps already match", () => {
    expect(
      alignMoves(
        [
          block("a", 0, 1_000),
          block("b", 2_000, 1_000),
          block("c", 4_000, 1_000),
        ],
        "distribute",
      ),
    ).toEqual([]);
  });

  it("needs three blocks to have gaps to even out", () => {
    expect(
      alignMoves(
        [block("a", 0, 1_000), block("b", 3_000, 1_000)],
        "distribute",
      ),
    ).toEqual([]);
  });
});

describe("joining a selection end to end", () => {
  it("runs the blocks together in the order they read", () => {
    const moves = alignMoves(
      [block("b", 4_000, 1_000), block("a", 0, 2_000), block("c", 9_000, 500)],
      "butted",
    );
    expect(moves).toEqual([
      { clipId: "b", startMs: 2_000 },
      { clipId: "c", startMs: 3_000 },
    ]);
  });

  it("has nothing to do when they are already end to end", () => {
    expect(
      alignMoves(
        [
          block("a", 0, 2_000),
          block("b", 2_000, 1_000),
          block("c", 3_000, 500),
        ],
        "butted",
      ),
    ).toEqual([]);
  });

  it("puts two blocks end to end, and one block is nothing to tidy", () => {
    expect(
      alignMoves([block("a", 0, 1_000), block("b", 5_000, 1_000)], "butted"),
    ).toEqual([{ clipId: "b", startMs: 1_000 }]);
    expect(alignMoves([block("a", 500, 1_000)], "left")).toEqual([]);
    expect(alignMoves([block("a", 500, 1_000)], "butted")).toEqual([]);
    expect(alignMoves([], "distribute")).toEqual([]);
  });
});
