import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import {
  MAX_PROMPT_LENGTH,
  MAX_RESULT_SLOTS,
  PROVIDER_EXECUTOR_KEY,
  type Capability,
} from "./constants";
import { buildGoldenMokaFile, goldenNodeIds } from "./fixtures";
import {
  createCanvas,
  createNode,
  executorKeyForNode,
  generationSpecFromSnapshot,
} from "./factories";
import { newId } from "./ids";
import type {
  CanvasDocument,
  DocumentCommand,
  GenerationSpec,
  MokaFile,
  ResultSlot,
  WorkflowNode,
} from "./types";
import {
  mentionNodeIds,
  modelReferenceShaped,
  topologicalOrder,
  validateBounds,
  validateCanvas,
  validateEdgeCandidate,
  validateMokaFile,
  validateResourcePath,
} from "./validate";

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as CommandError).code;
  }
  return "OK";
}

describe("graph validation", () => {
  it("accepts the golden document", () => {
    expect(validateMokaFile(buildGoldenMokaFile())).toEqual([]);
  });

  it("rejects incompatible port types", () => {
    const moka = buildGoldenMokaFile();
    const canvas = moka.canvas[0];
    const result = validateEdgeCandidate(
      canvas,
      { nodeId: goldenNodeIds().text, portId: "out" },
      { nodeId: goldenNodeIds().export, portId: "audio" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("PORT_TYPE_MISMATCH");
  });

  it("rejects self loops", () => {
    const moka = buildGoldenMokaFile();
    const result = validateEdgeCandidate(
      moka.canvas[0],
      { nodeId: goldenNodeIds().operation, portId: "out" },
      { nodeId: goldenNodeIds().operation, portId: "text" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SELF_LOOP");
  });

  it("rejects a second edge into a one-cardinality input", () => {
    const moka = buildGoldenMokaFile();
    const canvas = moka.canvas[0];
    const imageNode = createNode("image", { x: 0, y: 0 });
    canvas.nodes.push(imageNode);
    const result = validateEdgeCandidate(
      canvas,
      { nodeId: imageNode.id, portId: "out" },
      { nodeId: goldenNodeIds().operation, portId: "images" },
    );
    expect(result.ok).toBe(true);

    const extraImage = createNode("image", { x: 0, y: 400 });
    canvas.nodes.push(extraImage);
    const result2 = validateEdgeCandidate(
      canvas,
      { nodeId: extraImage.id, portId: "out" },
      { nodeId: goldenNodeIds().export, portId: "video" },
    );
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.code).toBe("PORT_TYPE_MISMATCH");
  });

  it("detects cycles", () => {
    const moka = buildGoldenMokaFile();
    const result = validateEdgeCandidate(
      moka.canvas[0],
      { nodeId: goldenNodeIds().operation, portId: "out" },
      { nodeId: goldenNodeIds().operation, portId: "text" },
    );
    expect(result.ok).toBe(false);

    // text → operation exists; operation → text would close a cycle if
    // text had an input. Build the cycle manually with two operations.
    const opA = createNode("operation", { x: 0, y: 0 });
    const opB = createNode("operation", { x: 400, y: 0 });
    const canvas = { ...moka.canvas[0], nodes: [opA, opB], edges: [] };
    const ab = validateEdgeCandidate(
      canvas,
      { nodeId: opA.id, portId: "out" },
      { nodeId: opB.id, portId: "text" },
    );
    expect(ab.ok).toBe(true);
    const withEdge = {
      ...canvas,
      edges: [
        {
          id: newId(),
          source: { nodeId: opA.id, portId: "out" },
          target: { nodeId: opB.id, portId: "text" },
          createdAt: new Date(0).toISOString(),
        },
      ],
    };
    const cycle = validateEdgeCandidate(
      withEdge,
      { nodeId: opB.id, portId: "out" },
      { nodeId: opA.id, portId: "text" },
    );
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.code).toBe("GRAPH_CYCLE");
  });

  it("rejects invalid bounds and escaping paths", () => {
    expect(validateBounds({ x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(validateBounds({ x: NaN, y: 0, width: 10, height: 10 })).toBe(false);
    expect(validateBounds({ x: 0, y: 0, width: -1, height: 10 })).toBe(false);
    expect(validateBounds({ x: 2_000_000, y: 0, width: 10, height: 10 })).toBe(
      false,
    );

    expect(validateResourcePath("assets/images/a.png")).toBe(true);
    expect(validateResourcePath("../a.png")).toBe(false);
    expect(validateResourcePath("/etc/passwd")).toBe(false);
    expect(validateResourcePath("assets/../a.png")).toBe(false);
    expect(validateResourcePath("assets\\a.png")).toBe(false);
    expect(validateResourcePath("C:/a.png")).toBe(false);
  });

  it("orders nodes topologically with deterministic tie-breaks", () => {
    const moka = buildGoldenMokaFile();
    const ordered = topologicalOrder(moka.canvas[0]).map((n) => n.id);
    const ids = goldenNodeIds();
    expect(ordered.indexOf(ids.text)).toBeLessThan(
      ordered.indexOf(ids.operation),
    );
    expect(ordered.indexOf(ids.operation)).toBeLessThan(
      ordered.indexOf(ids.export),
    );
  });

  it("flags dangling asset references", () => {
    const moka = buildGoldenMokaFile();
    moka.resources.images = [];
    const issues = validateMokaFile(moka);
    expect(issues.some((i) => i.code === "ASSET_MISSING")).toBe(true);
  });
});

describe("generation validation", () => {
  const ids = goldenNodeIds();

  function goldenCanvas(): CanvasDocument {
    return buildGoldenMokaFile().canvas[0];
  }

  function nodeOf(canvas: CanvasDocument, id: string): WorkflowNode {
    const node = canvas.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`golden canvas has no node ${id}`);
    return node;
  }

  function spec(capability: Capability, prompt: string): GenerationSpec {
    return {
      capability,
      mode: "generate",
      model: "",
      prompt,
      inputMode: "upstream",
      params: {},
      referenceNodeIds: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  function patchData(node: WorkflowNode, patch: Record<string, unknown>) {
    Object.assign(node.data as Record<string, unknown>, patch);
  }

  function flagged(canvas: CanvasDocument, nodeId: string, code: string) {
    return validateCanvas(canvas).some(
      (issue) => issue.code === code && issue.nodeId === nodeId,
    );
  }

  function messages(canvas: CanvasDocument, code: string): string[] {
    return validateCanvas(canvas)
      .filter((issue) => issue.code === code)
      .map((issue) => issue.message);
  }

  it("accepts a canvas whose nodes carry no spec", () => {
    expect(validateCanvas(goldenCanvas())).toEqual([]);
  });

  it("flags a spec that disagrees with its node", () => {
    const canvas = goldenCanvas();
    const broken = spec("image", "Redraw @[node:missing] in ink");
    broken.model = "painter";
    patchData(nodeOf(canvas, ids.text), { generation: broken });

    expect(flagged(canvas, ids.text, "GENERATION_CAPABILITY_MISMATCH")).toBe(
      true,
    );
    expect(flagged(canvas, ids.text, "GENERATION_MODEL_MISSING")).toBe(true);
    expect(flagged(canvas, ids.text, "MENTION_NODE_NOT_FOUND")).toBe(true);
  });

  it("refuses specs on structural nodes", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.operation), {
      generation: spec("text", "Summarise the board"),
    });
    expect(
      flagged(canvas, ids.operation, "GENERATION_CAPABILITY_MISMATCH"),
    ).toBe(true);
  });

  it("flags a prompt that mentions its own node", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.text), {
      generation: spec("text", `Rewrite @[node:${ids.text}]`),
    });
    expect(flagged(canvas, ids.text, "MENTION_SELF_REFERENCE")).toBe(true);
  });

  it("needs an upstream prompt or references when the prompt is empty", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.text), { generation: spec("text", "   ") });
    patchData(nodeOf(canvas, ids.image), { generation: spec("image", "") });
    expect(flagged(canvas, ids.text, "GENERATION_PROMPT_EMPTY")).toBe(true);
    expect(flagged(canvas, ids.image, "GENERATION_PROMPT_EMPTY")).toBe(true);

    canvas.edges.push({
      id: newId(),
      source: { nodeId: ids.text, portId: "out" },
      target: { nodeId: ids.image, portId: "prompt" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(flagged(canvas, ids.image, "GENERATION_PROMPT_EMPTY")).toBe(false);
    expect(
      validateCanvas(canvas).some((i) => i.code === "PORT_TYPE_MISMATCH"),
    ).toBe(false);
    expect(flagged(canvas, ids.text, "GENERATION_PROMPT_EMPTY")).toBe(true);
  });

  it("accepts an empty prompt that lists references", () => {
    const canvas = goldenCanvas();
    const manual = spec("image", "");
    manual.inputMode = "manual";
    manual.referenceNodeIds = [ids.text];
    patchData(nodeOf(canvas, ids.image), { generation: manual });
    expect(flagged(canvas, ids.image, "GENERATION_PROMPT_EMPTY")).toBe(false);
  });

  it("rejects parameters outside the capability whitelist", () => {
    const canvas = goldenCanvas();
    const withParams = spec("image", "A poster of the lake");
    withParams.params = { size: "1:1", brush: "wet" };
    patchData(nodeOf(canvas, ids.image), { generation: withParams });
    expect(messages(canvas, "VALIDATION_FAILED")).toEqual([
      'Unknown parameter "brush" for image generation',
    ]);
  });

  it("rejects an overlong prompt", () => {
    const canvas = goldenCanvas();
    patchData(nodeOf(canvas, ids.text), {
      generation: spec("text", "a".repeat(MAX_PROMPT_LENGTH + 1)),
    });
    expect(messages(canvas, "VALIDATION_FAILED")).toEqual([
      `Generation prompt exceeds the ${MAX_PROMPT_LENGTH} character limit`,
    ]);
  });

  it("enforces the result slot limit", () => {
    const canvas = goldenCanvas();
    const slots: ResultSlot[] = Array.from(
      { length: MAX_RESULT_SLOTS + 1 },
      (_, index) => ({
        id: `slot-${index}`,
        status: "empty" as const,
        isPrimary: index === 0,
      }),
    );
    patchData(nodeOf(canvas, ids.operation), { resultSlots: slots });
    expect(flagged(canvas, ids.operation, "RESULT_SLOT_LIMIT")).toBe(true);
  });

  it("scans mentions and model references", () => {
    expect(mentionNodeIds("Paint @[node:a] beside @[node:b]")).toEqual([
      "a",
      "b",
    ]);
    expect(mentionNodeIds("no mentions here")).toEqual([]);
    expect(mentionNodeIds("@[node:] and @[node")).toEqual([]);

    expect(modelReferenceShaped("main::painter")).toBe(true);
    expect(modelReferenceShaped("::painter")).toBe(false);
    expect(modelReferenceShaped("main::")).toBe(false);
    expect(modelReferenceShaped("painter")).toBe(false);
  });
});

