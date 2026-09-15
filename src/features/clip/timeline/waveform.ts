/**
 * A sound's own shape, measured into buckets and read back a column at a time.
 *
 * The timeline never holds a sound's samples: it holds the low and high sample
 * of each bucket — fifty a second, which is more detail than any block of a cut
 * can show — and draws vertical spans from them. Everything here is pure so
 * what a block looks like can be tested without a sound, an element, or a
 * browser: the buffer is asked for its shape through the narrow interface
 * below, which an `AudioBuffer` answers by itself.
 */

/** How many buckets a second of material is measured in. */
export const PEAKS_PER_SECOND = 50;

/**
 * The most buckets one asset may be measured into.
 *
 * Ten minutes at fifty a second is thirty thousand buckets — well over a
 * megabyte for a cache nothing persists — so a longer file is measured at a
 * lower rate rather than into an array nobody asked to pay for.
 */
export const MAX_PEAKS = 20_000;

/** The low and high sample of each bucket, interleaved min then max, in -1..1. */
export interface WaveformPeaks {
  /** The rate the buckets were measured at, after any lowering. */
  perSecond: number;
  /** How many buckets there are. */
  count: number;
  /** The buckets themselves: `minMax[2i]` is the low, `minMax[2i + 1]` the high. */
  minMax: Float32Array;
}

/** What a sound has to answer for its shape to be read; an AudioBuffer does. */
export interface PcmBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}

/** The channels mixed to one reading, which is what a waveform is drawn from. */
function mixedSample(
  buffer: PcmBuffer,
  channels: number,
  index: number,
): number {
  if (channels === 1) return buffer.getChannelData(0)[index];
  let sum = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    sum += buffer.getChannelData(channel)[index];
  }
  return sum / channels;
}

/**
 * A buffer's shape as buckets of min and max.
 *
 * Stereo is mixed to one reading rather than drawn twice — a timeline block is
 * one line of sound — and a file long enough to cross the ceiling is measured
 * at whatever rate fits under it, so the array is bounded whatever is handed in.
 */
export function peaksFromBuffer(
  buffer: PcmBuffer,
  perSecond: number = PEAKS_PER_SECOND,
): WaveformPeaks {
  const rate =
    Number.isFinite(perSecond) && perSecond > 0 ? perSecond : PEAKS_PER_SECOND;
  const seconds =
    buffer.sampleRate > 0 && buffer.length > 0
      ? buffer.length / buffer.sampleRate
      : 0;
  const wanted = Math.max(1, Math.ceil(seconds * rate));
  const count = Math.min(wanted, MAX_PEAKS);
  const actualPerSecond = (rate * count) / wanted;
  const minMax = new Float32Array(count * 2);
  if (buffer.length <= 0 || seconds <= 0)
    return { perSecond: actualPerSecond, count, minMax };

  const channels = Math.max(1, buffer.numberOfChannels);
  const samplesPerBucket = buffer.length / count;
  for (let bucket = 0; bucket < count; bucket += 1) {
    const from = Math.floor(bucket * samplesPerBucket);
    const to = Math.min(
      buffer.length,
      Math.max(from + 1, Math.floor((bucket + 1) * samplesPerBucket)),
    );
    // The bucket's own reading, not a line through zero: a sound that never
    // crosses zero draws as the band it is.
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let index = from; index < to; index += 1) {
      const sample = mixedSample(buffer, channels, index);
      if (sample < low) low = sample;
      if (sample > high) high = sample;
    }
    minMax[bucket * 2] = Number.isFinite(low) ? low : 0;
    minMax[bucket * 2 + 1] = Number.isFinite(high) ? high : 0;
  }
  return { perSecond: actualPerSecond, count, minMax };
}

/** The bucket a material moment reads. */
export function bucketAtIndex(
  peaks: WaveformPeaks,
  materialMs: number,
): number {
  if (peaks.count <= 0) return 0;
  const bucket = Math.floor((materialMs / 1_000) * peaks.perSecond);
  return Math.min(peaks.count - 1, Math.max(0, bucket));
}

/** The span of buckets a drawing reads: `[from, to)`. */
export interface BucketSpan {
  from: number;
  to: number;
}

/** A sound cut into the columns a block draws. */
export interface WaveformColumns {
  /** The low sample each column draws, in -1..1. */
  min: Float32Array;
  /** The high sample each column draws. */
  max: Float32Array;
}

/**
 * Peaks as pixel columns, over a span of the material's own buckets.
 *
 * Fewer columns than buckets take the envelope of everything they cover — the
 * lowest low and the highest high — so a compressed block still shows the
 * shape it is compressing; more columns than buckets repeat each bucket for
 * the pixels it fills. The span is what makes a trimmed or sped-up clip draw
 * the piece of its file it actually reads rather than the whole file squeezed
 * into the block.
 */
export function downsample(
  peaks: WaveformPeaks,
  columns: number,
  span?: BucketSpan,
): WaveformColumns {
  const count = Math.max(1, Math.floor(columns));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  if (peaks.count <= 0) return { min, max };
  const from = Math.min(
    peaks.count - 1,
    Math.max(0, Math.floor(span?.from ?? 0)),
  );
  const to = Math.min(
    peaks.count,
    Math.max(from + 1, Math.ceil(span?.to ?? peaks.count)),
  );
  const perColumn = (to - from) / count;
  for (let column = 0; column < count; column += 1) {
    const first = from + Math.floor(column * perColumn);
    const last = Math.min(
      to,
      Math.max(first + 1, from + Math.ceil((column + 1) * perColumn)),
    );
    let low = peaks.minMax[first * 2];
    let high = peaks.minMax[first * 2 + 1];
    for (let bucket = first + 1; bucket < last; bucket += 1) {
      low = Math.min(low, peaks.minMax[bucket * 2]);
      high = Math.max(high, peaks.minMax[bucket * 2 + 1]);
    }
    min[column] = low;
    max[column] = high;
  }
  return { min, max };
}
