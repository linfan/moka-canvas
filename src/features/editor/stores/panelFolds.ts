import { create } from "zustand";
import type { PanelSide } from "./panelWidths";

/**
 * Whether each column beside the canvas is folded away.
 *
 * A column folded is a column out of the way rather than a column gone: what
 * it showed is still there and one click brings it back, so the canvas can be
 * given the whole window for as long as it is worth doing. Which columns are
 * folded is about the reader and their window rather than about the work, so
 * it is kept beside the widths they dragged and never inside a project.
 */
interface StoredFolds {
  left: boolean;
  right: boolean;
}

const START: StoredFolds = { left: false, right: false };

const STORED_UNDER = "moka-canvas:panel-folds";

function read(): StoredFolds {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return START;
  try {
    const kept = localStorage.getItem(STORED_UNDER);
    if (!kept) return START;
    const parsed = JSON.parse(kept) as Partial<StoredFolds>;
    return {
      left: parsed.left === true,
      right: parsed.right === true,
    };
  } catch {
    // A store this cannot read is one that has nothing in it.
    return START;
  }
}

function keep(folds: StoredFolds) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORED_UNDER, JSON.stringify(folds));
  } catch {
    // A store that will not take it costs the remembering, not the folding.
  }
}

export interface PanelFoldsState extends StoredFolds {
  /** Fold a column away, or bring the one that was folded back. */
  setFolded: (side: PanelSide, folded: boolean) => void;
  /** What the corner triangle does: the column goes the other way round. */
  toggle: (side: PanelSide) => void;
}

const foldsOf = (state: PanelFoldsState): StoredFolds => ({
  left: state.left,
  right: state.right,
});

export const usePanelFolds = create<PanelFoldsState>()((set, get) => {
  const write = (next: StoredFolds) => {
    keep(next);
    set(next);
  };
  return {
    ...read(),
    setFolded: (side, folded) => write({ ...foldsOf(get()), [side]: folded }),
    toggle: (side) => write({ ...foldsOf(get()), [side]: !get()[side] }),
  };
});
