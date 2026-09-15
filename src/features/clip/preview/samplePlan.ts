import type { Mp4Sample, Mp4VideoTrack } from "./mp4";

/**
 * Which samples a moment needs and which bytes hold them.
 *
 * Decoding does not begin at the frame that shows: it begins at the last
 * keyframe before it and walks forward, so the plan is the two of them and
 * everything between. The times are the samples' own, read as presentation
 * times — a moment between two frames shows the earlier one, which is what a
 * viewer sees — and the byte range runs from the first planned sample to the
 * last, fetched as one window.
 */

/** One sample as the decoder will be handed it. */
export interface SampleChunk {
  /** Where the sample's bytes start, from the head of the file. */
  offset: number;
  size: number;
  dtsUs: number;
  ctsUs: number;
  key: boolean;
}

export interface SamplePlan {
  /** The sample that shows the moment asked for. */
  target: number;
  /** The keyframe the walk starts from, at or before the target in decode order. */
  sync: number;
  /** The byte range to fetch: the first planned sample's first byte to the last one's last. */
  startOffset: number;
  endOffset: number;
  /** The samples to hand over, in decode order, the target last. */
  chunks: SampleChunk[];
}

/**
 * The sample that shows a moment: the last one whose presentation time has
 * arrived. A moment before the first sample shows the first — a preview of a
 * file's head is the head, not a blank.
 */
export function sampleAt(samples: Mp4Sample[], materialMs: number): number {
  if (samples.length === 0) return -1;
  const targetUs = Math.round(materialMs * 1_000);
  let best = 0;
  let bestUs = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < samples.length; index += 1) {
    const cts = samples[index].ctsUs;
    if (cts <= targetUs && cts > bestUs) {
      best = index;
      bestUs = cts;
    }
  }
  return best;
}

/** The plan for a moment of the material, or null for a track with nothing in it. */
export function planFor(
  video: Pick<Mp4VideoTrack, "samples">,
  materialMs: number,
): SamplePlan | null {
  const { samples } = video;
  if (samples.length === 0) return null;
  const target = sampleAt(samples, materialMs);
  // Back to the keyframe: a sample that decodes from itself starts the walk.
  let sync = target;
  while (sync > 0 && !samples[sync].key) sync -= 1;

  const chunks: SampleChunk[] = [];
  let startOffset = Number.POSITIVE_INFINITY;
  let endOffset = 0;
  for (let index = sync; index <= target; index += 1) {
    const sample = samples[index];
    chunks.push({
      offset: sample.offset,
      size: sample.size,
      dtsUs: sample.dtsUs,
      ctsUs: sample.ctsUs,
      key: sample.key,
    });
    startOffset = Math.min(startOffset, sample.offset);
    endOffset = Math.max(endOffset, sample.offset + sample.size);
  }
  return { target, sync, startOffset, endOffset, chunks };
}
