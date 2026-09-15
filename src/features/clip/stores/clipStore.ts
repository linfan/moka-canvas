import { create } from "zustand";
import type {
  AssetId,
  ClipId,
  MokaFile,
  TimelineDocument,
  TimelineId,
  TransitionId,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  DEFAULT_PX_PER_SEC,
  MIN_CONTENT_MS,
  TAIL_MS,
  clampPxPerSec,
  contentMs,
  viewAfterZoom,
  zoomAnchorMs,
  type TimelineView,
} from "../timeline/geometry";

/** The nine faces the left column turns over between. */
export type ClipFace =
  | "local"
  | "project"
  | "runs"
  | "canvas"
  | "library"
  | "audio"
  | "text"
  | "filters"
  | "adjust";

/**
 * Which timeline a project was last left looking at, kept on this machine
 * beside the project rather than inside it.
 *
 * Which cut somebody was working on is about them and their afternoon, not
 * about the work: a package handed to somebody else opens onto the first
 * timeline like any other, and closing a project does not forget what was on
 * screen — the memory is the machine's, beside the board tabs' own.
 */
const STORED_UNDER = "moka-canvas:clip-timeline";

function keyFor(projectId: string): string {
  return `${STORED_UNDER}:${projectId}`;
}

/** The timeline this machine remembers for a project, or null. */
export function rememberedTimelineId(projectId: string): TimelineId | null {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return null;
  try {
    const kept = localStorage.getItem(keyFor(projectId));
    if (!kept) return null;
    const parsed: unknown = JSON.parse(kept);
    return typeof parsed === "string" && parsed.length > 0 ? parsed : null;
  } catch {
    // A store this cannot read is one that has nothing in it.
    return null;
  }
}

/** Writes the timeline a project was left on; null forgets it. */
export function rememberTimelineId(
  projectId: string,
  timelineId: TimelineId | null,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (timelineId === null) {
      localStorage.removeItem(keyFor(projectId));
    } else {
      localStorage.setItem(keyFor(projectId), JSON.stringify(timelineId));
    }
  } catch {
    // A store that will not take it costs the remembering, not the cut.
  }
}

/**
 * Which timeline a project opens onto.
 *
 * The one it was left on, when the document still has it — a timeline deleted
 * while nobody was looking is not a timeline to open onto — and otherwise the
 * first the document does have.
 */
export function initialTimelineId(moka: MokaFile): TimelineId | null {
  const timelines = moka.timelines ?? [];
  const remembered = rememberedTimelineId(moka.metadata.id);
  if (remembered !== null && timelines.some((t) => t.id === remembered)) {
    return remembered;
  }
  return timelines[0]?.id ?? null;
}

/** The zoom and the playhead one timeline was last left with. */
export interface RememberedView {
  view: TimelineView;
  playheadMs: number;
}

const VIEW_STORED_UNDER = "moka-canvas:clip-view";

function viewKeyFor(timelineId: TimelineId): string {
  return `${VIEW_STORED_UNDER}:${timelineId}`;
}

/**
 * What a timeline was last read at, or null for one never opened.
 *
 * Zooming is a way of looking at one cut, not a fact about it: the scale and
 * where the view sat are kept per timeline, on this machine, so stepping back
 * onto a cut hands the reader the frame they left it in. A timeline seen for
 * the first time starts at the default scale, unscrolled, with its playhead
 * at the head.
 */
export function rememberedView(timelineId: TimelineId): RememberedView | null {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return null;
  try {
    const kept = localStorage.getItem(viewKeyFor(timelineId));
    if (!kept) return null;
    const parsed: unknown = JSON.parse(kept);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const pxPerSec =
      typeof record.pxPerSec === "number"
        ? clampPxPerSec(record.pxPerSec)
        : DEFAULT_PX_PER_SEC;
    const scrollLeftPx =
      typeof record.scrollLeftPx === "number" && record.scrollLeftPx >= 0
        ? record.scrollLeftPx
        : 0;
    const playheadMs =
      typeof record.playheadMs === "number" && record.playheadMs >= 0
        ? record.playheadMs
        : 0;
    return { view: { pxPerSec, scrollLeftPx }, playheadMs };
  } catch {
    // A store this cannot read is one that has nothing in it.
    return null;
  }
}

/** Writes down where a timeline was left; a store that will not take it costs the remembering. */
export function rememberView(
  timelineId: TimelineId,
  view: TimelineView,
  playheadMs: number,
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      viewKeyFor(timelineId),
      JSON.stringify({
        pxPerSec: view.pxPerSec,
        scrollLeftPx: view.scrollLeftPx,
        playheadMs,
      }),
    );
  } catch {
    // A store that will not take it costs the remembering, not the cut.
  }
}

/** What is chosen on the timeline: some clips, and at most one seam. */
export interface ClipSelection {
  clipIds: ClipId[];
  transitionId: TransitionId | null;
}