describe("document commands", () => {
  function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
    return applyCommands(moka, commands);
  }

  it("adds and removes a node with exact inverse", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const node = createNode("text", { x: 800, y: 200 });
    const { next, inverse } = apply(moka, {
      type: "addNode",
      canvasId,
      node,
    });
    expect(next.canvas[0].nodes).toHaveLength(5);
    const undone = apply(next, ...inverse).next;
    expect(undone.canvas[0].nodes).toHaveLength(4);
    expect(undone.canvas[0].nodes.map((n) => n.id)).toEqual(
      moka.canvas[0].nodes.map((n) => n.id),
    );
  });

  it("moves nodes and restores positions via inverse", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    const { next, inverse } = apply(moka, {
      type: "moveNodes",
      canvasId,
      positions: { [ids.text]: { x: 10, y: 20 } },
    });
    const moved = next.canvas[0].nodes.find((n) => n.id === ids.text)!;
    expect(moved.bounds.x).toBe(10);
    const undone = apply(next, ...inverse).next;
    const restored = undone.canvas[0].nodes.find((n) => n.id === ids.text)!;
    expect(restored.bounds.x).toBe(-320);
  });

  it("removes a node together with its incident edges", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const { next, inverse } = apply(moka, {
      type: "removeNodes",
      canvasId,
      nodeIds: [goldenNodeIds().operation],
    });
    expect(next.canvas[0].nodes).toHaveLength(3);
    expect(next.canvas[0].edges).toHaveLength(0);
    const undone = apply(next, ...inverse).next;
    expect(undone.canvas[0].nodes).toHaveLength(4);
    expect(undone.canvas[0].edges).toHaveLength(2);
  });

  it("rejects invalid edges at the command boundary", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addEdge",
          canvasId,
          edge: {
            id: newId(),
            source: { nodeId: ids.text, portId: "out" },
            target: { nodeId: ids.export, portId: "audio" },
            createdAt: new Date(0).toISOString(),
          },
        }),
      ),
    ).toBe("PORT_TYPE_MISMATCH");
  });

  it("clamps the viewport zoom range", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const { next } = apply(moka, {
      type: "setViewport",
      canvasId,
      viewport: { x: 0, y: 0, zoom: 99 },
    });
    expect(next.canvas[0].viewport.zoom).toBe(5);
  });

  it("adds, renames, reorders, and removes canvases", () => {
    const moka = buildGoldenMokaFile();
    const canvas = createCanvas("Scratch");
    const { next: added, inverse: addInverse } = apply(moka, {
      type: "addCanvas",
      canvas,
    });
    expect(added.canvas.map((c) => c.name)).toEqual([
      "Canvas 1",
      "Canvas 2",
      "Scratch",
    ]);

    const { next: renamed } = apply(added, {
      type: "renameCanvas",
      canvasId: canvas.id,
      name: "Ideas",
    });
    expect(renamed.canvas[2].name).toBe("Ideas");

    const { next: reordered } = apply(renamed, {
      type: "reorderCanvas",
      canvasId: canvas.id,
      index: 0,
    });
    expect(reordered.canvas[0].name).toBe("Ideas");

    const { next: removed } = apply(reordered, {
      type: "removeCanvas",
      canvasId: canvas.id,
    });
    expect(removed.canvas).toHaveLength(2);

    const undone = apply(added, ...addInverse).next;
    expect(undone.canvas.map((c) => c.id)).toEqual(
      moka.canvas.map((c) => c.id),
    );
  });

  it("refuses to remove the last canvas", () => {
    const moka = buildGoldenMokaFile();
    apply(moka, { type: "removeCanvas", canvasId: moka.canvas[1].id });
    expect(
      codeOf(() =>
        apply(
          { ...moka, canvas: [moka.canvas[0]] },
          { type: "removeCanvas", canvasId: moka.canvas[0].id },
        ),
      ),
    ).toBe("CANVAS_REQUIRED");
  });

  it("dissolves groups that fall below two members", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    const groupNode = createNode("group", { x: 0, y: 0 });
    const grouped = apply(
      moka,
      { type: "addNode", canvasId, node: groupNode },
      {
        type: "setGroupMembership",
        canvasId,
        groupId: groupNode.id,
        childNodeIds: [ids.text, ids.image],
      },
    ).next;
    expect(grouped.canvas[0].groups).toHaveLength(1);

    const reduced = apply(grouped, {
      type: "setGroupMembership",
      canvasId,
      groupId: groupNode.id,
      childNodeIds: [ids.text],
    }).next;
    expect(reduced.canvas[0].groups).toHaveLength(0);
    expect(reduced.canvas[0].nodes.some((n) => n.id === groupNode.id)).toBe(
      false,
    );
    expect(reduced.canvas[0].nodes.some((n) => n.id === ids.text)).toBe(true);
  });

  it("rejects duplicate group members and self-membership", () => {
    const moka = buildGoldenMokaFile();
    const canvasId = moka.canvas[0].id;
    const ids = goldenNodeIds();
    const groupNode = createNode("group", { x: 0, y: 0 });
    const withGroup = apply(moka, {
      type: "addNode",
      canvasId,
      node: groupNode,
    }).next;
    expect(
      codeOf(() =>
        apply(withGroup, {
          type: "setGroupMembership",
          canvasId,
          groupId: groupNode.id,
          childNodeIds: [ids.text, ids.text],
        }),
      ),
    ).toBe("GROUP_INVALID");
    expect(
      codeOf(() =>
        apply(withGroup, {
          type: "setGroupMembership",
          canvasId,
          groupId: groupNode.id,
          childNodeIds: [groupNode.id, ids.text],
        }),
      ),
    ).toBe("GROUP_INVALID");
  });
});

