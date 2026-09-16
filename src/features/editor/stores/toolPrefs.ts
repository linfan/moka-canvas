import { create } from "zustand";
import type { PictureTool } from "../../../api/tools";
import { MAX_DIVISIONS } from "../../../shared/domain";

/** The tools that work on a picture here, without asking anybody for anything. */
export const PICTURE_TOOLS: readonly PictureTool[] = [
  "crop",
  "split",
  "resize",
  "tilt",
];

/**
 * Everything the bar can offer, in the order it offers them.
 *
 * Wider than the local tools: a repaint and a reading-back both ask a model
 * rather than working the pixels here, but they are offered in the same row and
 * hidden by the same setting, because from the node each is one more way of
 * getting something out of the picture that is there.
 */
export type BarEntry = PictureTool | "repaint" | "describe";

export const BAR_ENTRIES: readonly BarEntry[] = [
  ...PICTURE_TOOLS,
  "repaint",
  "describe",
];

/**
 * The entries answered by a dialog of their own.
 *
 * What each of them asks for is not a set of numbers: one is a region drawn on
 * the picture, and the other is a question put to a model that can see it. Both
 * are asked of a picture and both end in a model, which is what makes them one
 * kind of thing apart from the four that work the pixels here.
 */
export const ASKING_A_MODEL: readonly BarEntry[] = ["repaint", "describe"];

/**
 * Whether an entry is one of the four that work the pixels here.
 *
 * Asked rather than compared against a list of four, so an entry added to either
 * side moves both answers with it.
 */
export function isPictureTool(entry: BarEntry): entry is PictureTool {
  return !ASKING_A_MODEL.includes(entry);
}

/**
 * What each entry is called on the bar.
 *
 * "Resample" rather than "resize" because a resize here is arithmetic on the
 * pixels that are there: it can make a picture smaller cleanly and larger only
 * by guessing, and the word has to say which of those it is doing before the
 * model that can actually add detail is offered beside it.
 */
export const TOOL_LABELS: Record<BarEntry, string> = {
  crop: "editor:tool.crop",
  split: "editor:tool.split",
  resize: "editor:tool.resize",
  tilt: "editor:tool.tilt",
  repaint: "editor:tool.repaint",
  describe: "editor:tool.describe",
};

/** The ratios the crop field offers before anything is typed into it. */
export const CROP_RATIOS: readonly string[] = [
  "1:1",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
];

/** The grids the split field offers before anything is typed into it. */
export const SPLIT_GRIDS: readonly { rows: number; cols: number }[] = [
  { rows: 1, cols: 2 },
  { rows: 2, cols: 2 },
  { rows: 3, cols: 3 },
];

/** The widest a division may be asked for, which is the piece ceiling's root. */
export const MAX_DIVISIONS_PER_SIDE = Math.floor(Math.sqrt(MAX_DIVISIONS));

interface StoredPrefs {
  shown: BarEntry[];
  cropRatio: string | null;
  grid: { rows: number; cols: number } | null;
}

const START: StoredPrefs = {
  shown: [...BAR_ENTRIES],
  cropRatio: null,
  grid: null,
};

/**
 * Where these are kept: the browser's own store on this machine.
 *
 * Which tools somebody likes to see, and the grid they last divided by, are
 * about them rather than about the work, so they are kept beside the work and
 * never inside it — a package handed to somebody else carries none of it.
 */
const STORED_UNDER = "moka-canvas:picture-tools";

function read(): StoredPrefs {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return START;
  try {
    const kept = localStorage.getItem(STORED_UNDER);
    if (!kept) return START;
    const parsed = JSON.parse(kept) as Partial<StoredPrefs>;
    return {
      shown: Array.isArray(parsed.shown)
        ? BAR_ENTRIES.filter((entry) => parsed.shown?.includes(entry))
        : START.shown,
      cropRatio: typeof parsed.cropRatio === "string" ? parsed.cropRatio : null,
      grid:
        parsed.grid &&
        Number.isInteger(parsed.grid.rows) &&
        Number.isInteger(parsed.grid.cols)
          ? { rows: parsed.grid.rows, cols: parsed.grid.cols }
          : null,
    };
  } catch {
    // A store this cannot read is one that has nothing in it.
    return START;
  }
}

function keep(prefs: StoredPrefs) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORED_UNDER, JSON.stringify(prefs));
  } catch {
    // A store that will not take it costs the remembering, not the tool.
  }
}

export interface ToolPrefsState extends StoredPrefs {
  toggleShown: (entry: BarEntry) => void;
  rememberCrop: (ratio: string | null) => void;
  rememberGrid: (grid: { rows: number; cols: number } | null) => void;
}

const prefsOf = (state: ToolPrefsState): StoredPrefs => ({
  shown: state.shown,
  cropRatio: state.cropRatio,
  grid: state.grid,
});

export const useToolPrefs = create<ToolPrefsState>()((set, get) => {
  const write = (next: StoredPrefs) => {
    keep(next);
    set(next);
  };
  return {
    ...read(),
    // Put back in the order the bar offers them, so an entry hidden and shown
    // again does not move to the end of the row.
    toggleShown: (entry) =>
      write({
        ...prefsOf(get()),
        shown: BAR_ENTRIES.filter((candidate) =>
          candidate === entry
            ? !get().shown.includes(entry)
            : get().shown.includes(candidate),
        ),
      }),
    rememberCrop: (ratio) => write({ ...prefsOf(get()), cropRatio: ratio }),
    rememberGrid: (grid) => write({ ...prefsOf(get()), grid }),
  };
});
