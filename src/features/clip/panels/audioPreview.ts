import { useSyncExternalStore } from "react";
import type { AssetId } from "../../../shared/domain";
import { assetUrl } from "../../../api";

/**
 * One sound at a time, from the media shelf.
 *
 * Trying a sound is asking "is this the one?" — two sounds at once answer a
 * question nobody asked, so the shelf keeps a single element and points it at
 * whichever row was last asked for; asking for another row takes the sound
 * away from the first. Module-level rather than held per row, because the
 * sharing is the whole point, and the element is made on first use so a test
 * without a DOM never makes one.
 *
 * This is the shelf's own small matter and stays out of the timeline's way:
 * what plays the cut is package 07's business, with its own graph and clock.
 */

export interface AudioPreview {
  /** The sound being offered, if any, and whether it is sounding right now. */
  assetId: AssetId | null;
  playing: boolean;
}

const QUIET: AudioPreview = { assetId: null, playing: false };

let element: HTMLAudioElement | null = null;
let state: AudioPreview = QUIET;
const listeners = new Set<() => void>();

function set(next: AudioPreview): void {
  state = next;
  for (const listener of listeners) listener();
}

/** The one element, made the first time a row asks to be heard. */
function sound(): HTMLAudioElement | null {
  if (element) return element;
  if (typeof Audio === "undefined") return null;
  const made = new Audio();
  // A sound that ran out, or could not be fetched, is no longer sounding: the
  // row goes back to offering it rather than claiming to play it.
  made.addEventListener("ended", () => set(QUIET));
  made.addEventListener("error", () => set(QUIET));
  element = made;
  return made;
}

/** Starts the sound, or stops it where it stands, when the same row asks again. */
export function toggleAudioPreview(id: AssetId): void {
  const made = sound();
  if (!made) return;
  if (state.assetId === id && state.playing) {
    made.pause();
    set({ assetId: id, playing: false });
    return;
  }
  if (state.assetId === id) {
    // The same row again: it carries on from where it was stopped, which is
    // what a second look at a sound usually means.
    set({ assetId: id, playing: true });
    void made.play().catch(() => set(QUIET));
    return;
  }
  // Another row's sound: the shared element is pointed at this file, which is
  // what leaves exactly one sound sounding.
  made.pause();
  made.src = assetUrl(id);
  made.load();
  set({ assetId: id, playing: true });
  void made.play().catch(() => set(QUIET));
}

/** Stops whatever is sounding; the shelf keeps no other trace of it. */
export function stopAudioPreview(): void {
  element?.pause();
  set(QUIET);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AudioPreview {
  return state;
}

/** Which row, if any, is being heard, and whether it is sounding. */
export function useAudioPreview(): AudioPreview {
  return useSyncExternalStore(subscribe, getSnapshot);
}
