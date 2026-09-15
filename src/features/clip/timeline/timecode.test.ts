import { describe, expect, it } from "vitest";
import { formatTickLabel, formatTimecode } from "./timecode";

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
