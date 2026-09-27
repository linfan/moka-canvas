import { describe, expect, it } from "vitest";
import { wheelZoomFactor } from "./camera";

describe("stepping the zoom with the wheel", () => {
  it("rolls forward to zoom in and back to zoom out", () => {
    expect(wheelZoomFactor(-100, false, 1)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false, 1)).toBeLessThan(1);
  });

  it("takes a quarter of a step while the fine modifier is held", () => {
    const coarse = wheelZoomFactor(-100, false, 1);
    const fine = wheelZoomFactor(-100, true, 1);
    expect(fine).toBeCloseTo(Math.pow(coarse, 0.25), 12);
    // Still forward, just shorter: a fine step never turns the wheel around.
    expect(fine).toBeGreaterThan(1);
  });

  it("steps further the more canvas the viewport holds", () => {
    const detail = wheelZoomFactor(-100, false, 4);
    const even = wheelZoomFactor(-100, false, 1);
    const wide = wheelZoomFactor(-100, false, 0.1);
    expect(even).toBeGreaterThan(detail);
    expect(wide).toBeGreaterThan(even);
  });

  it("keeps the step short once a detail is under the eye", () => {
    // Forward all the same — a short step is a slow approach, not a reversal.
    const detail = wheelZoomFactor(-100, false, 5);
    expect(detail).toBeGreaterThan(1);
    expect(detail).toBeLessThan(wheelZoomFactor(-100, false, 1));
  });
});
