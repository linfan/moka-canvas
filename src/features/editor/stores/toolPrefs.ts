import { create } from "zustand";
import type { PictureTool } from "../../../api/tools";
import { MAX_DIVISIONS } from "../../../shared/domain";

/** Every tool the bar can offer, in the order it offers them. */
export const PICTURE_TOOLS: readonly PictureTool[] = [
  "crop",
  "split",
  "resize",
  "tilt",
];

/**
 * What each tool is called on the bar.
 *
 * "Resample" rather than "resize" because a resize here is arithmetic on the
 * pixels that are there: it can make a picture smaller cleanly and larger only
 * by guessing, and the word has to say which of those it is doing before the
 * model that can actually add detail is offered beside it.
 */
export const TOOL_LABELS: Record<PictureTool, string> = {
  crop: "Crop",
  split: "Split",
  resize: "Resample",
  tilt: "Tilt",
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
  shown: PictureTool[];
  cropRatio: string | null;
  grid: { rows: number; cols: number } | null;
}

const START: StoredPrefs = {
  shown: [...PICTURE_TOOLS],
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
        ? PICTURE_TOOLS.filter((tool) => parsed.shown?.includes(tool))
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
  toggleShown: (tool: PictureTool) => void;
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
    // Put back in the order the bar offers them, so a tool hidden and shown
    // again does not move to the end of the row.
    toggleShown: (tool) =>
      write({
        ...prefsOf(get()),
        shown: PICTURE_TOOLS.filter((entry) =>
          entry === tool
            ? !get().shown.includes(tool)
            : get().shown.includes(entry),
        ),
      }),
    rememberCrop: (ratio) => write({ ...prefsOf(get()), cropRatio: ratio }),
    rememberGrid: (grid) => write({ ...prefsOf(get()), grid }),
  };
});
