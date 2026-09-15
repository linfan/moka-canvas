import type { AssetId } from "../../../shared/domain";
import { assetUrl } from "../../../api";

/**
 * The picture when there is no decoder to be had: a `<video>` walked to the
 * moment and drawn from.
 *
 * A browser that will not hand over frames will still show a file, so this is
 * the floor the preview stands on — approximate by nature, since a seek lands
 * on whatever the browser decides is near enough, and the badge says so. Three
 * elements are kept, each owned by one visible clip: two clips of the same
 * material meeting at a seam are two places in the file at once, and a single
 * element shared between them would be dragged back and forth by each.
 *
 * While the clock runs the element is not walked at all: it is put where the
 * moment stands once and then left to play, at the clip's own speed and pitch,
 * with the compositor drawing whatever frame is on it. That is what makes the
 * fallback path watchable rather than a seek per frame. Frames arriving are
 * announced where `requestVideoFrameCallback` can say so, and where it cannot
 * the preview's own clock already repaints each frame the playhead moves.
 *
 * Elements are made on first use, so a test without a DOM never makes one.
 */

const MAX_ELEMENTS = 3;
/** How far a seek may be off before the element is moved to the moment asked for. */
const SEEK_TOLERANCE_MS = 40;
/** A picture can be drawn from a position once the element holds data for it. */
const HAVE_CURRENT_DATA = 2;

interface Slot {
  key: string;
  assetId: AssetId;
  element: HTMLVideoElement;
  /** The moment the element was last asked for, in milliseconds; null = a seek is due. */
  askedMs: number | null;
  /** Whether the picture on screen is the one that was asked for. */
  ready: boolean;
  /** Whether a frame callback is registered for a playing element. */
  watching: boolean;
}

/** Clip id to element: the place a clip's picture is read from. */
const slots = new Map<string, Slot>();
let arrivals: (() => void)[] = [];
let problems: ((assetId: AssetId) => void)[] = [];

function notifyArrive(): void {
  for (const listener of arrivals) listener();
}

function notifyProblem(assetId: AssetId): void {
  for (const listener of problems) listener(assetId);
}

function createSlot(key: string, assetId: AssetId): Slot | null {
  if (
    typeof document === "undefined" ||
    typeof HTMLVideoElement === "undefined"
  )
    return null;
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.preload = "auto";
  const slot: Slot = {
    key,
    assetId,
    element,
    askedMs: null,
    ready: false,
    watching: false,
  };
  // A picture arriving is what wakes the preview up; a seek is only the walk
  // towards one, so the frame that shows is drawn once the element has data.
  element.addEventListener("loadeddata", () => {
    slot.ready = true;
    notifyArrive();
  });
  element.addEventListener("seeked", () => {
    slot.ready = true;
    notifyArrive();
  });
  element.addEventListener("error", () => {
    slot.ready = false;
    notifyProblem(assetId);
    notifyArrive();
  });
  return slot;
}

/** Gives an element back: its source is dropped so the browser can let the file go. */
function releaseElement(key: string): void {
  const slot = slots.get(key);
  if (!slot) return;
  slots.delete(key);
  slot.element.removeAttribute("src");
  slot.element.load();
}

/** The slot a clip's picture is read from, made or reclaimed from the pool. */
function slotFor(key: string, assetId: AssetId): Slot | null {
  let slot = slots.get(key);
  if (slot && slot.assetId !== assetId) {
    // The clip reads a different file now; the old one's element goes back.
    releaseElement(key);
    slot = undefined;
  }
  if (!slot) {
    if (slots.size >= MAX_ELEMENTS) {
      // The element nobody has asked about for longest is the one to reuse.
      const oldest = slots.keys().next().value;
      if (oldest !== undefined) releaseElement(oldest);
    }
    const made = createSlot(key, assetId);
    if (!made) return null;
    made.element.src = assetUrl(assetId);
    made.element.load();
    slots.set(key, made);
    slot = made;
  }
  // Asked for is what keeps an element; the sweep above takes the quiet ones.
  slots.delete(key);
  slots.set(key, slot);
  return slot;
}

/**
 * The element a clip's picture is read from, or null when it is not there yet.
 *
 * A null is a wait rather than an absence — the element is loading or seeking —
 * and `onArrive` says when to ask again.
 */
