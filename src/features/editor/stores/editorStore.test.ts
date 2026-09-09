import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "./editorStore";

describe("promptPanel", () => {
  beforeEach(() => {
    useEditorStore.getState().clearSelection();
    useEditorStore.getState().closePromptPanel();
    useEditorStore.setState({ promptPanelOnSelect: true });
  });

  it("holds the one node the generation panel is open under", () => {
    expect(useEditorStore.getState().promptPanel).toBeNull();

    // Coming up beside a selection leaves the keyboard where it was...
    useEditorStore.getState().openPromptPanel("node-1");
    expect(useEditorStore.getState().promptPanel).toEqual({
      nodeId: "node-1",
      focus: false,
    });

    // ...while an entry the user chose takes it, and moves the panel rather
    // than opening a second one.
    useEditorStore.getState().openPromptPanel("node-2", true);
    expect(useEditorStore.getState().promptPanel).toEqual({
      nodeId: "node-2",
      focus: true,
    });

    useEditorStore.getState().closePromptPanel();
    expect(useEditorStore.getState().promptPanel).toBeNull();
  });

  it("remembers whether the panel comes up with a selection", () => {
    expect(useEditorStore.getState().promptPanelOnSelect).toBe(true);
    useEditorStore.getState().togglePromptPanelOnSelect();
    expect(useEditorStore.getState().promptPanelOnSelect).toBe(false);
    useEditorStore.getState().togglePromptPanelOnSelect();
    expect(useEditorStore.getState().promptPanelOnSelect).toBe(true);
  });

  it("keeps the node selected when the panel goes away", () => {
    useEditorStore.getState().selectOnly("node-1");
    useEditorStore.getState().openPromptPanel("node-1");
    useEditorStore.getState().closePromptPanel();
    expect(useEditorStore.getState().selection.nodeIds).toEqual(["node-1"]);
  });
});
