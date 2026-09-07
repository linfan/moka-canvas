import { Ellipse, Group, Rect, Text } from "leafer-ui";
import type {
  NodeKind,
  Point,
  RunStatus,
  WorkflowNode,
} from "../../../shared/domain";
import {
  NODE_HEADER_HEIGHT,
  PORT_RADIUS,
  PORT_SPACING,
  canvasTheme,
} from "./theme";
import {
  mediaSignature,
  waveformPeaks,
  type MediaCardInfo,
} from "./mediaCards";

export interface NodeVisualState {
  selected: boolean;
  hovered: boolean;
  /** Zoomed out past the detail threshold: title and accent only. */
  lowDetail: boolean;
  /** Related-highlight is active and this node is outside the chain. */
  dimmed: boolean;
  /** Latest run step status for this node, if any. */
  runStatus: RunStatus | null;
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
  /** Run-status dot in the header corner; null while no run covers the node. */
  statusDot: Ellipse | null;
  media: {
    signature: string;
    thumb: Rect | null;
    badge: Text | null;
    bars: Rect[];
  };
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

/** Card body area below the header, inset from the frame. */
function mediaArea(bounds: { width: number; height: number }) {
  return {
    x: 8,
    y: NODE_HEADER_HEIGHT + 8,
    width: bounds.width - 16,
    height: bounds.height - NODE_HEADER_HEIGHT - 16,
  };
}

function layoutMedia(
  view: NodeView,
  bounds: { width: number; height: number },
) {
  const area = mediaArea(bounds);
  if (view.media.thumb) {
    view.media.thumb.set({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
    });
  }
  if (view.media.badge) {
    view.media.badge.set({
      x: area.x + 8,
      y: area.y + area.height - 24,
      width: area.width - 16,
    });
  }
  const bars = view.media.bars;
  if (bars.length > 0) {
    const gap = 3;
    const barWidth = Math.max(
      2,
      (area.width - gap * (bars.length - 1)) / bars.length,
    );
    bars.forEach((bar, index) => {
      const peak = Number(bar.data?.peak ?? 0.5);
      const height = Math.max(4, area.height * peak);
      bar.set({
        x: area.x + index * (barWidth + gap),
        y: area.y + (area.height - height) / 2,
        width: barWidth,
        height,
      });
    });
  }
}

function syncMedia(
  view: NodeView,
  node: WorkflowNode,
  media: MediaCardInfo | null,
) {
  const signature = mediaSignature(media);
  if (view.media.signature === signature) return;
  view.media.signature = signature;
  view.media.thumb?.remove();
  view.media.badge?.remove();
  for (const bar of view.media.bars) bar.remove();
  view.media.thumb = null;
  view.media.badge = null;
  view.media.bars = [];
  if (!media) return;

  if (media.state === "ready" && media.url && node.kind !== "audio") {
    view.media.thumb = new Rect({
      cornerRadius: 8,
      fill: { type: "image", url: media.url, mode: "cover" },
      hittable: false,
    });
    view.group.add(view.media.thumb);
  } else if (media.state === "ready" && node.kind === "audio") {
    const accent = canvasTheme.kindAccent.audio;
    view.media.bars = waveformPeaks(media.entry?.sha256).map((peak) => {
      const bar = new Rect({
        cornerRadius: 1,
        fill: accent,
        opacity: 0.85,
        hittable: false,
        data: { peak },
      });
      view.group.add(bar);
      return bar;
    });
  } else {
    // Missing / changed / empty: a distinct broken-media wash.
    view.media.thumb = new Rect({
      cornerRadius: 8,
      fill: "#2a1e21",
      dashPattern: [4, 3],
      stroke: "#ff8a80",
      strokeWidth: 1,
      hittable: false,
    });
    view.group.add(view.media.thumb);
  }

  if (media.label) {
    view.media.badge = new Text({
      text: media.state === "ready" ? media.label : `⚠ ${media.label}`,
      fontSize: 11,
      fill: media.state === "ready" ? canvasTheme.nodeTitle : "#ff8a80",
      fontFamily: canvasTheme.fontFamily,
      textOverflow: "…",
      hittable: false,
    });
    view.group.add(view.media.badge);
  }
  layoutMedia(view, node.bounds);
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
  media: MediaCardInfo | null = null,
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
    shadow: { x: 0, y: 8, blur: 20, color: "#00000066" },
    data: { role: "body", nodeId: node.id },
  });
  if (node.kind === "group") {
    frame.set({
      fill: "#ffffff08",
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
    statusDot: null,
    media: { signature: "", thumb: null, badge: null, bars: [] },
  };
  syncMedia(view, node, media);
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

function syncStatusDot(view: NodeView, status: RunStatus | null) {
  if (!status) {
    if (view.statusDot) {
      view.statusDot.remove();
      view.statusDot = null;
    }
    return;
  }
  if (!view.statusDot) {
    view.statusDot = new Ellipse({
      width: 9,
      height: 9,
      stroke: canvasTheme.nodeFill,
      strokeWidth: 1.5,
      hittable: false,
    });
    view.group.add(view.statusDot);
  }
  view.statusDot.set({
    x: view.node.bounds.width - 21,
    y: (NODE_HEADER_HEIGHT - 9) / 2,
    fill: canvasTheme.runStatus[status] ?? canvasTheme.nodeMuted,
  });
}

function applyVisual(view: NodeView, visual: NodeVisualState) {
  const { frame, title, summary, group } = view;
  frame.strokeWidth = visual.selected ? 2 : visual.hovered ? 1.5 : 1;
  frame.stroke = visual.selected
    ? canvasTheme.selection
    : visual.hovered
      ? canvasTheme.nodeMuted
      : canvasTheme.nodeStroke;
  const hasMedia = view.media.signature !== "";
  summary.visible = !visual.lowDetail && !hasMedia;
  title.width = view.node.bounds.width - 52;
  if (view.media.thumb) view.media.thumb.visible = !visual.lowDetail;
  if (view.media.badge) view.media.badge.visible = !visual.lowDetail;
  for (const bar of view.media.bars) bar.visible = !visual.lowDetail;
  for (const port of view.ports.values()) {
    port.dot.visible = !visual.lowDetail;
  }
  syncStatusDot(view, visual.runStatus);
  if (view.statusDot) view.statusDot.visible = !visual.lowDetail;
  group.opacity = visual.dimmed ? 0.35 : 1;
}

/** Returns true when the port layout changed and edges must be refreshed. */
export function updateNodeView(
  view: NodeView,
  node: WorkflowNode,
  visual: NodeVisualState,
  media: MediaCardInfo | null = null,
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
  syncMedia(view, node, media);
  layoutMedia(view, node.bounds);
  syncPorts(view, node);
  applyVisual(view, visual);
  return portsChanged || view.visual.lowDetail !== visual.lowDetail;
}

export function portAnchorWorld(view: NodeView, portId: string): Point | null {
  const port = view.ports.get(portId);
  if (!port) return null;
  return {
    x: (view.group.x ?? view.node.bounds.x) + port.local.x,
    y: (view.group.y ?? view.node.bounds.y) + port.local.y,
  };
}

/** Repositions/resizes the view without touching the model reference. */
export function previewNodeBounds(
  view: NodeView,
  bounds: { x: number; y: number; width: number; height: number },
) {
  view.group.set({ x: bounds.x, y: bounds.y });
  view.frame.set({ width: bounds.width, height: bounds.height });
  view.accent.set({ height: bounds.height });
  view.title.set({ width: bounds.width - 52 });
  view.statusDot?.set({ x: bounds.width - 21 });
  view.summary.set({
    width: bounds.width - 28,
    height: bounds.height - NODE_HEADER_HEIGHT - 20,
  });
  layoutMedia(view, bounds);
  const laidOut = layoutPorts({
    ...view.node,
    bounds,
  });
  for (const [portId, port] of view.ports) {
    const next = laidOut.get(portId);
    if (!next) continue;
    port.local = next.local;
    port.dot.set({
      x: next.local.x - PORT_RADIUS,
      y: next.local.y - PORT_RADIUS,
    });
  }
}

export type PortHighlight = "compatible" | "rejected" | "candidate" | null;

/** Connect-time port affordance; null restores the default dot. */
export function setPortHighlight(
  view: NodeView,
  portId: string,
  state: PortHighlight,
) {
  const port = view.ports.get(portId);
  if (!port) return;
  if (state === "compatible") {
    port.dot.set({
      fill: canvasTheme.portCompatible,
      strokeWidth: 2,
      stroke: canvasTheme.portCompatible,
    });
  } else if (state === "candidate") {
    port.dot.set({
      fill: canvasTheme.selection,
      strokeWidth: 2.5,
      stroke: canvasTheme.selection,
    });
  } else if (state === "rejected") {
    port.dot.set({
      fill: canvasTheme.portRejected,
      strokeWidth: 1.5,
      stroke: canvasTheme.nodeFill,
    });
  } else {
    port.dot.set({
      fill: canvasTheme.port,
      strokeWidth: 1.5,
      stroke: canvasTheme.nodeFill,
    });
  }
}
