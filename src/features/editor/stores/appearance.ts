import { create } from "zustand";
import { CANVAS_THEME_NAMES, type CanvasThemeName } from "../canvas/theme";

/**
 * Where the choice of canvas palette is kept: the browser's own store on this
 * machine. Which colors somebody likes to work in is about them rather than
 * about the work, so it is kept beside the project and never inside it — a
 * package handed to somebody else carries none of it.
 */
const STORED_UNDER = "moka-canvas:canvas-theme";

function read(): CanvasThemeName {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return "graphite";
  try {
    const kept = localStorage.getItem(STORED_UNDER);
    return CANVAS_THEME_NAMES.find((name) => name === kept) ?? "graphite";
  } catch {
    // A store this cannot read is one that has nothing in it.
    return "graphite";
  }
}

function keep(theme: CanvasThemeName) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORED_UNDER, theme);
  } catch {
    // A store that will not take it costs the remembering, not the choice.
  }
}

export interface AppearanceState {
  theme: CanvasThemeName;
  setTheme: (theme: CanvasThemeName) => void;
}

export const useAppearance = create<AppearanceState>()((set) => ({
  theme: read(),
  setTheme: (theme) => {
    keep(theme);
    set({ theme });
  },
}));
