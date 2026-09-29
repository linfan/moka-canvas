import { create } from "zustand";

/** What a save is being asked: what it is called, the name offered, and the
 * kinds of file worth showing beside the folders. */
export interface SaveAsk {
  title: string;
  /** The name the file is offered under, extension and all. */
  defaultName: string;
  /** The extensions worth showing, and the one a typed name is completed
   * with. */
  extensions: string[];
}

/** The question standing, with the promise that answers it. */
interface Standing extends SaveAsk {
  reply: (path: string | null) => void;
}

interface SavePathState {
  pending: Standing | null;
  ask: (ask: SaveAsk) => Promise<string | null>;
  /** Answers the question standing, and takes it down. */
  reply: (path: string | null) => void;
}

/**
 * The save a reader is being asked about, for the runtime that draws the
 * dialog itself.
 *
 * Asked through a store rather than rendered by the caller because not every
 * caller is a component: the board's image export is a plain function, and the
 * dialog that stands in for the operating system's belongs to the window that
 * is up rather than to whichever button asked.
 */
export const useSavePathStore = create<SavePathState>()((set, get) => ({
  pending: null,
  ask(ask) {
    // One at a time: a second question while the first stands has no dialog to
    // be drawn in, so it is answered rather than left hanging.
    if (get().pending !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      set({ pending: { ...ask, reply: resolve } });
    });
  },
  reply(path) {
    const pending = get().pending;
    set({ pending: null });
    pending?.reply(path);
  },
}));
