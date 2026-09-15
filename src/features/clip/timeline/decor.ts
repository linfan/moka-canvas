import { useSyncExternalStore } from "react";
import type {
  AssetId,
  ResourceRegistry,
  TimelineClip,
} from "../../../shared/domain";
import { assetUrl } from "../../../api";
import { useProjectStore } from "../../editor/stores/projectStore";
import { firstFrameThumb, onFirstFrame } from "../preview/thumbs";
import type { TimelineDecor, WaveformDrawing } from "./render";
import { peaksFromBuffer, type WaveformPeaks } from "./waveform";

/**
 * What the timeline's blocks are drawn with: a sound's shape, a picture's first frame.
 *
 * Both arrive after the block is already on screen — a file is fetched and
 * decoded while the cut keeps being cut — so the drawing asks this provider for
 * what it has and subscribes to a version that moves when something lands.
 * Nothing here ever fails loudly: a sound the browser will not decode is a flat
 * line, and a file with no picture is a block without one.
 *
 * A waveform is measured once per asset and kept for the session, never
 * written down: the buckets are a way of looking at a file rather than a fact
 * about the project, and measuring them again costs a fetch the browser has
 * already cached.
 */

const peaks = new Map<AssetId, WaveformPeaks>();
const flat = new Set<AssetId>();
const measuring = new Set<AssetId>();
const images = new Map<AssetId, CanvasImageSource>();
const imageStarted = new Set<AssetId>();
const imageFailed = new Set<AssetId>();

/** The subscribers, told whenever something has landed. */
let listeners: (() => void)[] = [];

function bump(): void {
  for (const listener of listeners) listener();
}

const IMAGE_SUFFIX = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** Whether an asset is a picture, read from its mime or, older, its name. */
function isPicture(name: string, mime: string | undefined): boolean {
  if (mime?.startsWith("image/")) return true;
  return mime === undefined && IMAGE_SUFFIX.test(name);
}

/** The asset's entry in the project, which is what says what kind of file it is. */
function entryFor(assetId: AssetId) {
  const resources: ResourceRegistry | undefined =
    useProjectStore.getState().moka?.resources;
  if (!resources) return undefined;
  for (const entries of Object.values(resources)) {
    const found = entries.find((entry) => entry.id === assetId);
    if (found) return found;
  }
  return undefined;
}

/** A context that decodes but never plays: nothing here needs a gesture. */
let decoder: BaseAudioContext | null | undefined;

function decodeContext(): BaseAudioContext | null {
  if (decoder !== undefined) return decoder;
  if (typeof OfflineAudioContext === "undefined") {
    decoder = null;
    return decoder;
  }
  try {
    decoder = new OfflineAudioContext(1, 1, 44_100);
  } catch {
    decoder = null;
  }
  return decoder;
}

function measure(assetId: AssetId): void {
  if (peaks.has(assetId) || flat.has(assetId) || measuring.has(assetId)) return;
  measuring.add(assetId);
  void (async () => {
    try {
      const context = decodeContext();
      if (!context) throw new Error("no decoder");
      const response = await fetch(assetUrl(assetId));
      if (!response.ok) throw new Error("the file did not answer");
      const bytes = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(bytes);
      // The samples are let go of here: the buckets are all the block draws,
      // and holding the decoded sound would be the memory this avoids.
      peaks.set(assetId, peaksFromBuffer(buffer));
    } catch {
      // A sound this browser will not decode — an unsupported codec, a file
      // that left the disk — is a flat line, not a report: it is a picture of
      // a sound rather than the sound itself that was wanted.
      flat.add(assetId);
    } finally {
      measuring.delete(assetId);
      land();
    }
  })();
}

/** A picture's own file, loaded once; the picture is the thumbnail for a still. */
function picture(assetId: AssetId): CanvasImageSource | null {
  const kept = images.get(assetId);
  if (kept) return kept;
  if (
    imageStarted.has(assetId) ||
    imageFailed.has(assetId) ||
    typeof Image === "undefined"
  )
    return null;
  imageStarted.add(assetId);
  const image = new Image();
  image.onload = () => {
    images.set(assetId, image);
    land();
  };
  image.onerror = () => {
    imageFailed.add(assetId);
  };
  image.src = assetUrl(assetId);
  return null;
}

const provider: TimelineDecor = {
  waveform(clip: TimelineClip): WaveformDrawing | null {
    if (clip.kind !== "audio" || !clip.assetId) return null;
    measure(clip.assetId);
    const measured = peaks.get(clip.assetId);
    if (measured) return { kind: "peaks", peaks: measured };
    if (flat.has(clip.assetId)) return { kind: "flat" };
    // Still being measured: the block draws as it did, and the version below
    // brings the shape back when it is there.
    return null;
  },

  thumb(assetId: AssetId): CanvasImageSource | null {
    const entry = entryFor(assetId);
    if (entry && isPicture(entry.name, entry.mime)) return picture(assetId);
    return firstFrameThumb(assetId);
  },
};

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((kept) => kept !== listener);
  };
}

// A first frame is drawn by the preview's own machinery; its arrival is the
// same news as a waveform landing, so the two bump the one version.
onFirstFrame(land);

/** The provider as it stands: a new object whenever something has landed. */
let live: TimelineDecor = { ...provider };

function land(): void {
  live = { ...provider };
  bump();
}

/** The decor provider, subscribed: anything arriving redraws whoever asked. */
export function useTimelineDecor(): TimelineDecor {
  // The snapshot is the provider itself, so a caller that memoises its drawing
  // on it — the canvas does — redraws exactly when something lands: an arrival
  // is a new object, and nothing else is.
  return useSyncExternalStore(subscribe, () => live);
}
