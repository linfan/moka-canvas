import { create } from "zustand";
import type {
  ClipId,
  MokaFile,
  TimelineId,
  TransitionId,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";

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
  /** Whether the new-timeline question is up. */
  newTimelineOpen: boolean;
  setActiveTimeline: (id: TimelineId | null) => void;
  setFace: (face: ClipFace) => void;
  select: (patch: Partial<ClipSelection>) => void;
  setNewTimelineOpen: (open: boolean) => void;
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
export const useClipStore = create<ClipState>()((set) => ({
  activeTimelineId: null,
  face: "local",
  selection: { clipIds: [], transitionId: null },
  newTimelineOpen: false,

  setActiveTimeline(id) {
    set({ activeTimelineId: id });
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

  setNewTimelineOpen(open) {
    set({ newTimelineOpen: open });
  },
}));
