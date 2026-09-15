import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../../shared/domain";
import { materialMoment } from "../preview/compositor";
import {
  MAX_PEAKS,
  PEAKS_PER_SECOND,
  bucketAtIndex,
  downsample,
  peaksFromBuffer,
  type PcmBuffer,
} from "./waveform";

/** A buffer of one second at 1 kHz, its samples made by the given reading. */
function buffer(
  read: (index: number) => number,
  options: { seconds?: number; rate?: number; channels?: number } = {},
): PcmBuffer {
  const sampleRate = options.rate ?? 1_000;
  const channels = options.channels ?? 1;
  const length = Math.round((options.seconds ?? 1) * sampleRate);
  const data = Array.from({ length: channels }, () => {
    const channel = new Float32Array(length);
    for (let index = 0; index < length; index += 1)
      channel[index] = read(index);
    return channel;
  });
  return {
    sampleRate,
    numberOfChannels: channels,
    length,
    getChannelData: (channel) => data[channel],
  };
}

describe("measuring a sound into buckets", () => {
  it("takes the low and high of every bucket at fifty a second", () => {
    // A ramp from 0 to 1 across the second: the first bucket of twenty
    // samples rides its own stretch of the ramp.
    const peaks = peaksFromBuffer(buffer((index) => index / 1_000));
    expect(peaks.perSecond).toBe(PEAKS_PER_SECOND);
    expect(peaks.count).toBe(50);
    expect(peaks.minMax[0]).toBeCloseTo(0);
    expect(peaks.minMax[1]).toBeCloseTo(19 / 1_000);
    expect(peaks.minMax[98]).toBeCloseTo(980 / 1_000);
    expect(peaks.minMax[99]).toBeCloseTo(999 / 1_000);
  });

  it("mixes the channels into one line of sound", () => {
    const peaks = peaksFromBuffer(
      buffer((index) => (index < 10 ? 1 : -1), { channels: 2 }),
    );
    // Both channels carry the same reading, so the mix is that reading.
    expect(peaks.minMax[0]).toBeCloseTo(-1);
    expect(peaks.minMax[1]).toBeCloseTo(1);
    const opposite = peaksFromBuffer(buffer(() => 1, { channels: 2 }));
    expect(opposite.minMax[1]).toBeCloseTo(1);
    // Two channels pulling apart cancel where they meet in the middle.
    const cancelling = peaksFromBuffer({
      sampleRate: 1_000,
      numberOfChannels: 2,
      length: 20,
      getChannelData: (channel) =>
        Float32Array.from({ length: 20 }, () => (channel === 0 ? 1 : -1)),
    });
    expect(cancelling.minMax[0]).toBe(0);
    expect(cancelling.minMax[1]).toBe(0);
  });

  it("reads silence as a flat zero line", () => {
    const peaks = peaksFromBuffer(buffer(() => 0));
    expect(Array.from(peaks.minMax).every((value) => value === 0)).toBe(true);
  });

  it("lowers the bucket rate rather than crossing the ceiling", () => {
    // A thousand seconds at fifty a second wants fifty thousand buckets.
    const peaks = peaksFromBuffer(buffer(() => 0.5, { seconds: 1_000 }));
    expect(peaks.count).toBe(MAX_PEAKS);
    expect(peaks.perSecond).toBeCloseTo(
      (PEAKS_PER_SECOND * MAX_PEAKS) / 50_000,
      5,
    );
    expect(peaks.minMax[1]).toBeCloseTo(0.5);
  });

  it("has a bucket for a buffer with nothing in it", () => {
    const peaks = peaksFromBuffer(buffer(() => 0, { seconds: 0 }));
    expect(peaks.count).toBe(1);
    expect(peaks.minMax.length).toBe(2);
  });
});

describe("cutting peaks into pixel columns", () => {
  /** Four buckets of a known shape: 0.5, then 0.25, then 0, then 1. */
  function four(): ReturnType<typeof peaksFromBuffer> {
    return {
      perSecond: 4,
      count: 4,
      minMax: new Float32Array([0.5, 0.5, 0.25, 0.25, 0, 0, 1, 1]),
    };
  }

  it("takes the envelope when there are fewer columns than buckets", () => {
    const { min, max } = downsample(four(), 2);
    expect(Array.from(min)).toEqual([0.25, 0]);
    expect(Array.from(max)).toEqual([0.5, 1]);
  });

  it("draws every bucket when there are more columns than buckets", () => {
    const { min, max } = downsample(four(), 8);
    expect(Array.from(min)).toEqual([0.5, 0.5, 0.25, 0.25, 0, 0, 1, 1]);
    expect(Array.from(max)).toEqual([0.5, 0.5, 0.25, 0.25, 0, 0, 1, 1]);
  });

  it("reads the span it is given, which is the piece of the file a clip uses", () => {
    const { min, max } = downsample(four(), 2, { from: 2, to: 4 });
    expect(Array.from(min)).toEqual([0, 1]);
    expect(Array.from(max)).toEqual([0, 1]);
  });

  it("answers a column for a degenerate span rather than nothing", () => {
    const { min, max } = downsample(four(), 3, { from: 1, to: 1 });
    expect(min.length).toBe(3);
    expect(Array.from(min)).toEqual([0.25, 0.25, 0.25]);
    expect(Array.from(max)).toEqual([0.25, 0.25, 0.25]);
  });

  it("draws a zero line for peaks with nothing in them", () => {
    const empty = { perSecond: 1, count: 0, minMax: new Float32Array(0) };
    const { min, max } = downsample(empty, 4);
    expect(Array.from(min)).toEqual([0, 0, 0, 0]);
    expect(Array.from(max)).toEqual([0, 0, 0, 0]);
  });
});

describe("reading a clip's waveform by its own material clock", () => {
  /** A clip at twice the pace over the material's opening four seconds. */
  function fastClip(): TimelineClip {
    return {
      id: "clip-a",
      trackId: "track-a",
      kind: "video",
      label: "closing.mp4",
      assetId: "asset-a",
      startMs: 0,
      durationMs: 2_000,
      inPointMs: 0,
      outPointMs: 4_000,
      speed: 2,
      volume: 1,
      fadeInMs: 0,
      fadeOutMs: 0,
      muted: false,
      opacity: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
  }

  it("samples the material, so a clip at twice the pace reads its file at that pace", () => {
    const clip = fastClip();
    const peaks = peaksFromBuffer(buffer(() => 0, { seconds: 10 }));
    // The block's right half is two seconds in, which is the material's fourth.
    expect(materialMoment(clip, 1_500)).toBe(3_000);
    expect(bucketAtIndex(peaks, materialMoment(clip, 1_500))).toBe(150);
    // The right half reads the material's back half: half the buckets or more.
    expect(bucketAtIndex(peaks, materialMoment(clip, 1_000))).toBe(100);
    expect(bucketAtIndex(peaks, materialMoment(clip, 2_000))).toBe(200);
    // A moment before the material holds its head rather than a negative bucket.
    expect(bucketAtIndex(peaks, -500)).toBe(0);
    // And past its tail holds the last bucket rather than running off the end.
    expect(bucketAtIndex(peaks, 60_000)).toBe(peaks.count - 1);
  });
});
