import { Group, Leafer, PointerEvent, Rect } from "leafer-ui";
import type { ILeaf, IPointerEvent } from "leafer-ui";
import {
  LOW_DETAIL_ZOOM,
  type CanvasId,
  type EdgeId,
  type NodeId,
  type Point,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../../shared/domain";
import type { Selection } from "../stores/editorStore";
import {
  centerOn,
  panByPixels,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
  type Camera,
  type ViewSize,
} from "./camera";
import { createEdgeView, updateEdgeView, type EdgeView } from "./edgeRenderer";
import { GridBackground, type GridMode } from "./gridRenderer";
import { MinimapView } from "./minimap";
import {
  createNodeView,
  portAnchorWorld,
  updateNodeView,
  type NodeView,
} from "./nodeRenderers";
import { canvasTheme } from "./theme";

export interface ControllerCallbacks {
  onBackgroundTap(world: Point): void;
  onBackgroundDoubleTap(world: Point): void;
  onNodeTap(nodeId: NodeId, additive: boolean): void;
  onNodeDoubleTap(nodeId: NodeId): void;
  onEdgeTap(edgeId: EdgeId, additive: boolean): void;
  onPortTap(nodeId: NodeId, portId: string): void;
  /** Live camera gestures report "move"; the settled camera reports "end". */
  onCameraChange(camera: Camera, phase: "move" | "end"): void;
  onContextMenu(screen: Point, target: HitTarget): void;
  /** True while the pan tool (or a pan modifier) should grab drags. */
  wantPan(): boolean;
}

export type HitTarget =
  | { kind: "canvas" }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "edge"; edgeId: EdgeId }
  | { kind: "port"; nodeId: NodeId; portId: string };

export interface SceneState {
  canvasId: CanvasId;
  camera: Camera;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selection: Selection;
  hoveredNodeId: NodeId | null;
  background: GridMode;
  showMinimap: boolean;
}

interface EdgeRecord {
  view: EdgeView;
  from: Point;
  to: Point;
  selected: boolean;
}

export class LeaferEditorController {
  private leafer: Leafer | null = null;
  private container: HTMLElement | null = null;
  private callbacks: ControllerCallbacks | null = null;
  private observer: ResizeObserver | null = null;
  private size: ViewSize = { width: 0, height: 0 };
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private canvasId: CanvasId | null = null;
  private lastBackground: GridMode = "dots";
  private lastNodes: WorkflowNode[] = [];
  private lastShowMinimap = true;

  private grid = new GridBackground();
  private world = new Group({ data: { role: "world" } });
  private edgeLayer = new Group({ data: { role: "edgeLayer" } });
  private nodeLayer = new Group({ data: { role: "nodeLayer" } });
  private selectionLayer = new Group({
    data: { role: "selectionLayer" },
  });
  private minimap = new MinimapView();

  private nodeViews = new Map<NodeId, NodeView>();
  private edgeViews = new Map<EdgeId, EdgeRecord>();
  private selectionSignature = "";

  /** View-space point of the last pan pointer sample. */
  private pan: Point | null = null;
  private cameraEndTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: (() => void)[] = [];

  private stats = { renders: 0, nodeCreates: 0, nodeUpdates: 0 };

