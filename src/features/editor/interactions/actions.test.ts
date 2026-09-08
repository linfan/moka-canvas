import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import {
  GROUP_DETACH_THRESHOLD_PX,
  findNode,
  type GenerationSpec,
  type MokaFile,
} from "../../../shared/domain";
import { execute, redo, undo } from "../commands/execute";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import {
  addNodeAt,
  checkConnection,
  connectPorts,
  copySelection,
  groupSelection,
  marqueeSelect,
  moveNodes,
  pasteAt,
  relatedHighlight,
  renameNode,
  resizeNodeTo,
  selectNodeWithMembers,
  setNodeGeneration,
  ungroupSelection,
} from "./actions";

function hydrate(moka?: MokaFile) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
  });
  return document;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    hoveredNodeId: null,
    hoveredPort: null,
    pointerWorld: null,
    announcement: "",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("marqueeSelect", () => {
  it("selects nodes whose bounds intersect the marquee", () => {
    const ids = goldenNodeIds();
    hydrate();
    // Covers the text node corner only: intersect, not contain.
    marqueeSelect({ x: -400, y: -200, width: 100, height: 100 }, false);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.text]);
  });

  it("keeps the baseline selection in additive mode", () => {
    const ids = goldenNodeIds();
    hydrate();
    selectNodeWithMembers(ids.export, false);
    marqueeSelect({ x: -400, y: -200, width: 100, height: 100 }, true);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      ids.export,
      ids.text,
    ]);
  });
});

describe("checkConnection", () => {
  it("maps domain validation to preview states", () => {
    const ids = goldenNodeIds();
    hydrate();
    expect(
      checkConnection(
        { nodeId: ids.image, portId: "out" },
        { nodeId: ids.operation, portId: "images" },
      ),
    ).toBe("ok");
    // export.video is cardinality one and already occupied.
    expect(
      checkConnection(
        { nodeId: ids.operation, portId: "out" },
        { nodeId: ids.export, portId: "video" },
      ),
    ).toBe("replace");
    // Self-loop is never allowed.
    expect(
      checkConnection(
        { nodeId: ids.operation, portId: "out" },
        { nodeId: ids.operation, portId: "text" },
      ),
    ).toBe("invalid");
  });

  it("follows the extended port table for prompt inputs", () => {
    const ids = goldenNodeIds();
    hydrate();
    expect(
      checkConnection(
        { nodeId: ids.text, portId: "out" },
        { nodeId: ids.image, portId: "prompt" },
      ),
    ).toBe("ok");

    addNodeAt({ x: 900, y: 400 }, "audio", null);
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const audio = canvas.nodes.find((node) => node.kind === "audio")!;
    expect(
      checkConnection(
        { nodeId: ids.image, portId: "out" },
        { nodeId: audio.id, portId: "prompt" },
      ),
    ).toBe("invalid");
  });
});

describe("connectPorts", () => {
  it("replaces an occupied cardinality-one input in one history entry", () => {
    const ids = goldenNodeIds();
    hydrate();
    const before = useHistoryStore.getState().undoStack.length;
    connectPorts(
      { nodeId: ids.operation, portId: "out" },
      { nodeId: ids.export, portId: "video" },
    );
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const incoming = canvas.edges.filter(
      (edge) =>
        edge.target.nodeId === ids.export && edge.target.portId === "video",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0].id).not.toBe(ids.edgeOpExport);
    expect(useHistoryStore.getState().undoStack.length).toBe(before + 1);
  });

  it("rejects cyclic connections without a history entry", () => {
    const ids = goldenNodeIds();
    hydrate();
    const before = useHistoryStore.getState().undoStack.length;
    // export.out (artifact) into operation.text (text) is a type mismatch.
    connectPorts(
      { nodeId: ids.export, portId: "out" },
      { nodeId: ids.operation, portId: "text" },
    );
    expect(useHistoryStore.getState().undoStack.length).toBe(before);
    expect(useAppStore.getState().toasts.length).toBeGreaterThan(0);
  });
});

