import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coalescing } from "./canvasControl";

describe("holding a burst of small changes back for one redraw", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acts once for a burst, and once again for the next", () => {
    let acted = 0;
    const batched = coalescing(100, () => {
      acted += 1;
    });

    batched.fire();
    batched.fire();
    batched.fire();
    // Not yet: the burst is still arriving, and one pass at the end of it says
    // as much as three would.
    expect(acted).toBe(0);
    vi.advanceTimersByTime(100);
    expect(acted).toBe(1);

    batched.fire();
    vi.advanceTimersByTime(99);
    expect(acted).toBe(1);
    vi.advanceTimersByTime(1);
    expect(acted).toBe(2);
  });

  it("leaves nothing waiting to act once it is stopped", () => {
    let acted = 0;
    const batched = coalescing(100, () => {
      acted += 1;
    });

    batched.fire();
    batched.stop();
    vi.advanceTimersByTime(500);
    // The card it would have redrawn is gone with the canvas that held it.
    expect(acted).toBe(0);
  });
});
