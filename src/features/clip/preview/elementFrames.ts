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
  /** The moment the element was last asked for, in milliseconds. */
  askedMs: number | null;
  /** Whether the picture on screen is the one that was asked for. */
  ready: boolean;
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
  const slot: Slot = { key, assetId, element, askedMs: null, ready: false };
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

export interface ElementEngine {
  elementFor(
    key: string,
    assetId: AssetId,
    materialMs: number,
  ): HTMLVideoElement | null;
  /** Subscribes to pictures arriving late, which is when the preview repaints. */
  onArrive(listener: () => void): () => void;
  /** Subscribes to a file the browser could not read. */
  onProblem(listener: (assetId: AssetId) => void): () => void;
}

const engine: ElementEngine = {
  elementFor,
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
