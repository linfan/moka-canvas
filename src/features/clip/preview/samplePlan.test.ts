import { describe, expect, it } from "vitest";
import type { Mp4Sample } from "./mp4";
import { planFor, sampleAt } from "./samplePlan";

/**
 * Choosing samples, against tables written by hand.
 *
 * What is being pinned here is arithmetic rather than a file: which frame a
 * moment lands on, where the walk back to a keyframe stops, and the byte range
 * the two of them span. The moments are the ones a playhead actually lands on,
 * including the ones that fall between frames.
 */

function sample(patch: Partial<Mp4Sample> & { ctsUs: number }): Mp4Sample {
  return {
    offset: patch.offset ?? 0,
    size: patch.size ?? 10,
    dtsUs: patch.dtsUs ?? patch.ctsUs,
    ctsUs: patch.ctsUs,
    key: patch.key ?? true,
  };
}

/** Frames a third of a second apart, as a 30fps camera writes them. */
function thirds(): Mp4Sample[] {
  return [0, 33_333, 66_667, 100_000].map((ctsUs, index) =>
    sample({ ctsUs, offset: 100 + index * 10 }),
  );
}

describe("finding the sample a moment shows", () => {
  it("takes the frame the moment has reached, not the one after it", () => {
    const samples = thirds();
    expect(sampleAt(samples, 0)).toBe(0);
    expect(sampleAt(samples, 1)).toBe(0);
    expect(sampleAt(samples, 33)).toBe(0);
    expect(sampleAt(samples, 33.4)).toBe(1);
    expect(sampleAt(samples, 66)).toBe(1);
    expect(sampleAt(samples, 66.667)).toBe(2);
    expect(sampleAt(samples, 99)).toBe(2);
    expect(sampleAt(samples, 100)).toBe(3);
  });

  it("shows the first frame for a moment before it, and the last for one past it", () => {
    const samples = [sample({ ctsUs: 10_000 }), sample({ ctsUs: 20_000 })];
    expect(sampleAt(samples, 0)).toBe(0);
    expect(sampleAt(samples, -5)).toBe(0);
    expect(sampleAt(samples, 60_000)).toBe(1);
  });

  it("reads a table with no composition offsets by its decode times", () => {
    // cts equal to dts is what a table with no ctts box says.
    const samples = [0, 40_000, 80_000].map((us) => sample({ ctsUs: us }));
    expect(sampleAt(samples, 40)).toBe(1);
  });

  it("has nothing to say about an empty track", () => {
    expect(sampleAt([], 0)).toBe(-1);
    expect(planFor({ samples: [] }, 0)).toBeNull();
  });
});

describe("planning the bytes a moment needs", () => {
  it("walks back to the keyframe the target decodes from", () => {
    const samples = [
      sample({ ctsUs: 0, offset: 100, key: true }),
      sample({ ctsUs: 10_000, offset: 110, key: false }),
      sample({ ctsUs: 20_000, offset: 120, key: false }),
      sample({ ctsUs: 30_000, offset: 130, key: false }),
    ];
    const plan = planFor({ samples }, 30_000 / 1000)!;
    expect(plan.target).toBe(3);
    expect(plan.sync).toBe(0);
    expect(plan.chunks).toHaveLength(4);
    expect(plan.chunks.map((chunk) => chunk.offset)).toEqual([
      100, 110, 120, 130,
    ]);
  });

  it("starts from a later keyframe when one is nearer the moment", () => {
    const samples = [
      sample({ ctsUs: 0, offset: 100, key: true }),
      sample({ ctsUs: 10_000, offset: 110, key: true }),
      sample({ ctsUs: 20_000, offset: 120, key: false }),
      sample({ ctsUs: 30_000, offset: 130, key: false }),
    ];
    const plan = planFor({ samples }, 30)!;
    expect(plan.sync).toBe(1);
    expect(plan.chunks.map((chunk) => chunk.offset)).toEqual([110, 120, 130]);
  });

  it("takes the byte range from the first planned sample to the last", () => {
    // Two chunks with other material between them: the window is one read.
    const samples = [
      sample({ ctsUs: 0, offset: 5000, size: 20, key: true }),
      sample({ ctsUs: 10_000, offset: 5100, size: 30, key: false }),
      sample({ ctsUs: 20_000, offset: 9000, size: 25, key: true }),
      sample({ ctsUs: 30_000, offset: 9100, size: 25, key: false }),
    ];
    const plan = planFor({ samples }, 30)!;
    expect(plan.startOffset).toBe(9000);
    expect(plan.endOffset).toBe(9125);
    expect(plan.chunks.map((chunk) => chunk.size)).toEqual([25, 25]);
    expect(plan.chunks[0].key).toBe(true);
    expect(plan.chunks[1].key).toBe(false);
  });

  it("starts at the head for a moment before the first sample", () => {
    const samples = [
      sample({ ctsUs: 5000, offset: 700, key: true }),
      sample({ ctsUs: 15_000, offset: 710, key: false }),
    ];
    const plan = planFor({ samples }, 0)!;
    expect(plan.target).toBe(0);
    expect(plan.sync).toBe(0);
    expect([plan.startOffset, plan.endOffset]).toEqual([700, 710]);
  });

  it("takes a sample that does not decode from itself as the walk's start when nothing better exists", () => {
    const samples = [sample({ ctsUs: 0, offset: 100, key: false })];
    const plan = planFor({ samples }, 0)!;
    expect(plan.sync).toBe(0);
    expect(plan.chunks).toHaveLength(1);
  });
});
