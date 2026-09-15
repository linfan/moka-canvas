import { describe, expect, it } from "vitest";
import { formatTickLabel, formatTimecode, frameAligned } from "./timecode";

describe("formatTimecode", () => {
  it("reads the head as all zeroes", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
  });

  it("rounds to the nearest frame, carrying into the next second", () => {
    expect(formatTimecode(33, 30)).toBe("00:00:00:01");
    // 1.016s is 30.48 frames: the frame that is 1.016s is the next second's first.
    expect(formatTimecode(1_016, 30)).toBe("00:00:01:00");
    expect(formatTimecode(999, 30)).toBe("00:00:01:00");
    expect(formatTimecode(1_999, 30)).toBe("00:00:02:00");
  });

  it("counts at whatever rate the document cuts at", () => {
    expect(formatTimecode(1_000, 24)).toBe("00:00:01:00");
    expect(formatTimecode(500, 24)).toBe("00:00:00:12");
    expect(formatTimecode(1_016, 60)).toBe("00:00:01:01");
    expect(formatTimecode(500, 60)).toBe("00:00:00:30");
  });

  it("crosses an hour into hh", () => {
    expect(formatTimecode(3_723_000, 30)).toBe("01:02:03:00");
    expect(formatTimecode(3_600_000, 30)).toBe("01:00:00:00");
  });

  it("holds a moment before the head at the head", () => {
    expect(formatTimecode(-500, 30)).toBe("00:00:00:00");
  });
});

describe("frameAligned", () => {
  it("lands a moment on the frame the clock rounds it to", () => {
    // 30fps: 33.33ms a frame, so the moments between two frames lean to one.
    expect(frameAligned(0, 30)).toBe(0);
    expect(frameAligned(10, 30)).toBe(0);
    expect(frameAligned(20, 30)).toBe(33);
    expect(frameAligned(34, 30)).toBe(33);
    expect(frameAligned(999, 30)).toBe(1_000);
    expect(frameAligned(1_016, 30)).toBe(1_000);
  });

  it("counts at whatever rate the document cuts at", () => {
    expect(frameAligned(500, 24)).toBe(500);
    expect(frameAligned(600, 24)).toBe(583);
    expect(frameAligned(280, 25)).toBe(280);
    expect(frameAligned(50, 25)).toBe(40);
    expect(frameAligned(8, 60)).toBe(0);
    expect(frameAligned(9, 60)).toBe(17);
  });

  it("agrees with the clock it was taken from", () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const ms of [0, 1, 17, 33, 500, 999, 1_016, 2_500, 7_333]) {
        expect(formatTimecode(frameAligned(ms, fps), fps)).toBe(
          formatTimecode(ms, fps),
        );
      }
    }
  });

  it("holds a moment before the head at the head", () => {
    expect(frameAligned(-500, 30)).toBe(0);
  });
});

describe("formatTickLabel", () => {
  it("names a whole second as a clock", () => {
    expect(formatTickLabel(0, 30)).toBe("00:00");
    expect(formatTickLabel(1_000, 30)).toBe("00:01");
    expect(formatTickLabel(2_000, 30)).toBe("00:02");
    expect(formatTickLabel(62_000, 30)).toBe("01:02");
  });

  it("names part of a second by the frame it is on", () => {
    expect(formatTickLabel(500, 30)).toBe("15f");
    expect(formatTickLabel(33.333, 30)).toBe("1f");
    expect(formatTickLabel(250, 60)).toBe("15f");
  });

  it("adds the hour past one, without padding it", () => {
    expect(formatTickLabel(3_600_000, 30)).toBe("1:00:00");
    expect(formatTickLabel(3_723_000, 30)).toBe("1:02:03");
  });
});
