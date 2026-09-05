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
  selected: boolean,
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
  applyEdgeVisual(view, selected);
  return view;
}

export function updateEdgeView(
  view: EdgeView,
  edge: WorkflowEdge,
  from: Point,
  to: Point,
  selected: boolean,
) {
  view.edge = edge;
  const data = pathData(from, to);
  view.line.set({ path: data });
  view.hit.set({ path: data });
  arrowAt(to, from, view.arrow);
  applyEdgeVisual(view, selected);
}

function applyEdgeVisual(view: EdgeView, selected: boolean) {
  const color = selected ? canvasTheme.edgeSelected : canvasTheme.edge;
  view.line.set({ stroke: color, strokeWidth: selected ? 2.5 : 2 });
  view.arrow.set({ fill: color });
}
