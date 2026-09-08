import type { Ellipse } from "leafer-ui";
import type { Point, WorkflowNode } from "../../../shared/domain";
import { NODE_HEADER_HEIGHT, PORT_RADIUS, PORT_SPACING } from "./theme";

export interface PortView {
  direction: "input" | "output";
  dot: Ellipse;
  /** Local anchor point inside the node group. */
  local: Point;
}

const COLUMN_TOP = NODE_HEADER_HEIGHT + 16;
const MIN_COLUMN_SPACING = 12;

/** Keeps a column of dots inside the card: the step shrinks when it would spill. */
function columnSpacing(count: number, height: number): number {
  if (count < 2) return PORT_SPACING;
  const room = height - COLUMN_TOP - PORT_RADIUS;
  return Math.max(
    MIN_COLUMN_SPACING,
    Math.min(PORT_SPACING, room / (count - 1)),
  );
}

/**
 * Input dots on the left edge, output dots on the right, both top-aligned.
 * Dots are attached by the renderer; the placeholders keep the view uniform.
 */
export function layoutPorts(node: WorkflowNode): Map<string, PortView> {
  const columns = [
    { x: 0, ports: node.ports.filter((port) => port.direction === "input") },
    {
      x: node.bounds.width,
      ports: node.ports.filter((port) => port.direction === "output"),
    },
  ];
  const layout = new Map<string, PortView>();
  for (const column of columns) {
    const spacing = columnSpacing(column.ports.length, node.bounds.height);
    column.ports.forEach((port, index) => {
      layout.set(port.id, {
        direction: port.direction,
        dot: null as unknown as Ellipse,
        local: { x: column.x, y: COLUMN_TOP + index * spacing },
      });
    });
  }
  return layout;
}