describe("moveNodes group membership", () => {
  it("detaches a member dragged out past the threshold", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    const member = findNode(canvas, ids.text)!;
    // Pull the text node's center beyond group bounds + threshold.
    moveNodes({
      [ids.text]: {
        x: group.bounds.x + group.bounds.width + GROUP_DETACH_THRESHOLD_PX,
        y: member.bounds.y,
      },
    });
    const after = useProjectStore.getState().moka!.canvas[0];
    // Down to one member, the group auto-dissolves and keeps both nodes.
    expect(after.groups).toHaveLength(0);
    expect(findNode(after, ids.text)).toBeDefined();
    expect(findNode(after, ids.image)).toBeDefined();
  });

  it("attaches a node whose center enters a group frame", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    const operation = findNode(canvas, ids.operation)!;
    // Place the operation node's center well inside the group frame.
    moveNodes({
      [ids.operation]: {
        x: group.bounds.x + group.bounds.width / 2 - operation.bounds.width / 2,
        y:
          group.bounds.y +
          group.bounds.height / 2 -
          operation.bounds.height / 2,
      },
    });
    const after = useProjectStore.getState().moka!.canvas[0];
    expect(
      after.groups.find((g) => g.groupId === group.id)?.childNodeIds,
    ).toContain(ids.operation);
  });

  it("keeps membership when group and members move together", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    const memberIds = canvas.groups.find(
      (g) => g.groupId === group.id,
    )!.childNodeIds;
    const positions: Record<string, { x: number; y: number }> = {
      [group.id]: { x: group.bounds.x + 500, y: group.bounds.y + 500 },
    };
    for (const memberId of memberIds) {
      const member = findNode(canvas, memberId)!;
      positions[memberId] = {
        x: member.bounds.x + 500,
        y: member.bounds.y + 500,
      };
    }
    moveNodes(positions);
    const after = useProjectStore.getState().moka!.canvas[0];
    expect(
      after.groups.find((g) => g.groupId === group.id)?.childNodeIds,
    ).toEqual(memberIds);
  });
});

describe("group/ungroup", () => {
  it("groups a multi-selection and ungroup selects the former members", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    groupSelection();
    let canvas = useProjectStore.getState().moka!.canvas[0];
    const group = canvas.nodes.find((node) => node.kind === "group")!;
    expect(
      canvas.groups.find((g) => g.groupId === group.id)?.childNodeIds,
    ).toEqual([ids.text, ids.image]);

    useEditorStore.getState().setSelection({
      nodeIds: [group.id],
      edgeIds: [],
    });
    ungroupSelection();
    canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.groups).toHaveLength(0);
    expect(useEditorStore.getState().selection.nodeIds).toEqual([
      ids.text,
      ids.image,
    ]);
  });
});

describe("relatedHighlight", () => {
  it("lights direct neighbors of the hovered node", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setHoveredNode(ids.operation);
    const related = relatedHighlight();
    expect(related?.edgeIds.sort()).toEqual(
      [ids.edgeOpExport, ids.edgeTextOp].sort(),
    );
    expect(related?.nodeIds).toEqual(
      expect.arrayContaining([ids.operation, ids.text, ids.export]),
    );
  });

  it("uses the single selected node when nothing is hovered", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.export],
      edgeIds: [],
    });
    const related = relatedHighlight();
    expect(related?.edgeIds).toEqual([ids.edgeOpExport]);
  });

  it("returns null for isolated nodes and multi-selections", () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setHoveredNode(ids.image);
    expect(relatedHighlight()).toBeNull();
    useEditorStore.getState().setHoveredNode(null);
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.image],
      edgeIds: [],
    });
    expect(relatedHighlight()).toBeNull();
  });
});

describe("copy/paste fragment round trip", () => {
  it("clones a connected selection with fresh ids and internal edges only", async () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.text, ids.operation, ids.export],
      edgeIds: [],
    });
    await copySelection();
    const before = useProjectStore.getState().moka!.canvas[0];
    await pasteAt({ x: 800, y: 400 });
    const after = useProjectStore.getState().moka!.canvas[0];
    expect(after.nodes).toHaveLength(before.nodes.length + 3);
    expect(after.edges).toHaveLength(before.edges.length + 2);
    const clones = after.nodes.filter((node) => !before.nodes.includes(node));
    expect(clones.some((node) => node.id === ids.text)).toBe(false);
    const selected = useEditorStore.getState().selection.nodeIds;
    expect(selected.sort()).toEqual(clones.map((node) => node.id).sort());
  });

  it("carries a generation spec across the fragment round trip", async () => {
    hydrate(buildGenerationMokaFile());
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const image = canvas.nodes.find((node) => node.kind === "image")!;
    const spec = (image.data as { generation: GenerationSpec }).generation;

    useEditorStore.getState().setSelection({
      nodeIds: [image.id],
      edgeIds: [],
    });
    await copySelection();
    await pasteAt({ x: 900, y: 400 });

    const after = useProjectStore.getState().moka!.canvas[0];
    const clone = after.nodes.find(
      (node) => node.kind === "image" && node.id !== image.id,
    )!;
    expect((clone.data as { generation?: GenerationSpec }).generation).toEqual(
      spec,
    );
  });

  it("strips asset references missing from the target project", async () => {
    const ids = goldenNodeIds();
    hydrate();
    useEditorStore.getState().setSelection({
      nodeIds: [ids.image],
      edgeIds: [],
    });
    await copySelection();
    // Paste into a project whose registry lacks the image asset.
    const foreign = buildGoldenMokaFile();
    foreign.resources.images = [];
    hydrate(foreign);
    await pasteAt({ x: 0, y: 0 });
    const canvas = useProjectStore.getState().moka!.canvas[0];
    const clone = canvas.nodes.find(
      (node) => node.kind === "image" && node.id !== ids.image,
    )!;
    expect((clone.data as { assetId?: string }).assetId).toBeUndefined();
    expect(
      useAppStore.getState().toasts.some((toast) => toast.kind === "error"),
    ).toBe(true);
  });
});

