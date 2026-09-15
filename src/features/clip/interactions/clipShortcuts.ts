import { useEffect } from "react";
import { redo, undo } from "../../editor/commands/execute";
import { useClipStore } from "../stores/clipStore";
import { ZOOM_STEP } from "../timeline/TimelineToolbar";
import {
  activeTimeline,
  clearSelection,
  deleteSelection,
  duplicateSelection,
  nearestClipEdgeMs,
  selectAll,
  splitSelectionAtPlayhead,
} from "./clipActions";

/** One line of the room's shortcuts list: the keys that work and what they do. */
export interface ClipShortcutRow {
  label: string;
  /** Alternate ways to press it, as a reader of either platform would say them. */
  chords: string[];
}

export interface ClipShortcutGroup {
  title: string;
  rows: ClipShortcutRow[];
}

/**
 * What the cutting room answers to, as its help list reads it.
 *
 * Written here under the handler so the two are read together: a key that
 * moves in one and not the other is caught between neighbours rather than
 * between files. Space and the arrow keys are not listed — they belong to the
 * transport of a later package, and a list that promises what a room cannot
 * yet do is worse than a shorter list.
 */
export const CLIP_SHORTCUT_GROUPS: ClipShortcutGroup[] = [
  {
    title: "Editing",
    rows: [
      { label: "Undo", chords: ["Ctrl/Cmd + Z"] },
      { label: "Redo", chords: ["Ctrl/Cmd + Shift + Z", "Ctrl + Y"] },
      { label: "Split at the playhead", chords: ["Ctrl/Cmd + B"] },
      { label: "Duplicate the selection", chords: ["Ctrl/Cmd + D"] },
      { label: "Delete the selection", chords: ["Delete", "Backspace"] },
      { label: "Select all", chords: ["Ctrl/Cmd + A"] },
      { label: "Clear the selection", chords: ["Escape"] },
    ],
  },
  {
    title: "Moving the playhead",
    rows: [
      { label: "Back to the head", chords: ["Home"] },
      { label: "To the end of the cut", chords: ["End"] },
      { label: "To the clip edge above or below", chords: ["↑", "↓"] },
    ],
  },
  {
    title: "View",
    rows: [
      { label: "Zoom in", chords: ["+"] },
      { label: "Zoom out", chords: ["-"] },
    ],
  },
  {
    title: "Help",
    rows: [{ label: "Keyboard shortcuts", chords: ["?"] }],
  },
];

/** A guard every key meets first: the field a reader is typing in keeps its keys. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface ClipShortcutOptions {
  /** Whether a dialog the room put up is standing; its keys are its own. */
  isBlocked?: () => boolean;
  /** The `?` list, which the page owns the standing of. */
  onShowHelp?: () => void;
}

/**
 * Where the cut ends: the last tail on a row that draws, or the head.
 *
 * The same end 07's skip-to-the-end will seek to, and not the drawn content's
 * length — a cut three seconds long does not end where its scroller does.
 */
function cutEndMs(): number {
  const timeline = activeTimeline();
  if (!timeline) return 0;
  return timeline.clips.reduce((end, clip) => {
    const track = timeline.tracks.find((row) => row.id === clip.trackId);
    if (!track || track.hidden) return end;
    return Math.max(end, clip.startMs + clip.durationMs);
  }, 0);
}

/**
 * The room's keys, bound while the page is up and taken down with it.
 *
 * A room nobody is standing in must not keep answering for one, so the
 * listener lives exactly as long as the page does. Both Ctrl and Cmd are
 * accepted so either platform works; a key typed into a field is the field's
 * own, and a key a dialog has already answered is left alone.
 */
export function useClipShortcuts(options: ClipShortcutOptions = {}) {
  const { isBlocked, onShowHelp } = options;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (isBlocked?.()) return;

      const state = useClipStore.getState();
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod) {
        if (key === "z" && event.shiftKey) {
          event.preventDefault();
          redo();
        } else if (key === "z") {
          event.preventDefault();
          undo();
        } else if (key === "y") {
          event.preventDefault();
          redo();
        } else if (key === "b") {
          event.preventDefault();
          splitSelectionAtPlayhead();
        } else if (key === "d") {
          // The browser would otherwise take this one for a bookmark.
          event.preventDefault();
          duplicateSelection();
        } else if (key === "a") {
          event.preventDefault();
          selectAll();
        }
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (event.key === "Escape") {
        clearSelection();
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        onShowHelp?.();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        state.setPlayhead(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        state.setPlayhead(cutEndMs());
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const timeline = activeTimeline();
        if (!timeline) return;
        const edge = nearestClipEdgeMs(
          timeline,
          state.playheadMs,
          event.key === "ArrowUp" ? -1 : 1,
        );
        if (edge !== null) state.setPlayhead(edge);
        return;
      }
      if (event.key === "+") {
        event.preventDefault();
        state.zoomBy(ZOOM_STEP);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        state.zoomBy(1 / ZOOM_STEP);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isBlocked, onShowHelp]);
}
