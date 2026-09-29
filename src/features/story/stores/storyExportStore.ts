import { create } from "zustand";

import type { ClipExportTask } from "../../clip/api";

/**
 * The render of a story's film, as the fifth step watches it.
 *
 * Deliberately not the cutting room's export store: that one holds the handle
 * of a render the reader asked for from a timeline, and this one holds the
 * handle of the render that makes a telling into a film. A single handle shared
 * between them would be two dialogs overwriting each other's work.
 *
 * Nothing is written down, since a render has no life outside the process that
 * runs it: a reload starts from nothing, which is the truth.
 */
interface StoryExportState {
  /** The last render this session started or picked up, live or ended. */
  task: ClipExportTask | null;
  /** Where the live render was told to land, held so a retry keeps the choice. */
  destination: string | null;
  /** What a refusal said, when the ask never became a render. */
  error: string | null;
  setTask: (task: ClipExportTask | null) => void;
  setDestination: (destination: string | null) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useStoryExportStore = create<StoryExportState>()((set) => ({
  task: null,
  destination: null,
  error: null,

  setTask(task) {
    set({ task });
  },

  setDestination(destination) {
    set({ destination });
  },

  setError(error) {
    set({ error });
  },

  reset() {
    set({ task: null, destination: null, error: null });
  },
}));
