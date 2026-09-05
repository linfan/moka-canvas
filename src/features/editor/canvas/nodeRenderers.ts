import { Ellipse, Group, Rect, Text } from "leafer-ui";
import type { NodeKind, Point, WorkflowNode } from "../../../shared/domain";
import {
  NODE_HEADER_HEIGHT,
  PORT_RADIUS,
  PORT_SPACING,
  canvasTheme,
} from "./theme";

export interface NodeVisualState {
  selected: boolean;
  hovered: boolean;
  /** Zoomed out past the detail threshold: title and accent only. */
  lowDetail: boolean;
}

export interface PortView {
  direction: "input" | "output";
  dot: Ellipse;
  /** Local anchor point inside the node group. */
  local: Point;
}

export interface NodeView {
  group: Group;
  frame: Rect;
  accent: Rect;
  title: Text;
  summary: Text;
  ports: Map<string, PortView>;
  node: WorkflowNode;
  visual: NodeVisualState;
}

const KIND_GLYPH: Record<NodeKind, string> = {
  text: "T",
  image: "🖻",
  audio: "♪",
  video: "▶",
  operation: "⚙",
  group: "▦",
  export: "⇪",
};

function summarize(node: WorkflowNode): string {
  const data = node.data as Record<string, unknown>;
  switch (node.kind) {
    case "text": {
      const content = typeof data.content === "string" ? data.content : "";
      return content.trim() ? content.slice(0, 120) : "Double-click to edit";
    }
    case "image":
    case "audio":
    case "video":
      return data.assetId ? "Asset linked" : "No asset yet";
    case "operation":
      return String(data.operationType ?? "operation");
    case "group": {
      const children = Array.isArray(data.childNodeIds)
        ? data.childNodeIds.length
        : 0;
      return `${children} item${children === 1 ? "" : "s"}`;
    }
    case "export":
      return String(data.format ?? "export").toUpperCase();
  }
}

function layoutPorts(node: WorkflowNode): Map<string, PortView> {
  const inputs = node.ports.filter((port) => port.direction === "input");
  const outputs = node.ports.filter((port) => port.direction === "output");
  const ports = new Map<string, PortView>();
  inputs.forEach((port, index) => {
    ports.set(port.id, {
      direction: "input",
      dot: null as unknown as Ellipse,
      local: { x: 0, y: NODE_HEADER_HEIGHT + 16 + index * PORT_SPACING },
    });
  });
  outputs.forEach((port, index) => {
    ports.set(port.id, {
      direction: "output",
      dot: null as unknown as Ellipse,
      local: {
        x: node.bounds.width,
        y: NODE_HEADER_HEIGHT + 16 + index * PORT_SPACING,
      },
    });
  });
  return ports;
}

export function createNodeView(
  node: WorkflowNode,
  visual: NodeVisualState,
): NodeView {
  const accentColor = canvasTheme.kindAccent[node.kind];
  const group = new Group({
    x: node.bounds.x,
    y: node.bounds.y,
    data: { role: "node", nodeId: node.id },
  });
  const frame = new Rect({
    x: 0,
    y: 0,
    width: node.bounds.width,
    height: node.bounds.height,
    cornerRadius: 12,
    fill: canvasTheme.nodeFill,
    stroke: canvasTheme.nodeStroke,
    strokeWidth: 1,
    shadow: { x: 0, y: 8, blur: 20, color: "#05081766" },
    data: { role: "body", nodeId: node.id },
  });
  if (node.kind === "group") {
    frame.set({
      fill: "#9fb1d40d",
      dashPattern: [6, 4],
    });
  }
  const accent = new Rect({
    x: 0,
    y: 0,
    width: 4,
    height: node.bounds.height,
    cornerRadius: [12, 0, 0, 12],
    fill: accentColor,
    hittable: false,
  });
  const title = new Text({
    x: 14,
    y: 7,
    width: node.bounds.width - 52,
    text: `${KIND_GLYPH[node.kind]}  ${node.title}`,
    fontSize: 13,
    fontWeight: 600,
    fill: canvasTheme.nodeTitle,
    fontFamily: canvasTheme.fontFamily,
    textOverflow: "…",
    hittable: false,
  });
  const summary = new Text({
    x: 14,
    y: NODE_HEADER_HEIGHT + 12,
    width: node.bounds.width - 28,
    height: node.bounds.height - NODE_HEADER_HEIGHT - 20,
    text: summarize(node),
    fontSize: 12,
    fill: canvasTheme.nodeMuted,
    fontFamily: canvasTheme.fontFamily,
    textOverflow: "…",
    hittable: false,
  });
  group.add(frame);
  group.add(accent);
  group.add(title);
  group.add(summary);

  const view: NodeView = {
    group,
    frame,
    accent,
    title,
    summary,
    ports: new Map(),
    node,
    visual,
  };
  syncPorts(view, node);
  applyVisual(view, visual);
  return view;
}

