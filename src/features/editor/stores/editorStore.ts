import { create } from "zustand";
import type {
  AssetId,
  Capability,
  EdgeId,
  NodeId,
  Point,
  Viewport,
} from "../../../shared/domain";
import type { BarEntry } from "./toolPrefs";

export type EditorTool = "select" | "pan";

/**
 * What the column beside the canvas is showing.
 *
 * One column and a choice rather than several columns, since a canvas with a
 * resources column, an inspector, a conversation and a history beside it has
 * very little of itself left to look at.
 */
export type SidePanelTab = "inspector" | "assistant" | "history";

/**
 * What the column on the other side of the canvas is showing.
 *
 * Two faces of one column rather than two columns: what a project holds — its
 * boards and the folders they are filed in — and what it is made of, the assets
 * a board can be given. They are read together often enough to sit beside each
 * other, and a canvas narrow enough to need one of them folded away needs the
 * other folded away too.
 */
export type LeftPanelTab = "project" | "assets";

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

/** A tool asked of the picture a node holds, naming the picture it was asked of. */
export interface PictureToolAsk {
  nodeId: NodeId;
  assetId: AssetId;
  tool: BarEntry;
}

/**
 * What the asset picker was opened for.
 *
 * A dialog that only picks files would not know what picking them means: the
 * same shelf file becomes a node of its own, or something one node is given,
 * and those are different actions. Where it is meant to become a node, the
 * world point the ask was made at travels with it, so the nodes land where the
 * reader was looking rather than at the middle of the view.
 */
