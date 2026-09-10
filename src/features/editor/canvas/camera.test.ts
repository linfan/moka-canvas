import { describe, expect, it } from "vitest";
import { wheelZoomFactor } from "./camera";

describe("stepping the zoom with the wheel", () => {
  it("rolls forward to zoom in and back to zoom out", () => {
    expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
  });

  it("takes a quarter of a step while the fine modifier is held", () => {
    const coarse = wheelZoomFactor(-100, false);
    const fine = wheelZoomFactor(-100, true);
    expect(fine).toBeCloseTo(Math.pow(coarse, 0.25), 12);
    // Still forward, just shorter: a fine step never turns the wheel around.
    expect(fine).toBeGreaterThan(1);
  });
});