export function elementFor(
  key: string,
  assetId: AssetId,
  materialMs: number,
): HTMLVideoElement | null {
  const slot = slotFor(key, assetId);
  if (!slot) return null;
  if (
    slot.askedMs === null ||
    Math.abs(slot.askedMs - materialMs) > SEEK_TOLERANCE_MS
  ) {
    slot.askedMs = materialMs;
    // A seek is a wait, whatever the element was holding: what it shows now is
    // the old place, which is not the one being asked about.
    slot.ready = false;
    slot.element.currentTime = Math.max(0, materialMs / 1_000);
  }
  if (!slot.ready || slot.element.readyState < HAVE_CURRENT_DATA) return null;
  return slot.element;
}

/** Frames of a playing element wake the preview, once they can be heard about. */
function watchFrames(slot: Slot): void {
  const element = slot.element;
  if (slot.watching) return;
  if (typeof element.requestVideoFrameCallback !== "function") return;
  slot.watching = true;
  const arrived = () => {
    if (!slot.watching) return;
    slot.ready = true;
    notifyArrive();
    if (slot.watching) element.requestVideoFrameCallback(arrived);
  };
  element.requestVideoFrameCallback(arrived);
}

/**
 * The element a clip's playing picture is read from, or null until it holds data.
 *
 * The run's first ask puts the element where the moment stands — the clock
 * carries it from there — and every ask after it is the same element, playing.
 * A hop is never made mid-run: the positions the room asks about advance by a
 * frame at a time, and re-seeking to each would be the walk this replaces.
 */
export function startPlayingElement(
  key: string,
  assetId: AssetId,
  materialMs: number,
  speed: number,
): HTMLVideoElement | null {
  const slot = slotFor(key, assetId);
  if (!slot) return null;
  const element = slot.element;
  if (slot.askedMs === null) {
    slot.askedMs = Math.max(0, materialMs);
    try {
      element.currentTime = slot.askedMs / 1_000;
    } catch {
      // An element with no data yet takes the position once it has some.
    }
  }
  element.playbackRate = speed;
  // The export keeps the pitch with `atempo`; the preview must not part ways.
  element.preservesPitch = true;
  if (element.paused) {
    void element.play().catch(() => {
      // A browser that will not play the file still draws its first frame;
      // the room's clock is not held up for it.
    });
  }
  watchFrames(slot);
  if (element.readyState < HAVE_CURRENT_DATA) return null;
  return element;
}

/**
 * Stops every playing element and marks its position stale.
 *
 * A stopped element is one seek away from a picture again: the paused path
 * positions it at the moment it is asked about, which is why the asked moment
 * is forgotten rather than kept.
 */
export function stopElementPlayback(): void {
  for (const slot of slots.values()) {
    if (!slot.element.paused) slot.element.pause();
    slot.watching = false;
    slot.askedMs = null;
    slot.ready = false;
  }
}

export interface ElementEngine {
  elementFor(
    key: string,
    assetId: AssetId,
    materialMs: number,
  ): HTMLVideoElement | null;
  /** The element a clip's picture plays from, or null until it holds data. */
  startPlaying(
    key: string,
    assetId: AssetId,
    materialMs: number,
    speed: number,
  ): HTMLVideoElement | null;
  /** Stops every playing element; the paused path repositions from here. */
  stopPlayback(): void;
  /** Subscribes to pictures arriving late, which is when the preview repaints. */
  onArrive(listener: () => void): () => void;
  /** Subscribes to a file the browser could not read. */
  onProblem(listener: (assetId: AssetId) => void): () => void;
}

const engine: ElementEngine = {
  elementFor,
  startPlaying: startPlayingElement,
  stopPlayback: stopElementPlayback,
  onArrive(listener) {
    arrivals.push(listener);
    return () => {
      arrivals = arrivals.filter((kept) => kept !== listener);
    };
  },
  onProblem(listener) {
    problems.push(listener);
    return () => {
      problems = problems.filter((kept) => kept !== listener);
    };
  },
};

/** The one pool, shared by whoever is drawing pictures. */
export function elementEngine(): ElementEngine {
  return engine;
}