function syncPorts(view: NodeView, node: WorkflowNode) {
  const next = layoutPorts(node);
  for (const [portId, port] of next) {
    const existing = view.ports.get(portId);
    if (existing) {
      existing.local = port.local;
      existing.dot.set({
        x: port.local.x - PORT_RADIUS,
        y: port.local.y - PORT_RADIUS,
      });
      continue;
    }
    const dot = new Ellipse({
      x: port.local.x - PORT_RADIUS,
      y: port.local.y - PORT_RADIUS,
      width: PORT_RADIUS * 2,
      height: PORT_RADIUS * 2,
      fill: canvasTheme.port,
      stroke: canvasTheme.nodeFill,
      strokeWidth: 1.5,
      data: { role: "port", nodeId: node.id, portId },
    });
    view.group.add(dot);
    port.dot = dot;
    view.ports.set(portId, port);
  }
  for (const [portId, port] of view.ports) {
    if (!next.has(portId)) {
      port.dot.remove();
      view.ports.delete(portId);
    }
  }
}

function applyVisual(view: NodeView, visual: NodeVisualState) {
  const { frame, title, summary, group } = view;
  frame.strokeWidth = visual.selected ? 2 : visual.hovered ? 1.5 : 1;
  frame.stroke = visual.selected
    ? canvasTheme.selection
    : visual.hovered
      ? canvasTheme.nodeMuted
      : canvasTheme.nodeStroke;
  summary.visible = !visual.lowDetail;
  title.width = view.node.bounds.width - 52;
  for (const port of view.ports.values()) {
    port.dot.visible = !visual.lowDetail;
  }
  group.opacity = 1;
}

/** Returns true when the port layout changed and edges must be refreshed. */
export function updateNodeView(
  view: NodeView,
  node: WorkflowNode,
  visual: NodeVisualState,
): boolean {
  const portsChanged =
    view.node.bounds.width !== node.bounds.width ||
    view.node.ports !== node.ports;
  view.node = node;
  view.group.set({ x: node.bounds.x, y: node.bounds.y });
  view.frame.set({ width: node.bounds.width, height: node.bounds.height });
  view.accent.set({ height: node.bounds.height });
  view.title.set({
    text: `${KIND_GLYPH[node.kind]}  ${node.title}`,
    width: node.bounds.width - 52,
  });
  view.summary.set({
    y: NODE_HEADER_HEIGHT + 12,
    width: node.bounds.width - 28,
    height: node.bounds.height - NODE_HEADER_HEIGHT - 20,
    text: summarize(node),
  });
  syncPorts(view, node);
  applyVisual(view, visual);
  return portsChanged || view.visual.lowDetail !== visual.lowDetail;
}

export function portAnchorWorld(view: NodeView, portId: string): Point | null {
  const port = view.ports.get(portId);
  if (!port) return null;
  return {
    x: view.node.bounds.x + port.local.x,
    y: view.node.bounds.y + port.local.y,
  };
}