describe("which executor a node runs on", () => {
  it("sends a node carrying a spec to the provider", () => {
    const node = createNode("image", { x: 0, y: 0 }, { generate: true });
    expect(executorKeyForNode(node)).toBe(PROVIDER_EXECUTOR_KEY);
  });

  it("sends an operation node to the executor it names", () => {
    const node = createNode("operation", { x: 0, y: 0 });
    expect(executorKeyForNode(node)).toBe("deterministic");
  });

  it("sends nothing for a node a run could not drive", () => {
    expect(executorKeyForNode(createNode("image", { x: 0, y: 0 }))).toBeNull();
    expect(executorKeyForNode(createNode("group", { x: 0, y: 0 }))).toBeNull();
    expect(executorKeyForNode(createNode("export", { x: 0, y: 0 }))).toBeNull();
  });
});

describe("a spec rebuilt from what an asset recorded", () => {
  const asked = {
    capability: "image",
    mode: "edit",
    model: "demo::painter",
    prompt: "Redraw the lake at night",
    inputMode: "mentions",
    params: { size: "1:1", count: 2 },
    referenceNodeIds: ["node-one", "node-two"],
  };

  it("asks again for what the snapshot says", () => {
    const spec = generationSpecFromSnapshot(asked, "image");
    expect(spec?.capability).toBe("image");
    expect(spec?.mode).toBe("edit");
    expect(spec?.model).toBe("demo::painter");
    expect(spec?.prompt).toBe("Redraw the lake at night");
    expect(spec?.inputMode).toBe("mentions");
    expect(spec?.params).toEqual({ size: "1:1", count: 2 });
    expect(spec?.referenceNodeIds).toEqual(["node-one", "node-two"]);
    // A snapshot records what to ask for, not when it was asked for.
    expect(spec?.updatedAt).not.toBe("");
  });

  it("refuses a snapshot that belongs to another kind of node", () => {
    expect(generationSpecFromSnapshot(asked, "text")).toBeNull();
    expect(generationSpecFromSnapshot(asked, "operation")).toBeNull();
    expect(generationSpecFromSnapshot(undefined, "image")).toBeNull();
  });

  it("refuses a snapshot with no prompt to ask for", () => {
    expect(
      generationSpecFromSnapshot({ ...asked, prompt: 7 }, "image"),
    ).toBeNull();
  });

  it("falls back on the parts a hand-edited document got wrong", () => {
    const spec = generationSpecFromSnapshot(
      {
        ...asked,
        mode: "sideways",
        params: "large",
        referenceNodeIds: ["node-one", 3],
      },
      "image",
    );
    expect(spec?.mode).toBe("generate");
    expect(spec?.inputMode).toBe("mentions");
    expect(spec?.params).toEqual({});
    expect(spec?.referenceNodeIds).toEqual(["node-one"]);
  });
});
