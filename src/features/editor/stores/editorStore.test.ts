import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "./editorStore";

describe("promptPanel", () => {
  beforeEach(() => {
    useEditorStore.getState().clearSelection();
    useEditorStore.getState().closePromptPanel();
  });

  it("holds the one node the generation panel is open under", () => {
    expect(useEditorStore.getState().promptPanel).toBeNull();

    useEditorStore.getState().openPromptPanel("node-1");
    expect(useEditorStore.getState().promptPanel).toEqual({
      nodeId: "node-1",
    });

    // Asking another node moves the panel rather than opening a second one.
    useEditorStore.getState().openPromptPanel("node-2");
    expect(useEditorStore.getState().promptPanel).toEqual({
      nodeId: "node-2",
    });

    useEditorStore.getState().closePromptPanel();
    expect(useEditorStore.getState().promptPanel).toBeNull();
  });

  it("keeps the node selected when the panel goes away", () => {
    useEditorStore.getState().selectOnly("node-1");
    useEditorStore.getState().openPromptPanel("node-1");
    useEditorStore.getState().closePromptPanel();
    expect(useEditorStore.getState().selection.nodeIds).toEqual(["node-1"]);
  });
});