describe("resizeNodeTo", () => {
  it("commits one undoable bounds change", () => {
    const ids = goldenNodeIds();
    hydrate();
    resizeNodeTo(ids.text, { x: -320, y: -120, width: 400, height: 260 });
    let canvas = useProjectStore.getState().moka!.canvas[0];
    expect(findNode(canvas, ids.text)?.bounds.width).toBe(400);
    undo();
    canvas = useProjectStore.getState().moka!.canvas[0];
    expect(findNode(canvas, ids.text)?.bounds.width).toBe(280);
  });
});

describe("renameNode", () => {
  it("trims and skips empty or unchanged titles", () => {
    const ids = goldenNodeIds();
    hydrate();
    renameNode(ids.text, "   ");
    renameNode(ids.text, "Brief");
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
    renameNode(ids.text, "  Shot list  ");
    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(findNode(canvas, ids.text)?.title).toBe("Shot list");
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);
  });
});

describe("setNodeGeneration", () => {
  function specOf(nodeId: string): GenerationSpec | undefined {
    const canvas = useProjectStore.getState().moka!.canvas[0];
    return (findNode(canvas, nodeId)!.data as { generation?: GenerationSpec })
      .generation;
  }

  function hydrateSpecNode() {
    const moka = hydrate(buildGenerationMokaFile());
    const canvas = moka.canvas[0];
    const image = canvas.nodes.find((node) => node.kind === "image")!;
    return {
      canvasId: canvas.id,
      nodeId: image.id,
      spec: (image.data as { generation: GenerationSpec }).generation,
    };
  }

  it("rewrites and clears a spec through undo and redo", () => {
    const { canvasId, nodeId, spec } = hydrateSpecNode();

    setNodeGeneration(canvasId, nodeId, {
      ...spec,
      prompt: "Repaint at dusk.",
    });
    expect(specOf(nodeId)?.prompt).toBe("Repaint at dusk.");

    undo();
    expect(specOf(nodeId)).toEqual(spec);
    redo();
    expect(specOf(nodeId)?.prompt).toBe("Repaint at dusk.");

    setNodeGeneration(canvasId, nodeId, null);
    expect(specOf(nodeId)).toBeUndefined();
    undo();
    expect(specOf(nodeId)?.prompt).toBe("Repaint at dusk.");
  });

  it("records one entry per committed change, not per keystroke", () => {
    const { canvasId, nodeId, spec } = hydrateSpecNode();

    setNodeGeneration(canvasId, nodeId, { ...spec, prompt: "A lan" });
    setNodeGeneration(canvasId, nodeId, { ...spec, prompt: "A lan" });
    setNodeGeneration(canvasId, nodeId, { ...spec, prompt: "A lantern" });

    expect(useHistoryStore.getState().undoStack).toHaveLength(2);
  });

  it("leaves structural nodes alone", () => {
    const ids = goldenNodeIds();
    hydrate();
    setNodeGeneration(ids.canvasMain, ids.operation, {
      capability: "text",
      mode: "generate",
      model: "",
      prompt: "Summarise the board",
      inputMode: "upstream",
      params: {},
      referenceNodeIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(specOf(ids.operation)).toBeUndefined();
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);
  });
});

describe("group drag integration", () => {
  it("selecting a group member keeps members together through moves", () => {
    const ids = goldenNodeIds();
    hydrate();
    execute("Group", [
      {
        type: "addNode",
        canvasId: ids.canvasMain,
        node: {
          ...findNode(buildGoldenMokaFile().canvas[0], ids.text)!,
          id: "grp-1",
          kind: "group",
          title: "Group",
          ports: [],
          bounds: { x: -400, y: -200, width: 800, height: 700 },
          data: { color: "#6d8cff", childNodeIds: [ids.text, ids.image] },
        },
      },
      {
        type: "setGroupMembership",
        canvasId: ids.canvasMain,
        groupId: "grp-1",
        childNodeIds: [ids.text, ids.image],
      },
    ]);
    selectNodeWithMembers("grp-1", false);
    expect(useEditorStore.getState().selection.nodeIds.sort()).toEqual(
      ["grp-1", ids.image, ids.text].sort(),
    );
  });
});
