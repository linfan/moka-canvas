import { create } from "zustand";
import type { EdgeId, NodeId, Point, Viewport } from "../../../shared/domain";

export type EditorTool = "select" | "pan";

export interface Selection {
  nodeIds: NodeId[];
  edgeIds: EdgeId[];
}

export interface PortRef {
  nodeId: NodeId;
  portId: string;
}

export type ContextMenuTarget =
  | { kind: "canvas"; world: Point }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "edge"; edgeId: EdgeId }
  | { kind: "port"; nodeId: NodeId; portId: string };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

export interface NodeMenuState {
  /** Screen coordinates for the DOM menu. */
  x: number;
  y: number;
  /** World coordinate where the new node is created. */
  world: Point;
  /** Set when the menu opened from a dropped connection. */
  connectFrom: PortRef | null;
}

/**
 * One primary pointer gesture runs at a time. The canvas controller owns the
 * live preview and mirrors transitions here so DOM UI (menus, status line,
 * cursor affordances) can react without touching Leafer internals.
 */
export type ActiveGesture =
  | { kind: "idle" }
  | {
      kind: "panning";
      pointerId: number;
      startClient: Point;
      startViewport: Viewport;
    }
  | {
      kind: "marquee";
      pointerId: number;
      startWorld: Point;
      currentWorld: Point;
      additive: boolean;
    }
  | {
      kind: "draggingNodes";
      pointerId: number;
      nodeIds: NodeId[];
      startPositions: Record<NodeId, Point>;
      currentDelta: Point;
      snap: boolean;
    }
  | {
      kind: "resizingNode";
      pointerId: number;
      nodeId: NodeId;
      handle: string;
      startBounds: { x: number; y: number; width: number; height: number };
    }
  | {
      kind: "connecting";
      pointerId: number;
      source: PortRef;
      currentWorld: Point;
      compatibleTargets: PortRef[];
    }
  | { kind: "draggingAsset"; assetId: string; currentWorld: Point }
  | { kind: "draggingMinimap"; pointerId: number };

interface EditorState {
  tool: EditorTool;
  /** Space/Ctrl-held temporary tool inversion. */
  temporaryTool: EditorTool | null;
  /** Live camera while panning/zooming; persisted to the canvas on gesture end. */
  camera: Viewport | null;
  selection: Selection;
  hoveredNodeId: NodeId | null;
  hoveredPort: PortRef | null;
  gesture: ActiveGesture;
  /** Last known pointer position in world coordinates (paste-at-pointer). */
  pointerWorld: Point | null;
  resourcesPanelOpen: boolean;
  inspectorOpen: boolean;
  contextMenu: ContextMenuState | null;
  nodeMenu: NodeMenuState | null;
  renaming: { nodeId: NodeId } | null;
  /** Screen-reader announcement fed to the editor's live region. */
  announcement: string;

  setTool: (tool: EditorTool) => void;
  setTemporaryTool: (tool: EditorTool | null) => void;
  setCamera: (camera: Viewport) => void;
  setSelection: (selection: Selection) => void;
  selectOnly: (nodeId: NodeId) => void;
  toggleNode: (nodeId: NodeId) => void;
  clearSelection: () => void;
  setHoveredNode: (nodeId: NodeId | null) => void;
  setHoveredPort: (port: PortRef | null) => void;
  setGesture: (gesture: ActiveGesture) => void;
  setPointerWorld: (point: Point | null) => void;
  toggleResourcesPanel: () => void;
  toggleInspector: () => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  openNodeMenu: (menu: NodeMenuState) => void;
  closeNodeMenu: () => void;
  startRenaming: (nodeId: NodeId) => void;
  stopRenaming: () => void;
  announce: (message: string) => void;
}

export const EMPTY_SELECTION: Selection = { nodeIds: [], edgeIds: [] };

export const useEditorStore = create<EditorState>()((set) => ({
  tool: "select",
  temporaryTool: null,
  camera: null,
  selection: EMPTY_SELECTION,
  hoveredNodeId: null,
  hoveredPort: null,
  gesture: { kind: "idle" },
  pointerWorld: null,
  resourcesPanelOpen: true,
  inspectorOpen: true,
  contextMenu: null,
  nodeMenu: null,
  renaming: null,
  announcement: "",

  setTool: (tool) => set({ tool }),
  setTemporaryTool: (tool) => set({ temporaryTool: tool }),
  setCamera: (camera) => set({ camera }),
  setSelection: (selection) => set({ selection }),
  selectOnly: (nodeId) =>
    set({ selection: { nodeIds: [nodeId], edgeIds: [] } }),
  toggleNode: (nodeId) =>
    set((state) => {
      const nodeIds = state.selection.nodeIds.includes(nodeId)
        ? state.selection.nodeIds.filter((id) => id !== nodeId)
        : [...state.selection.nodeIds, nodeId];
      return { selection: { nodeIds, edgeIds: state.selection.edgeIds } };
    }),
  clearSelection: () => set({ selection: EMPTY_SELECTION }),
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),
  setHoveredPort: (port) => set({ hoveredPort: port }),
  setGesture: (gesture) => set({ gesture }),
  setPointerWorld: (point) => set({ pointerWorld: point }),
  toggleResourcesPanel: () =>
    set((state) => ({ resourcesPanelOpen: !state.resourcesPanelOpen })),
  toggleInspector: () =>
    set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  openContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  openNodeMenu: (menu) => set({ nodeMenu: menu }),
  closeNodeMenu: () => set({ nodeMenu: null }),
  startRenaming: (nodeId) => set({ renaming: { nodeId } }),
  stopRenaming: () => set({ renaming: null }),
  announce: (message) => set({ announcement: message }),
}));

export function useEffectiveTool(): EditorTool {
  return useEditorStore((state) => state.temporaryTool ?? state.tool);
}
