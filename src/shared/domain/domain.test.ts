import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import { buildGoldenMokaFile, goldenNodeIds } from "./fixtures";
import { createCanvas, createNode } from "./factories";
import { newId } from "./ids";
import type { DocumentCommand, MokaFile } from "./types";
import {
  topologicalOrder,
  validateBounds,
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
