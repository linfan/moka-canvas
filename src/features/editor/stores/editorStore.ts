import { create } from "zustand";
import type { EdgeId, NodeId } from "../../../shared/domain";

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
  | { kind: "canvas" }
  | { kind: "node"; nodeId: NodeId }
  | { kind: "edge"; edgeId: EdgeId }
  | { kind: "port"; nodeId: NodeId; portId: string };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

interface EditorState {
  tool: EditorTool;
  /** Space/Ctrl-held temporary tool inversion. */
  temporaryTool: EditorTool | null;
  selection: Selection;
  hoveredNodeId: NodeId | null;
  hoveredPort: PortRef | null;
  resourcesPanelOpen: boolean;
  inspectorOpen: boolean;
  contextMenu: ContextMenuState | null;

  setTool: (tool: EditorTool) => void;
  setTemporaryTool: (tool: EditorTool | null) => void;
  setSelection: (selection: Selection) => void;
  selectOnly: (nodeId: NodeId) => void;
  toggleNode: (nodeId: NodeId) => void;
  clearSelection: () => void;
  setHoveredNode: (nodeId: NodeId | null) => void;
  setHoveredPort: (port: PortRef | null) => void;
  toggleResourcesPanel: () => void;
  toggleInspector: () => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
}

export const EMPTY_SELECTION: Selection = { nodeIds: [], edgeIds: [] };

export const useEditorStore = create<EditorState>()((set) => ({
  tool: "select",
  temporaryTool: null,
  selection: EMPTY_SELECTION,
  hoveredNodeId: null,
  hoveredPort: null,
  resourcesPanelOpen: true,
  inspectorOpen: true,
  contextMenu: null,

  setTool: (tool) => set({ tool }),
  setTemporaryTool: (tool) => set({ temporaryTool: tool }),
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
  toggleResourcesPanel: () =>
    set((state) => ({ resourcesPanelOpen: !state.resourcesPanelOpen })),
  toggleInspector: () =>
    set((state) => ({ inspectorOpen: !state.inspectorOpen })),
  openContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
}));

export function useEffectiveTool(): EditorTool {
  return useEditorStore((state) => state.temporaryTool ?? state.tool);
}
