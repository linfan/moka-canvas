import type { AssetId } from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { openMp4, readRange, type Mp4Index } from "./mp4";
import { planFor } from "./samplePlan";

/**
 * Frames straight out of the file, through WebCodecs.
 *
 * A decoder is asked for one frame at a time: the samples from a keyframe to
 * the moment are fetched as one window and handed over as chunks, the frame
 * that shows the moment is kept and the rest of the run is let go of as it
 * comes out. Two decoders are kept and shared, because a cut with two picture
 * tracks on screen at once is the case this exists for, and the frames
 * themselves live in a small cache with an eviction rule — dragging the
 * playhead across a second of video must not decode that second again for
 * every move of the pointer.
 *
 * An asset that cannot be decoded is remembered as such for the session, so
 * the element engine is asked for it rather than the same failure being
 * rediscovered on every frame. Frames belong to the cache: a caller draws from
 * one and never closes it.
 */

export interface DecodedPicture {
  frame: VideoFrame;
  /** What the display matrix asks for, in degrees; WebCodecs applies nothing itself. */
  rotationDeg: number;
}

const MAX_DECODERS = 2;
const MAX_CACHED_FRAMES = 240;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;
/** How many of the newest frames are never evicted: one frame's worth of pictures, at most. */
const FRESH_FRAMES = 8;
/** How long one decode may take before it is given up on and the asset sent to the elements. */
const DECODE_TIMEOUT_MS = 8_000;

interface Slot {
  decoder: VideoDecoder;
  /** Where the job in flight's frames are collected; null between jobs. */
  sink: ((frame: VideoFrame) => void) | null;
  /** The job in flight, which the next caller on this decoder waits behind. */
  busy: Promise<VideoFrame | null> | null;
  /** Whether the job in flight failed, which its own await cannot always say. */
  failed: boolean;
  usedAt: number;
}

const slots: Slot[] = [];
const cache = new Map<string, { frame: VideoFrame; bytes: number }>();
let cachedBytes = 0;
const elementOnly = new Set<AssetId>();

/** How big a frame is taken to be for the cache's ceiling. */
function frameBytes(frame: VideoFrame): number {
  try {
    // The frame's own answer, which some formats decline to give.
    return Math.max(0, frame.allocationSize());
  } catch {
    // A 4:2:0 plane and a half is what a decoded picture usually costs.
    return Math.round(frame.codedWidth * frame.codedHeight * 1.5);
  }
}

function cacheFrame(key: string, frame: VideoFrame): VideoFrame {
  const kept = cache.get(key);
  if (kept) {
    cache.delete(key);
    cachedBytes -= kept.bytes;
    kept.frame.close();
  }
  const bytes = frameBytes(frame);
  cache.set(key, { frame, bytes });
  cachedBytes += bytes;
  // Evicted oldest first, never one of the newest few — a composition in
  // flight may be holding those, and a frame handed to a caller is only
  // closed once nobody is drawing from it.
  const protectedKeys = new Set([...cache.keys()].slice(-FRESH_FRAMES));
  for (const [oldestKey, oldest] of [...cache]) {
    if (cache.size <= MAX_CACHED_FRAMES && cachedBytes <= MAX_CACHED_BYTES)
      break;
    if (protectedKeys.has(oldestKey)) continue;
    cache.delete(oldestKey);
    cachedBytes -= oldest.bytes;
    oldest.frame.close();
  }
  return frame;
}

function cached(key: string): VideoFrame | undefined {
  const kept = cache.get(key);
  if (!kept) return undefined;
  // A hit is the newest thing in the cache, so the sweep takes other frames first.
  cache.delete(key);
  cache.set(key, kept);
  return kept.frame;
}

function openSlot(): Slot {
  const slot: Slot = {
    decoder: null as unknown as VideoDecoder,
    sink: null,
    busy: null,
    failed: false,
    usedAt: 0,
  };
  slot.decoder = new VideoDecoder({
    // A frame that arrives with no job waiting for it is one nobody kept.
    output: (frame) => (slot.sink ? slot.sink(frame) : frame.close()),
    error: () => {
      // The failure is read from the job's own await, which is where it can be acted on.
      slot.failed = true;
    },
  });
  return slot;
}

/** A decoder to work on: an idle one, a free pool place, or the one idle longest. */
async function takeSlot(): Promise<Slot> {
  for (;;) {
    const idle = slots.filter((slot) => slot.busy === null);
    if (idle.length > 0) {
      const slot = idle.reduce((a, b) => (a.usedAt <= b.usedAt ? a : b));
      slot.usedAt = Date.now();
      return slot;
    }
    if (slots.length < MAX_DECODERS) {
      const slot = openSlot();
      slots.push(slot);
      slot.usedAt = Date.now();
      return slot;
    }
    // Both are working: wait for whichever finishes first, then look again.
    await Promise.race(slots.map((slot) => slot.busy ?? Promise.resolve()));
  }
}

