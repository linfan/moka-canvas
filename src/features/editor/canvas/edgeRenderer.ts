import { Group, Path, Polygon } from "leafer-ui";
import type { Point, WorkflowEdge } from "../../../shared/domain";
import { canvasTheme } from "./theme";

export interface EdgeView {
  group: Group;
  line: Path;
  hit: Path;
  arrow: Polygon;
  edge: WorkflowEdge;
}

export interface EdgeVisual {
  selected: boolean;
  /** Part of the related chain for the hovered/selected node. */
  highlighted: boolean;
  /** Dashed style for the pending-connection preview. */
  preview: boolean;
}

export const EDGE_VISUAL_DEFAULT: EdgeVisual = {
  selected: false,
  highlighted: false,
  preview: false,
};

function pathData(from: Point, to: Point): string {
  const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y} ${to.x - dx} ${to.y} ${to.x} ${to.y}`;
}

function arrowAt(to: Point, from: Point, polygon: Polygon) {
  // Both control points share the endpoints' y, so the end tangent is
  // always horizontal.
  polygon.set({
    x: to.x,
    y: to.y,
    rotation: to.x >= from.x ? 0 : 180,
  });
}

export function createEdgeView(
  edge: WorkflowEdge,
  from: Point,
  to: Point,
  visual: Partial<EdgeVisual> = {},
): EdgeView {
  const group = new Group({ data: { role: "edge", edgeId: edge.id } });
  const hit = new Path({
    path: pathData(from, to),
    stroke: "#000000",
    strokeWidth: 12,
    opacity: 0,
    data: { role: "edge", edgeId: edge.id },
  });
  const line = new Path({
    path: pathData(from, to),
    stroke: canvasTheme.edge,
    strokeWidth: 2,
    hittable: false,
  });
  const arrow = new Polygon({
    points: [0, -5, 10, 0, 0, 5],
    x: to.x,
    y: to.y,
    fill: canvasTheme.edge,
    hittable: false,
  });
  arrowAt(to, from, arrow);
  group.add(hit);
  group.add(line);
  group.add(arrow);
  const view: EdgeView = { group, line, hit, arrow, edge };
  applyEdgeVisual(view, { ...EDGE_VISUAL_DEFAULT, ...visual });
  return view;
}

export function updateEdgeView(
  view: EdgeView,
  edge: WorkflowEdge,
  from: Point,
  to: Point,
  visual: Partial<EdgeVisual> = {},
) {
  view.edge = edge;
  const data = pathData(from, to);
  view.line.set({ path: data });
  view.hit.set({ path: data });
  arrowAt(to, from, view.arrow);
  applyEdgeVisual(view, { ...EDGE_VISUAL_DEFAULT, ...visual });
}

function applyEdgeVisual(view: EdgeView, visual: EdgeVisual) {
  const color = visual.selected
    ? canvasTheme.edgeSelected
    : visual.highlighted
      ? canvasTheme.edgeRelated
      : canvasTheme.edge;
  view.line.set({
    stroke: color,
    strokeWidth: visual.selected || visual.highlighted ? 2.5 : 2,
    dashPattern: visual.preview ? [6, 4] : undefined,
  });
  view.arrow.set({ fill: color, visible: !visual.preview });
}