interface ClipState {
  /** The timeline being looked at; null = the document has none (or they all went). */
  activeTimelineId: TimelineId | null;
  /** The face the left column is turned to: sources and tools share one column. */
  face: ClipFace;
  /** What is chosen on the timeline, which the inspector reads. */
  selection: ClipSelection;
  /**
   * The file chosen on the media shelf, which the inspector reads as material.
   *
   * Kept apart from the timeline's own choice: the two columns each hold their
   * own highlight, and clearing one is not an answer about the other — the
   * inspector decides what to show when both are held.
   */
  mediaSelection: AssetId | null;
  /** Whether the new-timeline question is up. */
  newTimelineOpen: boolean;
  /** Where the timeline is scrolled and how tightly it is drawn, remembered per timeline. */
  view: TimelineView;
  /** The reader's place on the cut, in milliseconds from the head. */
  playheadMs: number;
  /**
   * How wide the canvas is, reported by the canvas itself.
   *
   * Zooming holds the playhead (or the screen's middle) still, and that is
   * arithmetic the store cannot do without knowing what a screen is; the
   * window's size is about the window rather than the cut, so it is never
   * written down where a view is.
   */
  viewportPx: number;
  setActiveTimeline: (id: TimelineId | null) => void;
  setFace: (face: ClipFace) => void;
  select: (patch: Partial<ClipSelection>) => void;
  selectMedia: (id: AssetId | null) => void;
  setNewTimelineOpen: (open: boolean) => void;
  setView: (patch: Partial<TimelineView>) => void;
  /** One step of the toolbar buttons, ×1.5 in or out, held around the playhead. */
  zoomBy: (factor: number, anchorMs?: number) => void;
  /** The slider's scale, held around the playhead. */
  zoomTo: (pxPerSec: number, anchorMs?: number) => void;
  /** The whole cut on screen at once. */
  fit: (viewportPx: number, contentMs: number) => void;
  setPlayhead: (ms: number) => void;
  setViewportPx: (px: number) => void;
}

/** The timeline being read, from the project, for the zooms that need its length. */
function heldTimeline(id: TimelineId | null): TimelineDocument | null {
  const timelines = useProjectStore.getState().moka?.timelines ?? [];
  if (!id) return null;
  return timelines.find((timeline) => timeline.id === id) ?? null;
}

/**
 * What the cutting room is looking at.
 *
 * Only what this package uses: the playhead, the zoom and the scrolling belong
 * to the packages that draw the timeline, and a store that guesses at their
 * shape now would be guesses to undo later. Nothing here ever touches the
 * document — every change to a cut goes through the command pipeline, so this
 * store holds the reader's place and nothing else.
 */
export const useClipStore = create<ClipState>()((set, get) => {
  /** Writes the current view under the timeline it was read on; no timeline, nothing to write. */
  const keep = (view: TimelineView, playheadMs: number): void => {
    const id = get().activeTimelineId;
    if (id) rememberView(id, view, playheadMs);
  };

  const zoomToPxPerSec = (next: number, anchorMs?: number): void => {
    const state = get();
    const timeline = heldTimeline(state.activeTimelineId);
    const length = timeline
      ? contentMs(timeline, state.playheadMs)
      : MIN_CONTENT_MS + TAIL_MS;
    const anchor =
      anchorMs ?? zoomAnchorMs(state.view, state.viewportPx, state.playheadMs);
    const view = viewAfterZoom(
      clampPxPerSec(next),
      state.viewportPx,
      anchor,
      length,
    );
    set({ view });
    keep(view, state.playheadMs);
  };

  return {
    activeTimelineId: null,
    face: "local",
    selection: { clipIds: [], transitionId: null },
    mediaSelection: null,
    newTimelineOpen: false,
    view: { pxPerSec: DEFAULT_PX_PER_SEC, scrollLeftPx: 0 },
    playheadMs: 0,
    viewportPx: 0,

    setActiveTimeline(id) {
      const state = get();
      if (state.activeTimelineId !== id) {
        // The view being left is written down under its own timeline before
        // the next one's is picked up, and a timeline nobody has opened yet
        // starts where a new one should.
        if (state.activeTimelineId) {
          rememberView(state.activeTimelineId, state.view, state.playheadMs);
        }
        const remembered = id ? rememberedView(id) : null;
        set({
          activeTimelineId: id,
          view: remembered?.view ?? {
            pxPerSec: DEFAULT_PX_PER_SEC,
            scrollLeftPx: 0,
          },
          playheadMs: remembered?.playheadMs ?? 0,
        });
      } else {
        set({ activeTimelineId: id });
      }
      // Switching is also the moment to remember: the machine keeps where the
      // project was left, and a project closed without a last look is a project
      // that opens onto nothing remembered.
      const projectId = useProjectStore.getState().moka?.metadata.id;
      if (projectId) rememberTimelineId(projectId, id);
    },

    setFace(face) {
      set({ face });
    },

    select(patch) {
      set((state) => ({ selection: { ...state.selection, ...patch } }));
    },

    selectMedia(id) {
      set({ mediaSelection: id });
    },

    setNewTimelineOpen(open) {
      set({ newTimelineOpen: open });
    },

    setView(patch) {
      const state = get();
      const view: TimelineView = {
        pxPerSec: clampPxPerSec(patch.pxPerSec ?? state.view.pxPerSec),
        scrollLeftPx: Math.max(
          0,
          patch.scrollLeftPx ?? state.view.scrollLeftPx,
        ),
      };
      set({ view });
      keep(view, state.playheadMs);
    },

    zoomBy(factor, anchorMs) {
      const state = get();
      zoomToPxPerSec(state.view.pxPerSec * factor, anchorMs);
    },

    zoomTo(pxPerSec, anchorMs) {
      zoomToPxPerSec(pxPerSec, anchorMs);
    },

    fit(viewportPx, length) {
      if (viewportPx <= 0 || length <= 0) return;
      const view: TimelineView = {
        pxPerSec: clampPxPerSec(viewportPx / (length / 1_000)),
        scrollLeftPx: 0,
      };
      set({ view });
      keep(view, get().playheadMs);
    },

    setPlayhead(ms) {
      const playheadMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
      set({ playheadMs });
      keep(get().view, playheadMs);
    },

    setViewportPx(px) {
      set({ viewportPx: Math.max(0, px) });
    },
  };
});