export type AssetPickerState =
  { mode: "nodes"; at: Point | null } | { mode: "reference"; nodeId: NodeId };

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
  /** Whether the column holding the project and its assets is showing. */
  leftPanelOpen: boolean;
  /** Which of its two faces that column is showing. */
  leftPanelTab: LeftPanelTab;
  /** Which kind of asset the assets column is listing. */
  assetKind: Capability;
  /**
   * The asset a reader was taken to, when one was asked for by name.
   *
   * Following an asset from the tree lands on the shelf with that one row marked
   * and in view, since a list of a hundred files scrolled to somewhere in the
   * middle is a list nobody can find their place in.
   */
  focusedAssetId: AssetId | null;
  /** Whether the column beside the canvas is showing at all. */
  sidePanelOpen: boolean;
  sidePanelTab: SidePanelTab;
  contextMenu: ContextMenuState | null;
  nodeMenu: NodeMenuState | null;
  renaming: { nodeId: NodeId } | null;
  /** Text-node body editing (textarea overlay). */
  textEditing: { nodeId: NodeId } | null;
  /**
   * The generation panel open under a node, and whether it takes the keyboard.
   *
   * Asked for by an entry the user chose (Enter, the right-click menu) it does;
   * brought up because a node was selected it must not, or typing would land in
   * the prompt and Delete would stop deleting the node.
   */
  promptPanel: { nodeId: NodeId; focus: boolean } | null;
  /** Whether selecting one node brings its generation panel up on its own. */
  promptPanelOnSelect: boolean;
  /** Inspector "replace input" pick mode: choosing a new source node. */
  inputPick: { nodeId: NodeId; portId: string } | null;
  /** Confirmation for deleting an asset still referenced by nodes. */
  assetDeletePrompt: { assetId: AssetId; nodeIds: NodeId[] } | null;
  /** Full-preview dialog for an asset (image/video). */
  previewAssetId: AssetId | null;
  /** The keyboard help dialog. */
  shortcutsOpen: boolean;
  /**
   * The tool being asked of a node's picture, if one is.
   *
   * The asset is named here rather than left to be found again from the node:
   * what a tool works on is the file the node held when it was asked, and a node
   * re-filled while the dialog is open must not change the subject under it.
   *
   * One field for every entry the bar offers, including the one that ends in a
   * generation rather than in a local operator, because the bar asks one
   * question at a time and two fields for it could both be answered at once.
   */
  pictureTool: PictureToolAsk | null;
  /** The asset picker dialog, and what it was opened for. */
  assetPicker: AssetPickerState | null;
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
  /**
   * Brings the column up on one of its faces, or folds it away where it is up on
   * that one already — the same offer the column beside it makes, so the two
   * sides of the canvas are worked the same way.
   */
  toggleLeftPanel: (tab: LeftPanelTab) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  setAssetKind: (kind: Capability) => void;
  /**
   * Opens the assets column on the kind an asset is filed under, with that one
   * marked. The kind travels with the ask rather than being worked out here,
   * since what asked is a row of the tree that was already grouping by it.
   */
  showAssetOnShelf: (assetId: AssetId, kind: Capability) => void;
  clearAssetFocus: () => void;
  /**
   * Brings the column up on one of its faces, or folds it away where it is
   * up on that one already.
   */
  toggleSidePanel: (tab: SidePanelTab) => void;
  setSidePanelTab: (tab: SidePanelTab) => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  openNodeMenu: (menu: NodeMenuState) => void;
  closeNodeMenu: () => void;
  startRenaming: (nodeId: NodeId) => void;
  stopRenaming: () => void;
  startEditingText: (nodeId: NodeId) => void;
  stopEditingText: () => void;
  openPromptPanel: (nodeId: NodeId, focus?: boolean) => void;
  closePromptPanel: () => void;
  togglePromptPanelOnSelect: () => void;
  startInputPick: (target: { nodeId: NodeId; portId: string }) => void;
  stopInputPick: () => void;
  openAssetDeletePrompt: (prompt: {
    assetId: AssetId;
    nodeIds: NodeId[];
  }) => void;
  closeAssetDeletePrompt: () => void;
  openPreview: (assetId: AssetId) => void;
  closePreview: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openPictureTool: (ask: PictureToolAsk) => void;
  closePictureTool: () => void;
  openAssetPicker: (ask: AssetPickerState) => void;
  closeAssetPicker: () => void;
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
  leftPanelOpen: true,
  leftPanelTab: "project",
  assetKind: "image",
  focusedAssetId: null,
  sidePanelOpen: true,
  sidePanelTab: "inspector",
  contextMenu: null,
  nodeMenu: null,
  renaming: null,
  textEditing: null,
  promptPanel: null,
  promptPanelOnSelect: true,
  inputPick: null,
  assetDeletePrompt: null,
  previewAssetId: null,
  shortcutsOpen: false,
  pictureTool: null,
  assetPicker: null,
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
  toggleLeftPanel: (tab) =>
    set((state) =>
      state.leftPanelOpen && state.leftPanelTab === tab
        ? { leftPanelOpen: false }
        : { leftPanelOpen: true, leftPanelTab: tab },
    ),
  setLeftPanelTab: (tab) => set({ leftPanelOpen: true, leftPanelTab: tab }),
  setAssetKind: (kind) => set({ assetKind: kind }),
  showAssetOnShelf: (assetId, kind) =>
    set({
      leftPanelOpen: true,
      leftPanelTab: "assets",
      assetKind: kind,
      focusedAssetId: assetId,
    }),
  clearAssetFocus: () => set({ focusedAssetId: null }),
  toggleSidePanel: (tab) =>
    set((state) =>
      state.sidePanelOpen && state.sidePanelTab === tab
        ? { sidePanelOpen: false }
        : { sidePanelOpen: true, sidePanelTab: tab },
    ),
  setSidePanelTab: (tab) => set({ sidePanelOpen: true, sidePanelTab: tab }),
  openContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  openNodeMenu: (menu) => set({ nodeMenu: menu }),
  closeNodeMenu: () => set({ nodeMenu: null }),
  startRenaming: (nodeId) => set({ renaming: { nodeId } }),
  stopRenaming: () => set({ renaming: null }),
  startEditingText: (nodeId) => set({ textEditing: { nodeId } }),
  stopEditingText: () => set({ textEditing: null }),
  openPromptPanel: (nodeId, focus = false) =>
    set({ promptPanel: { nodeId, focus } }),
  closePromptPanel: () => set({ promptPanel: null }),
  togglePromptPanelOnSelect: () =>
    set((state) => ({ promptPanelOnSelect: !state.promptPanelOnSelect })),
  startInputPick: (target) => set({ inputPick: target }),
  stopInputPick: () => set({ inputPick: null }),
  openAssetDeletePrompt: (prompt) => set({ assetDeletePrompt: prompt }),
  closeAssetDeletePrompt: () => set({ assetDeletePrompt: null }),
  openPreview: (assetId) => set({ previewAssetId: assetId }),
  closePreview: () => set({ previewAssetId: null }),
  openShortcuts: () => set({ shortcutsOpen: true }),
  closeShortcuts: () => set({ shortcutsOpen: false }),
  openPictureTool: (ask) => set({ pictureTool: ask }),
  closePictureTool: () => set({ pictureTool: null }),
  openAssetPicker: (ask) => set({ assetPicker: ask }),
  closeAssetPicker: () => set({ assetPicker: null }),
  announce: (message) => set({ announcement: message }),
}));

export function useEffectiveTool(): EditorTool {
  return useEditorStore((state) => state.temporaryTool ?? state.tool);
}
