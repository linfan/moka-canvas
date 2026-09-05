import { create } from "zustand";
import { HISTORY_LIMIT, type DocumentCommand } from "../../../shared/domain";

export interface HistoryEntry {
  id: string;
  label: string;
  forwardCommands: DocumentCommand[];
  inverseCommands: DocumentCommand[];
}

/** Marker pushed when the canvas or project context changes; undo/redo never cross it. */
export interface HistoryBoundary {
  boundary: true;
  label: string;
}

export type HistoryItem = HistoryEntry | HistoryBoundary;

export function isBoundary(item: HistoryItem): item is HistoryBoundary {
  return "boundary" in item;
}

interface HistoryState {
  undoStack: HistoryItem[];
  redoStack: HistoryEntry[];
  record: (entry: HistoryEntry) => void;
  pushBoundary: (label: string) => void;
  /** Pops the newest undoable entry; null when a boundary or the bottom is hit. */
  takeUndo: () => HistoryEntry | null;
  /** Pushes an entry back after a failed undo application. */
  restoreUndo: (entry: HistoryEntry) => void;
  takeRedo: () => HistoryEntry | null;
  pushRedo: (entry: HistoryEntry) => void;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  undoStack: [],
  redoStack: [],

  record(entry) {
    set((state) => {
      const undoStack = [...state.undoStack, entry];
      while (undoStack.length > HISTORY_LIMIT) {
        const index = undoStack.findIndex((item) => !isBoundary(item));
        if (index === -1) break;
        undoStack.splice(index, 1);
      }
      return { undoStack, redoStack: [] };
    });
  },

  pushBoundary(label) {
    set((state) => ({
      undoStack: [...state.undoStack, { boundary: true, label }],
      redoStack: [],
    }));
  },

  takeUndo() {
    const { undoStack } = get();
    const item = undoStack[undoStack.length - 1];
    if (!item || isBoundary(item)) return null;
    set({ undoStack: undoStack.slice(0, -1) });
    return item;
  },

  restoreUndo(entry) {
    set((state) => ({ undoStack: [...state.undoStack, entry] }));
  },

  takeRedo() {
    const { redoStack } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return null;
    set({ redoStack: redoStack.slice(0, -1) });
    return entry;
  },

  pushRedo(entry) {
    set((state) => ({ redoStack: [...state.redoStack, entry] }));
  },

  clear() {
    set({ undoStack: [], redoStack: [] });
  },
}));
