import { useSyncExternalStore } from "react";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import { assetUrl } from "../../../api";

/**
 * One file at a time, heard or watched before it is used.
 *
 * Trying a file is asking "is this the one?" — two at once answer a question
 * nobody asked, so a single state says which file is being offered: a sound
 * plays from this module's own element, and a video plays in the material
 * card that shows it, the card taking its cue from the same state. Starting
 * either puts the other away, and the element is made on first use so a test
 * without a DOM never makes one.
 */

export interface MediaPreview {
  /** The file being offered, if any, and whether it is sounding right now. */
  assetId: AssetId | null;
  kind: "audio" | "video" | null;
  playing: boolean;
}

const QUIET: MediaPreview = { assetId: null, kind: null, playing: false };

let element: HTMLAudioElement | null = null;
let state: MediaPreview = QUIET;
const listeners = new Set<() => void>();

function set(next: MediaPreview): void {
  if (
    state.assetId === next.assetId &&
    state.kind === next.kind &&
    state.playing === next.playing
  ) {
    return;
  }
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

/** Which of the two ways a row's file can be tried, if either. */
export function previewKindOf(entry: ResourceEntry): "audio" | "video" | null {
  if (entry.mime?.startsWith("audio/")) return "audio";
  if (entry.mime?.startsWith("video/")) return "video";
  return null;
}

/**
 * Starts the file, or stops it where it stands, when the same row asks again.
 *
 * A sound resumes from where it was stopped, which is what a second look at a
 * file usually means; a video's element lives in the card, so only the state
 * moves here and the card follows it.
 */
export function toggleMediaPreview(
  assetId: AssetId,
  kind: "audio" | "video",
): void {
  if (state.assetId === assetId && state.playing) {
    element?.pause();
    set({ assetId, kind, playing: false });
    return;
  }
  if (kind === "video") {
    // The sound gives way to the picture, and the card with the video in it
    // plays it once this state reaches it.
    element?.pause();
    set({ assetId, kind: "video", playing: true });
    return;
  }
  const made = sound();
  if (!made) return;
  if (state.assetId === assetId) {
    set({ assetId, kind: "audio", playing: true });
    void made.play().catch(() => set(QUIET));
    return;
  }
  // Another file's sound: the shared element is pointed at this one, which is
  // what leaves exactly one file being tried.
  made.pause();
  made.src = assetUrl(assetId);
  made.load();
  set({ assetId, kind: "audio", playing: true });
  void made.play().catch(() => set(QUIET));
}

/** Stops whatever is being tried; no other trace of it is kept. */
export function stopMediaPreview(): void {
  element?.pause();
  set(QUIET);
}

/** Stops the sound a card is making, once the card is leaving the file. */
export function stopMediaPreviewFor(assetId: AssetId): void {
  if (state.assetId === assetId) stopMediaPreview();
}

/** The card's video reporting itself started, which rows and sounds follow. */
export function noteVideoPlaying(assetId: AssetId): void {
  element?.pause();
  set({ assetId, kind: "video", playing: true });
}

/** The card's video reporting itself stopped, by its own controls or its end. */
export function noteVideoPaused(assetId: AssetId): void {
  if (state.assetId !== assetId || state.kind !== "video") return;
  set({ assetId, kind: "video", playing: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): MediaPreview {
  return state;
}

/** Which file, if any, is being tried, and whether it is playing. */
export function useMediaPreview(): MediaPreview {
  return useSyncExternalStore(subscribe, getSnapshot);
}
