import { Ellipse, Group, Line, Rect, Text } from "leafer-ui";
import type {
  NodeKind,
  Point,
  ResultSlot,
  WorkflowNode,
} from "../../../shared/domain";
import type { NodeRunView } from "../stores/runStore";
import { NODE_HEADER_HEIGHT, PORT_RADIUS, canvasTheme } from "./theme";
import { layoutPorts, type PortView } from "./portLayout";
import {
  generationSummary,
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
  /** What this node's own run says about it; null while no run covers it. */
  run: NodeRunView | null;
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
  /** The mark standing in for the dot where a run gave up: circle and its "!". */
  failMark: Group | null;
  /**
   * How far a run has got, across the top of the card; null while none is. The
   * stripe stands in for the bar where nobody has measured a fraction of it.
   */
  progress: { track: Rect; fill: Rect; stripes: Line } | null;
  /** How many results the last ask made, where it made more than one. */
  resultCount: Text | null;
  media: {
    signature: string;
    thumb: Rect | null;
    badge: Text | null;
    bars: Rect[];
  };
}

/** How far in from each edge the measure of a run is drawn. */
const PROGRESS_INSET = 12;
const PROGRESS_HEIGHT = 3;
/** How far below the card's top edge that measure sits. */
const PROGRESS_TOP = 2;
/** The dot, and the mark that replaces it where a run gave up. */
const DOT_SIZE = 9;
const FAIL_SIZE = 13;
/** The right edge every mark in the header is set back from. */
const MARK_EDGE = 12;
/** The count of results, and the gap keeping it clear of the dot. */
const COUNT_WIDTH = 26;
const COUNT_HEIGHT = 14;
const COUNT_GAP = 6;

/**
 * Whether two readings of a node's run are the same reading.
 *
 * Field by field rather than by identity: the reading is built fresh on every
 * push, so identity would say "changed" to every card a run covers on every
 * word it says, which is the redraw this comparison exists to avoid.
 */
export function sameRun(
  one: NodeRunView | null,
  other: NodeRunView | null,
): boolean {
  if (one === null || other === null) return one === other;
  return (
    one.status === other.status &&
    one.progress === other.progress &&
    one.error === other.error &&
    one.said === other.said
  );
}

/** How many results the node's last ask made, counting the one it keeps. */
function resultCount(node: WorkflowNode): number {
  const slots = (node.data as { resultSlots?: ResultSlot[] }).resultSlots;
  return slots?.length ?? 0;
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
      if (content.trim()) return content.slice(0, 120);
      return generationSummary(node) || "Double-click to edit";
    }
    case "image":
    case "audio":
    case "video":
      if (data.assetId) return "Asset linked";
      return generationSummary(node) || "No asset yet";
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

/**
 * What the card's one line of body text says.
 *
 * A text answer arrives in pieces, and the card shows the pieces that have
 * landed rather than waiting for the whole of them: the node reads as working,
 * and the words themselves are the proof.
 */
