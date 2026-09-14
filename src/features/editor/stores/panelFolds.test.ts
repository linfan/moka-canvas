// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelFolds } from "./panelFolds";

const KEPT_UNDER = "moka-canvas:panel-folds";

describe("panelFolds", () => {
  beforeEach(() => {
    localStorage.clear();
    usePanelFolds.setState({ left: false, right: false });
  });

  it("starts with both columns standing", () => {
    expect(usePanelFolds.getState().left).toBe(false);
    expect(usePanelFolds.getState().right).toBe(false);
  });

  it("folds one column away without asking the other about it", () => {
    usePanelFolds.getState().toggle("left");
    expect(usePanelFolds.getState().left).toBe(true);
    expect(usePanelFolds.getState().right).toBe(false);

    usePanelFolds.getState().toggle("left");
    expect(usePanelFolds.getState().left).toBe(false);
  });

  it("folds a column to the state it was asked for", () => {
    usePanelFolds.getState().setFolded("right", true);
    usePanelFolds.getState().setFolded("right", true);
    expect(usePanelFolds.getState().right).toBe(true);
    // The column on the other side is still standing.
    expect(usePanelFolds.getState().left).toBe(false);

    usePanelFolds.getState().setFolded("right", false);
    expect(usePanelFolds.getState().right).toBe(false);
  });

  it("keeps what was folded in the browser's own store, and reads it back", async () => {
    usePanelFolds.getState().setFolded("left", true);
    expect(JSON.parse(localStorage.getItem(KEPT_UNDER)!)).toEqual({
      left: true,
      right: false,
    });

    // Read again the way a second visit to the editor reads: from what was kept.
    vi.resetModules();
    const kept = await import("./panelFolds");
    expect(kept.usePanelFolds.getState().left).toBe(true);
    expect(kept.usePanelFolds.getState().right).toBe(false);
  });

  it("takes nothing from a store holding something else", async () => {
    localStorage.setItem(KEPT_UNDER, JSON.stringify({ left: "folded away" }));

    vi.resetModules();
    const kept = await import("./panelFolds");
    expect(kept.usePanelFolds.getState().left).toBe(false);
    expect(kept.usePanelFolds.getState().right).toBe(false);
  });

  it("takes nothing from a store it cannot read at all", async () => {
    localStorage.setItem(KEPT_UNDER, "not a store of folds");

    vi.resetModules();
    const kept = await import("./panelFolds");
    expect(kept.usePanelFolds.getState().left).toBe(false);
  });
});
