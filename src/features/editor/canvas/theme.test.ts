import { describe, expect, it } from "vitest";
import {
  CANVAS_THEMES,
  CANVAS_THEME_LABELS,
  CANVAS_THEME_NAMES,
  applyCanvasTheme,
  canvasTheme,
} from "./theme";

const NODE_KINDS = [
  "text",
  "image",
  "audio",
  "video",
  "operation",
  "group",
  "export",
];

const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];

describe("the palettes a canvas can be drawn in", () => {
  it("names every theme it offers", () => {
    for (const name of CANVAS_THEME_NAMES) {
      expect(CANVAS_THEME_LABELS[name]).toBeTruthy();
      expect(CANVAS_THEMES[name]).toBeTruthy();
    }
  });

  it("keeps the two palettes answering to the same keys", () => {
    // A field one palette has and the other has not is a drawing that comes
    // out grey the moment somebody switches.
    expect(Object.keys(CANVAS_THEMES.paper).sort()).toEqual(
      Object.keys(CANVAS_THEMES.graphite).sort(),
    );
    for (const name of CANVAS_THEME_NAMES) {
      const palette = CANVAS_THEMES[name];
      for (const kind of NODE_KINDS)
        expect(palette.kindAccent[kind]).toBeTruthy();
      for (const status of RUN_STATUSES)
        expect(palette.runStatus[status]).toBeTruthy();
    }
  });

  it("paints the next frame in whichever palette was chosen", () => {
    applyCanvasTheme("paper");
    expect(canvasTheme.background).toBe(CANVAS_THEMES.paper.background);
    expect(canvasTheme.nodeFill).toBe(CANVAS_THEMES.paper.nodeFill);
    applyCanvasTheme("graphite");
    expect(canvasTheme.background).toBe(CANVAS_THEMES.graphite.background);
  });
});