function wordsFor(node: WorkflowNode, run: NodeRunView | null): string {
  if (node.kind === "text" && run && run.said.trim() !== "") {
    return run.said.slice(0, 120);
  }
  return summarize(node);
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
      fill: canvasTheme.alertFill,
      dashPattern: [4, 3],
      stroke: canvasTheme.portRejected,
      strokeWidth: 1,
      hittable: false,
    });
    view.group.add(view.media.thumb);
  }

  if (media.label) {
    view.media.badge = new Text({
      text: media.state === "ready" ? media.label : `⚠ ${media.label}`,
      fontSize: 11,
      fill:
        media.state === "ready"
          ? canvasTheme.nodeTitle
          : canvasTheme.portRejected,
      fontFamily: canvasTheme.fontFamily,
      textOverflow: "…",
      hittable: false,
    });
    view.group.add(view.media.badge);
  }
  layoutMedia(view, node.bounds);
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
    shadow: { x: 0, y: 8, blur: 20, color: canvasTheme.nodeShadow },
    data: { role: "body", nodeId: node.id },
  });
  if (node.kind === "group") {
    frame.set({
      fill: canvasTheme.groupFill,
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
    text: wordsFor(node, visual.run),
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
    failMark: null,
    progress: null,
    resultCount: null,
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

/** Where a mark of this size sits in the header's right-hand corner. */
function markSlot(width: number, size: number) {
  return { x: width - MARK_EDGE - size, y: (NODE_HEADER_HEIGHT - size) / 2 };
}

/** Where the measure of a run starts, and how far it may go. */
function measureSpan(width: number) {
  return { x: PROGRESS_INSET, span: Math.max(0, width - PROGRESS_INSET * 2) };
}

/** Where the count of results sits, clear of the mark beside it. */
function countSlot(width: number) {
  return {
    x: width - MARK_EDGE - DOT_SIZE - COUNT_GAP - COUNT_WIDTH,
    y: (NODE_HEADER_HEIGHT - COUNT_HEIGHT) / 2,
  };
}

/**
 * Places the measure of a run across a card this wide.
 *
 * The bar reaches as far as anybody has measured, and never less than its own
 * height: a run that has begun has begun, however little of it is known. Where
 * nobody has measured a fraction at all, the stripe stands in for the bar.
 */
function placeMeasure(
  measure: { track: Rect; fill: Rect; stripes: Line },
  width: number,
  measured: number | null,
) {
  const { x, span } = measureSpan(width);
  const band = PROGRESS_TOP + PROGRESS_HEIGHT / 2;
  measure.track.set({ x, width: span });
  measure.stripes.set({ points: [x, band, x + span, band] });
  measure.fill.set({
    x,
    width: Math.max(
      PROGRESS_HEIGHT,
      span * Math.min(1, Math.max(0, measured ?? 0)),
    ),
  });
}

/**
 * Everything the card says about its node's own run.
 *
 * Each mark is made only while it is wanted and taken away the moment it is
 * not, so a card nobody has ever asked carries nothing at all, and one whose
 * run has ended keeps only the count of what it made.
 */
function syncRunMarks(
  view: NodeView,
  node: WorkflowNode,
  visual: NodeVisualState,
) {
  const run = visual.run;
  const status = run?.status ?? null;
  const failed = status === "failed";
  const going = status === "queued" || status === "running";
  const measured = going ? (run?.progress ?? null) : null;
  const width = node.bounds.width;
  const color = canvasTheme.runStatus[status ?? ""] ?? canvasTheme.nodeMuted;

  // A run that gave up is said by the mark below, which is louder: the two
  // never stand in the same corner at once.
  if (status === null || failed) {
    view.statusDot?.remove();
    view.statusDot = null;
  } else {
    if (!view.statusDot) {
      view.statusDot = new Ellipse({
        width: DOT_SIZE,
        height: DOT_SIZE,
        stroke: canvasTheme.nodeFill,
        strokeWidth: 1.5,
        hittable: false,
      });
      view.group.add(view.statusDot);
    }
    view.statusDot.set({ ...markSlot(width, DOT_SIZE), fill: color });
  }

  if (failed) {
    if (!view.failMark) {
      const mark = new Group({ hittable: false });
      mark.add(
        new Ellipse({
          width: FAIL_SIZE,
          height: FAIL_SIZE,
          fill: canvasTheme.runStatus.failed ?? canvasTheme.portRejected,
          hittable: false,
        }),
      );
      mark.add(
        new Text({
          width: FAIL_SIZE,
          height: FAIL_SIZE,
          text: "!",
          fontSize: 10,
          fontWeight: 700,
          fill: canvasTheme.nodeFill,
          fontFamily: canvasTheme.fontFamily,
          textAlign: "center",
          verticalAlign: "middle",
          hittable: false,
        }),
      );
      view.group.add(mark);
      view.failMark = mark;
    }
    view.failMark.set(markSlot(width, FAIL_SIZE));
  } else {
    view.failMark?.remove();
    view.failMark = null;
  }

  if (going) {
    if (!view.progress) {
      const track = new Rect({
        y: PROGRESS_TOP,
        height: PROGRESS_HEIGHT,
        cornerRadius: PROGRESS_HEIGHT / 2,
        fill: canvasTheme.progressTrack,
        hittable: false,
      });
      const fill = new Rect({
        y: PROGRESS_TOP,
        height: PROGRESS_HEIGHT,
        cornerRadius: PROGRESS_HEIGHT / 2,
        fill: color,
        hittable: false,
      });
      const stripes = new Line({
        strokeWidth: PROGRESS_HEIGHT,
        stroke: color,
        dashPattern: [9, 7],
        opacity: 0.75,
        hittable: false,
      });
      view.group.add(track);
      view.group.add(fill);
      view.group.add(stripes);
      view.progress = { track, fill, stripes };
    }
    placeMeasure(view.progress, width, measured);
  } else {
    view.progress?.track.remove();
    view.progress?.fill.remove();
    view.progress?.stripes.remove();
    view.progress = null;
  }

  const made = resultCount(node);
  if (made > 1) {
    if (!view.resultCount) {
      view.resultCount = new Text({
        width: COUNT_WIDTH,
        height: COUNT_HEIGHT,
        fontSize: 10,
        fill: canvasTheme.nodeMuted,
        fontFamily: canvasTheme.fontFamily,
        textAlign: "right",
        verticalAlign: "middle",
        hittable: false,
      });
      view.group.add(view.resultCount);
    }
    view.resultCount.set({ ...countSlot(width), text: `×${made}` });
  } else {
    view.resultCount?.remove();
    view.resultCount = null;
  }

  const shown = !visual.lowDetail;
  if (view.statusDot) view.statusDot.visible = shown;
  if (view.failMark) view.failMark.visible = shown;
  if (view.resultCount) view.resultCount.visible = shown;
  if (view.progress) {
    view.progress.track.visible = shown;
    view.progress.fill.visible = shown && measured !== null;
    view.progress.stripes.visible = shown && measured === null;
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
  const hasMedia = view.media.signature !== "";
  summary.visible = !visual.lowDetail && !hasMedia;
  title.width = view.node.bounds.width - 52;
  if (view.media.thumb) view.media.thumb.visible = !visual.lowDetail;
  if (view.media.badge) view.media.badge.visible = !visual.lowDetail;
  for (const bar of view.media.bars) bar.visible = !visual.lowDetail;
  for (const port of view.ports.values()) {
    port.dot.visible = !visual.lowDetail;
  }
  syncRunMarks(view, view.node, visual);
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
    text: wordsFor(node, visual.run),
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
  view.statusDot?.set(markSlot(bounds.width, DOT_SIZE));
  view.failMark?.set(markSlot(bounds.width, FAIL_SIZE));
  view.resultCount?.set(countSlot(bounds.width));
  if (view.progress) {
    placeMeasure(
      view.progress,
      bounds.width,
      view.visual.run?.progress ?? null,
    );
  }
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