/** A decoder that has stopped answering is closed and taken out of the pool. */
function dropSlot(slot: Slot): void {
  const at = slots.indexOf(slot);
  if (at >= 0) slots.splice(at, 1);
  try {
    slot.decoder.close();
  } catch {
    // A decoder already closed by its own error has nothing left to close.
  }
}

/** A promise, or null once the clock runs out: a decoder that stops answering is not waited on forever. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Where the reader is told the frames of an asset are out of reach. */
function elementOnlyNow(assetId: AssetId): void {
  elementOnly.add(assetId);
}

/** Whether decode has been ruled out for an asset this session. */
export function isElementOnly(assetId: AssetId): boolean {
  return elementOnly.has(assetId);
}

/**
 * An asset's index, or null when the file cannot be read as an MP4 this
 * preview decodes.
 *
 * A file that will not parse is not asked about again: the element engine owns
 * it from here, and which degradation is on screen is the stage's business
 * rather than a console's.
 */
export async function mp4IndexFor(assetId: AssetId): Promise<Mp4Index | null> {
  if (elementOnly.has(assetId)) return null;
  try {
    return await openMp4(assetUrl(assetId), { assetId });
  } catch {
    elementOnlyNow(assetId);
    return null;
  }
}

async function decodeOn(
  slot: Slot,
  assetId: AssetId,
  index: Mp4Index,
  materialMs: number,
): Promise<VideoFrame | null> {
  const video = index.video;
  if (!video) return null;
  const plan = planFor(video, materialMs);
  if (!plan) return null;
  const wanted = video.samples[plan.target];
  const key = `${assetId}:${wanted.ctsUs}`;
  const kept = cached(key);
  if (kept) return kept;

  const config: VideoDecoderConfig = {
    codec: video.codec,
    // The configuration record is written beside the samples, where there is one.
    description: video.description,
    codedWidth: video.width > 0 ? video.width : undefined,
    codedHeight: video.height > 0 ? video.height : undefined,
    optimizeForLatency: true,
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(
    () => null,
  );
  if (!support?.supported) {
    elementOnlyNow(assetId);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECODE_TIMEOUT_MS);
  let hit: VideoFrame | null = null;
  let stopped = false;
  try {
    const fetched = await readRange(
      assetUrl(assetId),
      plan.startOffset,
      plan.endOffset,
      controller.signal,
    );
    const bytes = fetched.bytes;
    slot.failed = false;
    slot.sink = (frame) => {
      if (frame.timestamp === wanted.ctsUs && hit === null) hit = frame;
      else frame.close();
    };
    // A reset decoder starts from a keyframe, which is the plan's first chunk.
    slot.decoder.reset();
    slot.decoder.configure(config);
    for (const chunk of plan.chunks) {
      const at = chunk.offset - plan.startOffset;
      slot.decoder.decode(
        new EncodedVideoChunk({
          type: chunk.key ? "key" : "delta",
          timestamp: chunk.ctsUs,
          // The sample's own place in the window; the chunk takes its copy.
          data: bytes.subarray(at, at + chunk.size),
        }),
      );
    }
    // The frame wanted waits for the flush, which is where a decode order that
    // reaches back for a B-frame finally comes out.
    const flushed = await withDeadline(
      slot.decoder.flush().then(
        () => true,
        () => false,
      ),
      DECODE_TIMEOUT_MS,
    );
    // A run that stopped answering, failed, or produced nothing at all is a
    // file this decoder cannot serve: the elements are asked from here on.
    if (flushed === null || slot.failed || hit === null) {
      stopped = true;
      return null;
    }
    return cacheFrame(key, hit);
  } catch {
    stopped = true;
    return null;
  } finally {
    clearTimeout(timer);
    slot.sink = null;
    if (stopped) {
      elementOnlyNow(assetId);
      if (!hit) dropSlot(slot);
    }
  }
}

/**
 * A frame for a material moment, or null when this asset cannot be decoded.
 *
 * The frame belongs to the cache: it is drawn with and never closed by the
 * caller, and a key it was stored under is a frame a later call gets back.
 */
export async function decodeFrameAt(
  assetId: AssetId,
  materialMs: number,
): Promise<DecodedPicture | null> {
  if (elementOnly.has(assetId)) return null;
  const index = await mp4IndexFor(assetId);
  if (!index?.video) return null;
  if (typeof VideoDecoder === "undefined") {
    elementOnlyNow(assetId);
    return null;
  }
  const slot = await takeSlot();
  slot.busy = decodeOn(slot, assetId, index, materialMs);
  try {
    const frame = await slot.busy;
    if (!frame) return null;
    return { frame, rotationDeg: index.video.rotationDeg };
  } finally {
    slot.busy = null;
  }
}