  mount(container: HTMLElement, callbacks: ControllerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    const rect = container.getBoundingClientRect();
    this.size = {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };

    const leafer = new Leafer({
      view: container,
      width: this.size.width,
      height: this.size.height,
      fill: canvasTheme.background,
    });
    this.leafer = leafer;

    this.grid.resize(this.size);
    leafer.add(this.grid.canvas);
    this.world.add(this.edgeLayer);
    this.world.add(this.nodeLayer);
    this.world.add(this.selectionLayer);
    leafer.add(this.world);
    leafer.add(this.minimap.group);

    leafer.on(PointerEvent.TAP, (event) => this.handleTap(event, false));
    leafer.on(PointerEvent.DOUBLE_TAP, (event) => this.handleTap(event, true));
    leafer.on(PointerEvent.DOWN, (event) => this.handleDown(event));
    leafer.on(PointerEvent.MENU, (event) => this.handleMenu(event));

    const onPointerMove = (event: globalThis.PointerEvent) =>
      this.handleDragMove(event);
    const onPointerUp = () => this.endPan();
    const onWheel = (event: WheelEvent) => this.handleWheel(event);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    container.addEventListener("wheel", onWheel, { passive: false });
    this.disposers.push(() => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("wheel", onWheel);
    });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
  }

  resize() {
    const container = this.container;
    const leafer = this.leafer;
    if (!container || !leafer) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.size = { width: rect.width, height: rect.height };
    leafer.resize(this.size);
    this.grid.resize(this.size);
    this.grid.draw(this.camera, this.lastBackground);
    if (this.lastShowMinimap) {
      this.minimap.update(
        this.lastNodes,
        this.camera,
        this.size,
        minimapAccent,
      );
    }
  }

  render(scene: SceneState) {
    this.stats.renders += 1;
    if (!this.leafer) return;

    if (scene.canvasId !== this.canvasId) {
      this.canvasId = scene.canvasId;
      this.clearScene();
    }

    this.camera = scene.camera;
    this.lastBackground = scene.background;
    this.lastNodes = scene.nodes;
    this.lastShowMinimap = scene.showMinimap;
    this.applyCamera();
    this.grid.draw(scene.camera, scene.background);

    const lowDetail = scene.camera.zoom < LOW_DETAIL_ZOOM;
    const seen = new Set<NodeId>();
    for (const node of scene.nodes) {
      seen.add(node.id);
      const visual = {
        selected: scene.selection.nodeIds.includes(node.id),
        hovered: scene.hoveredNodeId === node.id,
        lowDetail,
      };
      let view = this.nodeViews.get(node.id);
      if (!view) {
        view = createNodeView(node, visual);
        this.nodeLayer.add(view.group);
        this.nodeViews.set(node.id, view);
        this.stats.nodeCreates += 1;
      } else if (
        view.node !== node ||
        view.visual.selected !== visual.selected ||
        view.visual.hovered !== visual.hovered ||
        view.visual.lowDetail !== visual.lowDetail
      ) {
        updateNodeView(view, node, visual);
        this.stats.nodeUpdates += 1;
      }
      view.visual = visual;
      view.group.zIndex = node.zIndex;
    }
    for (const [nodeId, view] of this.nodeViews) {
      if (!seen.has(nodeId)) {
        view.group.destroy();
        this.nodeViews.delete(nodeId);
      }
    }

    this.reconcileEdges(scene);
    this.reconcileSelection(scene);

    this.minimap.group.visible = scene.showMinimap;
    if (scene.showMinimap) {
      this.minimap.update(scene.nodes, scene.camera, this.size, minimapAccent);
    }

    if (import.meta.env.DEV) {
      (window as unknown as { __mokaRenderStats?: unknown }).__mokaRenderStats =
        this.stats;
    }
  }

  focusNode(nodeId: NodeId) {
    const view = this.nodeViews.get(nodeId);
    if (!view || !this.callbacks) return;
    this.callbacks.onCameraChange(
      centerOn(this.camera, view.node.bounds),
      "end",
    );
  }

  worldToClient(point: Point): Point {
    return worldToScreen(this.camera, this.size, point);
  }

  clientToWorld(point: Point): Point {
    return screenToWorld(this.camera, this.size, point);
  }

  dispose() {
    this.endPan();
    if (this.cameraEndTimer) clearTimeout(this.cameraEndTimer);
    this.observer?.disconnect();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.clearScene();
    this.leafer?.destroy();
    this.leafer = null;
    this.container = null;
    this.callbacks = null;
  }

  // --- internals ---------------------------------------------------------

  private clearScene() {
    for (const view of this.nodeViews.values()) view.group.destroy();
    this.nodeViews.clear();
    for (const record of this.edgeViews.values()) record.view.group.destroy();
    this.edgeViews.clear();
    this.selectionLayer.removeAll();
    this.selectionSignature = "";
  }

  private applyCamera() {
    this.world.set({
      x: this.size.width / 2 - this.camera.x * this.camera.zoom,
      y: this.size.height / 2 - this.camera.y * this.camera.zoom,
      scaleX: this.camera.zoom,
      scaleY: this.camera.zoom,
    });
  }

  private hitTarget(event: IPointerEvent): HitTarget {
    let leaf = event.target as ILeaf | undefined;
    while (leaf && leaf !== this.leafer && leaf !== this.world) {
      const data = leaf.data as
        | { role?: string; nodeId?: string; portId?: string; edgeId?: string }
        | undefined;
      if (data?.role === "minimap") return { kind: "canvas" };
      if (data?.role === "port" && data.nodeId && data.portId) {
        return { kind: "port", nodeId: data.nodeId, portId: data.portId };
      }
      if ((data?.role === "node" || data?.role === "body") && data.nodeId) {
        return { kind: "node", nodeId: data.nodeId };
      }
      if (data?.role === "edge" && data.edgeId) {
        return { kind: "edge", edgeId: data.edgeId };
      }
      leaf = leaf.parent as ILeaf | undefined;
    }
    return { kind: "canvas" };
  }

  private isMinimapHit(event: IPointerEvent): boolean {
    let leaf = event.target as ILeaf | undefined;
    while (leaf && leaf !== this.leafer) {
      const data = leaf.data as { role?: string } | undefined;
      if (data?.role === "minimap") return true;
      leaf = leaf.parent as ILeaf | undefined;
    }
    return false;
  }

  private handleTap(event: IPointerEvent, double: boolean) {
    const callbacks = this.callbacks;
    if (!callbacks || this.pan) return;
    const screen = { x: event.x, y: event.y };
    const world = screenToWorld(this.camera, this.size, screen);

    if (this.isMinimapHit(event)) {
      const center = this.minimap.toWorld(screen);
      callbacks.onCameraChange(
        { ...this.camera, x: center.x, y: center.y },
        "end",
      );
      return;
    }

    const target = this.hitTarget(event);
    const additive = Boolean(event.shiftKey || event.metaKey || event.ctrlKey);
    if (target.kind === "port") {
      callbacks.onPortTap(target.nodeId, target.portId);
    } else if (target.kind === "node") {
      if (double) callbacks.onNodeDoubleTap(target.nodeId);
      else callbacks.onNodeTap(target.nodeId, additive);
    } else if (target.kind === "edge") {
      if (!double) callbacks.onEdgeTap(target.edgeId, additive);
    } else if (double) {
      callbacks.onBackgroundDoubleTap(world);
    } else {
      callbacks.onBackgroundTap(world);
    }
  }

  private handleDown(event: IPointerEvent) {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const target = this.hitTarget(event);
    const panRequested =
      event.middle || (target.kind === "canvas" && callbacks.wantPan());
    if (panRequested) {
      this.pan = { x: event.x, y: event.y };
      if (this.container) this.container.style.cursor = "grabbing";
    }
  }

  private viewPointOf(event: globalThis.PointerEvent): Point {
    const rect = this.container?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  }

  private handleDragMove(event: globalThis.PointerEvent) {
    if (!this.pan) return;
    const point = this.viewPointOf(event);
    const dx = point.x - this.pan.x;
    const dy = point.y - this.pan.y;
    this.pan = point;
    this.emitCamera(panByPixels(this.camera, dx, dy), "move");
  }

  private endPan() {
    if (!this.pan) return;
    this.pan = null;
    if (this.container) this.container.style.cursor = "";
    this.emitCamera(this.camera, "end");
  }

  private handleWheel(event: WheelEvent) {
    event.preventDefault();
    const container = this.container;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const screen = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const factor = Math.pow(1.0015, -event.deltaY);
    this.emitCamera(
      zoomAtPoint(this.camera, this.size, screen, factor),
      "move",
    );
    if (this.cameraEndTimer) clearTimeout(this.cameraEndTimer);
    this.cameraEndTimer = setTimeout(
      () => this.emitCamera(this.camera, "end"),
      240,
    );
  }

  private handleMenu(event: IPointerEvent) {
    this.callbacks?.onContextMenu(
      { x: event.x, y: event.y },
      this.hitTarget(event),
    );
  }

  private emitCamera(camera: Camera, phase: "move" | "end") {
    this.camera = camera;
    this.callbacks?.onCameraChange(camera, phase);
  }

  private anchorOf(endpoint: { nodeId: NodeId; portId: string }): Point | null {
    const view = this.nodeViews.get(endpoint.nodeId);
    if (!view) return null;
    const anchor = portAnchorWorld(view, endpoint.portId);
    if (anchor) return anchor;
    const { bounds } = view.node;
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  private reconcileEdges(scene: SceneState) {
    const seen = new Set<EdgeId>();
    for (const edge of scene.edges) {
      const from = this.anchorOf(edge.source);
      const to = this.anchorOf(edge.target);
      if (!from || !to) continue;
      seen.add(edge.id);
      const selected = scene.selection.edgeIds.includes(edge.id);
      const record = this.edgeViews.get(edge.id);
      if (!record) {
        const view = createEdgeView(edge, from, to, selected);
        this.edgeLayer.add(view.group);
        this.edgeViews.set(edge.id, { view, from, to, selected });
      } else if (
        record.view.edge !== edge ||
        record.from.x !== from.x ||
        record.from.y !== from.y ||
        record.to.x !== to.x ||
        record.to.y !== to.y ||
        record.selected !== selected
      ) {
        updateEdgeView(record.view, edge, from, to, selected);
        record.from = from;
        record.to = to;
        record.selected = selected;
      }
    }
    for (const [edgeId, record] of this.edgeViews) {
      if (!seen.has(edgeId)) {
        record.view.group.destroy();
        this.edgeViews.delete(edgeId);
      }
    }
  }

  private reconcileSelection(scene: SceneState) {
    const parts: string[] = [scene.camera.zoom.toFixed(4)];
    const selected: WorkflowNode[] = [];
    for (const nodeId of scene.selection.nodeIds) {
      const view = this.nodeViews.get(nodeId);
      if (!view) continue;
      const b = view.node.bounds;
      parts.push(`${nodeId}:${b.x},${b.y},${b.width},${b.height}`);
      selected.push(view.node);
    }
    const signature = parts.join("|");
    if (signature === this.selectionSignature) return;
    this.selectionSignature = signature;
    this.selectionLayer.removeAll();
    const strokeWidth = 2 / scene.camera.zoom;
    for (const node of selected) {
      this.selectionLayer.add(
        new Rect({
          x: node.bounds.x - 5,
          y: node.bounds.y - 5,
          width: node.bounds.width + 10,
          height: node.bounds.height + 10,
          cornerRadius: 14,
          fill: "#00000000",
          stroke: canvasTheme.selection,
          strokeWidth,
          dashPattern: [6 / scene.camera.zoom, 4 / scene.camera.zoom],
          hittable: false,
        }),
      );
    }
  }
}

function minimapAccent(node: WorkflowNode): string {
  return canvasTheme.kindAccent[node.kind] ?? canvasTheme.nodeMuted;
}
