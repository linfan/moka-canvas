import { describe, expect, it } from "vitest";
import {
  DEFAULT_NODE_HEIGHT,
  MIN_NODE_HEIGHT,
  createNode,
  type NodeKind,
} from "../../../shared/domain";
import { PORT_RADIUS, PORT_SPACING } from "./theme";
import { layoutPorts } from "./portLayout";

function inputsOf(kind: NodeKind, height: number) {
  const node = createNode(kind, { x: 0, y: 0 }, { height });
  const ports = layoutPorts(node);
  const inputs = [...ports.values()].filter((port) => port.local.x === 0);
  return { node, ports, ys: inputs.map((port) => port.local.y) };
}

describe("layoutPorts", () => {
  it("puts inputs on the left edge and outputs on the right", () => {
    const node = createNode("video", { x: 0, y: 0 });
    const ports = layoutPorts(node);
    for (const definition of node.ports) {
      const view = ports.get(definition.id)!;
      expect(view.direction).toBe(definition.direction);
      expect(view.local.x).toBe(
        definition.direction === "input" ? 0 : node.bounds.width,
      );
    }
    // Both columns start at the same height.
    expect(ports.get("prompt")!.local.y).toBe(ports.get("out")!.local.y);
  });

  it("keeps the standard step while the column fits the card", () => {
    const { ys } = inputsOf("image", DEFAULT_NODE_HEIGHT);
    expect(ys).toHaveLength(3);
    expect(ys[1] - ys[0]).toBe(PORT_SPACING);
  });

  it("compresses a long column so dots stay inside a short card", () => {
    const { node, ys } = inputsOf("video", MIN_NODE_HEIGHT);
    expect(ys).toHaveLength(6);
    expect(ys[1] - ys[0]).toBeLessThan(PORT_SPACING);
    for (const y of ys) {
      expect(y + PORT_RADIUS).toBeLessThanOrEqual(node.bounds.height);
    }
  });
});
