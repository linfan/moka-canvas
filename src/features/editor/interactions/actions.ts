import {
  CASCADE_DROP_OFFSET,
  DEFAULT_NODE_WIDTH,
  GROUP_DETACH_THRESHOLD_PX,
  MAX_TEXT_CONTENT_LENGTH,
  createNode,
  defaultGenerationSpec,
  findNode,
  findResource,
  generationCapabilityFor,
  newId,
  nowIso,
  portTypesIntersect,
  validateEdgeCandidate,
  type AssetId,
  type BackgroundMode,
  type CanvasDocument,
  type CanvasId,
  type DocumentCommand,
  type EdgeId,
  type GenerationSpec,
  type NodeData,
  type NodeId,
  type NodeKind,
  type Point,
  type Rect,
  type ResultSlot,
  type ResourceEntry,
  type WorkflowNode,
} from "../../../shared/domain";
import { assetsApi, assetUrl, type AssetShelfEdit } from "../../../api";
import {
  toolsApi,
  type PictureTool,
  type PictureToolParams,
  type ToolReport,
} from "../../../api/tools";
import { useAppStore } from "../stores/appStore";
import {
  useEditorStore,
  type PortRef,
  type Selection,
} from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { TOOL_LABELS } from "../stores/toolPrefs";
import { execute } from "../commands/execute";
import {
  buildFragment,
  instantiateFragment,
  readMemoryFragment,
  readSystemClipboard,
  writeFragment,
  type CanvasFragment,
} from "./clipboard";
import { fitBounds, viewCenterWorld } from "../canvas/canvasControl";
import { buildResourceIndex } from "../canvas/mediaCards";
import { maskName } from "../canvas/repaint";
import type { ConnectionCheck } from "../canvas/controller";

function toastError(message: string) {
  useAppStore.getState().pushToast("error", message);
}

function announce(message: string) {
  useEditorStore.getState().announce(message);
}

/**
 * How far a new node sits from the point asked for: centred across it and a
 * little below its top edge, so the card lands under the pointer rather than
 * hanging off it.
 */
const NODE_DROP_OFFSET: Point = { x: DEFAULT_NODE_WIDTH / 2, y: 40 };

/** Room for the wire between a node and the one made out of it. */
const BESIDE_GAP_PX = 80;

/** The active canvas document, or null when nothing is open. */
export function activeCanvas(): CanvasDocument | null {
  const { moka, activeCanvasId } = useProjectStore.getState();
  if (!moka) return null;
  return (
    moka.canvas.find((canvas) => canvas.id === activeCanvasId) ??
    moka.canvas[0] ??
    null
  );
}

/** Group nodes in the list expand to their members (groups nest no groups). */
export function expandWithGroupMembers(
  canvas: CanvasDocument,
  nodeIds: NodeId[],
): NodeId[] {
  const result = new Set<NodeId>();
  const groups = new Map(canvas.groups.map((g) => [g.groupId, g.childNodeIds]));
  for (const nodeId of nodeIds) {
    result.add(nodeId);
    const node = findNode(canvas, nodeId);
    if (node?.kind === "group") {
      for (const member of groups.get(nodeId) ?? []) result.add(member);
    }
  }
  return [...result];
}

function selectionWithMembers(canvas: CanvasDocument): Selection {
  const selection = useEditorStore.getState().selection;
  return {
    nodeIds: expandWithGroupMembers(canvas, selection.nodeIds),
    edgeIds: selection.edgeIds,
  };
}

export function selectNodeWithMembers(nodeId: NodeId, additive: boolean) {
  const canvas = activeCanvas();
  const editor = useEditorStore.getState();
  if (!canvas) return;
  const ids = expandWithGroupMembers(canvas, [nodeId]);
  if (additive) {
    const has = editor.selection.nodeIds.includes(nodeId);
    const nodeIds = has
      ? editor.selection.nodeIds.filter((id) => !ids.includes(id))
      : [...new Set([...editor.selection.nodeIds, ...ids])];
    editor.setSelection({ nodeIds, edgeIds: editor.selection.edgeIds });
  } else {
    editor.setSelection({ nodeIds: ids, edgeIds: [] });
  }
  announceSelection(canvas);
}

function announceSelection(canvas: CanvasDocument) {
  const selection = useEditorStore.getState().selection;
  if (selection.nodeIds.length === 0 && selection.edgeIds.length === 0) {
    announce("Nothing selected");
  } else if (selection.nodeIds.length === 1 && selection.edgeIds.length === 0) {
    const node = findNode(canvas, selection.nodeIds[0]);
    announce(`Selected ${node?.title ?? "node"}`);
  } else {
    announce(
      `Selected ${selection.nodeIds.length} nodes, ${selection.edgeIds.length} edges`,
    );
  }
}

export function selectAll() {
  const canvas = activeCanvas();
  if (!canvas) return;
  useEditorStore.getState().setSelection({
    nodeIds: canvas.nodes.map((node) => node.id),
    edgeIds: [],
  });
  announce(`Selected all ${canvas.nodes.length} nodes`);
}

export function deleteSelection() {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = selectionWithMembers(canvas);
  if (selection.nodeIds.length === 0 && selection.edgeIds.length === 0) return;

  const commands: DocumentCommand[] = [];
  if (selection.nodeIds.length > 0) {
    commands.push({
      type: "removeNodes",
      canvasId: canvas.id,
      nodeIds: selection.nodeIds,
    });
  }
  // removeNodes already drops edges touching removed nodes.
  const removed = new Set(selection.nodeIds);
  const edgeIds = selection.edgeIds.filter((edgeId) => {
    const edge = canvas.edges.find((e) => e.id === edgeId);
    return (
      edge &&
      !removed.has(edge.source.nodeId) &&
      !removed.has(edge.target.nodeId)
    );
  });
  if (edgeIds.length > 0) {
    commands.push({ type: "removeEdges", canvasId: canvas.id, edgeIds });
  }
  if (execute("Delete selection", commands)) {
    useEditorStore.getState().clearSelection();
    announce(
      `Deleted ${selection.nodeIds.length} nodes, ${edgeIds.length} edges`,
    );
  }
}

export async function copySelection(): Promise<void> {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = selectionWithMembers(canvas);
  const fragment = buildFragment(canvas, selection.nodeIds);
  if (!fragment) return;
  await writeFragment(fragment);
  announce(`Copied ${fragment.nodes.length} nodes`);
}

export async function cutSelection(): Promise<void> {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = selectionWithMembers(canvas);
  const fragment = buildFragment(canvas, selection.nodeIds);
  if (!fragment) return;
  await writeFragment(fragment);
  deleteSelection();
}

function pasteFragment(fragment: CanvasFragment, anchor: Point) {
  const canvas = activeCanvas();
  const moka = useProjectStore.getState().moka;
  if (!canvas || !moka) return;
  const { nodes, edges, missingAssets } = instantiateFragment(
    fragment,
    moka,
    anchor,
  );
  const commands: DocumentCommand[] = [
    ...nodes.map(
      (node) => ({ type: "addNode", canvasId: canvas.id, node }) as const,
    ),
    ...edges.map(
      (edge) => ({ type: "addEdge", canvasId: canvas.id, edge }) as const,
    ),
  ];
  if (!execute("Paste", [...commands])) return;
  useEditorStore
    .getState()
    .setSelection({ nodeIds: nodes.map((node) => node.id), edgeIds: [] });
  if (missingAssets > 0) {
    toastError(
      `${missingAssets} asset reference${missingAssets === 1 ? "" : "s"} missing in this project`,
    );
  }
  announce(`Pasted ${nodes.length} nodes`);
}

/** Paste at a world point, falling back to the view center, then cascade. */
export async function pasteAt(at?: Point): Promise<void> {
  const anchor = at ??
    useEditorStore.getState().pointerWorld ??
    viewCenterWorld() ?? { x: 0, y: 0 };

  const fragment = readMemoryFragment();
  if (fragment) {
    pasteFragment(fragment, anchor);
    return;
  }
  const system = await readSystemClipboard();
  if (!system) return;
  if (system.kind === "fragment" && system.fragment) {
    pasteFragment(system.fragment, anchor);
  } else if (system.kind === "text" && system.text) {
    addNodeAt(anchor, "text", null, system.text);
  } else if (system.kind === "image" && system.image) {
    await pasteImage(system.image, anchor);
  }
}

async function pasteImage(blob: Blob, anchor: Point) {
  const canvas = activeCanvas();
  if (!canvas) return;
  try {
    const file = new File([blob], `pasted-${Date.now()}.png`, {
      type: blob.type || "image/png",
    });
    const change = await assetsApi.upload(file);
    useProjectStore.getState().integrateAssetEntry(change.entry, {
      revision: change.revision,
      updatedAt: change.updatedAt,
    });
    const node = createNode("image", {
      x: anchor.x - 140,
      y: anchor.y - 100,
    });
    node.data = { ...node.data, assetId: change.entry.id };
    if (
      execute("Paste image", [{ type: "addNode", canvasId: canvas.id, node }])
    ) {
      useEditorStore.getState().selectOnly(node.id);
      announce("Pasted image");
    }
  } catch (error) {
    toastError(error instanceof Error ? error.message : "Image paste failed");
  }
}

export async function duplicateSelection(): Promise<void> {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = selectionWithMembers(canvas);
  const fragment = buildFragment(canvas, selection.nodeIds);
  if (!fragment) return;
  pasteFragment(fragment, {
    x: fragment.origin.x + CASCADE_DROP_OFFSET,
    y: fragment.origin.y + CASCADE_DROP_OFFSET,
  });
}

export function groupSelection() {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = useEditorStore.getState().selection;
  const members = selection.nodeIds.filter((nodeId) => {
    const node = findNode(canvas, nodeId);
    return node && node.kind !== "group";
  });
  if (members.length < 2) {
    toastError("Select at least two nodes to group");
    return;
  }
  const rects = members.map((nodeId) => findNode(canvas, nodeId)!.bounds);
  const pad = 32;
  const minX = Math.min(...rects.map((r) => r.x)) - pad;
  const minY = Math.min(...rects.map((r) => r.y)) - pad;
  const maxX = Math.max(...rects.map((r) => r.x + r.width)) + pad;
  const maxY = Math.max(...rects.map((r) => r.y + r.height)) + pad;
  const group = createNode(
    "group",
    { x: minX, y: minY },
    { title: "Group", width: maxX - minX, height: maxY - minY },
  );
  group.zIndex =
    Math.min(...members.map((nodeId) => findNode(canvas, nodeId)!.zIndex)) - 1;
  const commands: DocumentCommand[] = [
    { type: "addNode", canvasId: canvas.id, node: group },
    {
      type: "setGroupMembership",
      canvasId: canvas.id,
      groupId: group.id,
      childNodeIds: members,
    },
  ];
  if (execute("Group nodes", commands)) {
    useEditorStore
      .getState()
      .setSelection({ nodeIds: [group.id, ...members], edgeIds: [] });
    announce(`Grouped ${members.length} nodes`);
  }
}

export function ungroupSelection() {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = useEditorStore.getState().selection;
  const groups = selection.nodeIds.filter(
    (nodeId) => findNode(canvas, nodeId)?.kind === "group",
  );
  if (groups.length === 0) return;
  const formerMembers: NodeId[] = [];
  const commands: DocumentCommand[] = [];
  for (const groupId of groups) {
    const membership = canvas.groups.find((g) => g.groupId === groupId);
    formerMembers.push(...(membership?.childNodeIds ?? []));
    commands.push({
      type: "setGroupMembership",
      canvasId: canvas.id,
      groupId,
      childNodeIds: [],
    });
  }
  if (execute("Ungroup", commands)) {
    useEditorStore
      .getState()
      .setSelection({ nodeIds: formerMembers, edgeIds: [] });
    announce("Ungrouped");
  }
}

/**
 * A change to how the canvas itself is shown.
 *
 * Not every change to a document is about what is in it: which way the
 * background is drawn and whether the map is up are the canvas's own settings,
 * so they travel in the file and undo like anything else. What already reads
 * the way it is asked for writes nothing at all.
 */
export function setCanvasViewSettings(patch: {
  background?: BackgroundMode;
  showMinimap?: boolean;
}) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const changed: { background?: BackgroundMode; showMinimap?: boolean } = {};
  if (
    patch.background !== undefined &&
    patch.background !== canvas.settings.background
  ) {
    changed.background = patch.background;
  }
  if (
    patch.showMinimap !== undefined &&
    patch.showMinimap !== canvas.settings.showMinimap
  ) {
    changed.showMinimap = patch.showMinimap;
  }
  if (Object.keys(changed).length === 0) return;
  const said: string[] = [];
  if (changed.background) said.push(`background to ${changed.background}`);
  if (changed.showMinimap !== undefined) {
    said.push(changed.showMinimap ? "the minimap up" : "the minimap away");
  }
  execute(`Canvas ${said.join(", ")}`, [
    { type: "setCanvasSettings", canvasId: canvas.id, settings: changed },
  ]);
}

/** The edge an arrangement lines the selected nodes up on. */
export type AlignEdge =
  "left" | "center" | "right" | "top" | "middle" | "bottom";

/** Which way an arrangement spreads the selected nodes out. */
export type ArrangeAxis = "horizontal" | "vertical";

/** Which dimension an arrangement levels off. */
export type SizeAxis = "width" | "height";

/**
 * The selected nodes an arrangement works on. Group frames are left out the way
 * they are left out of grouping: a frame stands for its members, and they are in
 * the selection themselves, so moving the frame as well would count them twice
 * and leave it describing a place its members no longer fill.
 */
function selectedArrangement(canvas: CanvasDocument): WorkflowNode[] {
  const { nodeIds } = useEditorStore.getState().selection;
  return nodeIds
    .map((nodeId) => findNode(canvas, nodeId))
    .filter(
      (node): node is WorkflowNode =>
        node !== undefined && node.kind !== "group",
    );
}

/** Lines the selected nodes up on one edge of the room they take up together. */
export function alignNodes(edge: AlignEdge) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const nodes = selectedArrangement(canvas);
  if (nodes.length < 2) return;
  const frame = unionBounds(nodes.map((node) => node.bounds));
  const positions: Record<NodeId, Point> = {};
  for (const node of nodes) {
    const { x, y, width, height } = node.bounds;
    let moved: Point = { x, y };
    if (edge === "left") moved = { x: frame.x, y };
    else if (edge === "center")
      moved = { x: frame.x + (frame.width - width) / 2, y };
    else if (edge === "right") moved = { x: frame.x + frame.width - width, y };
    else if (edge === "top") moved = { x, y: frame.y };
    else if (edge === "middle")
      moved = { x, y: frame.y + (frame.height - height) / 2 };
    else moved = { x, y: frame.y + frame.height - height };
    if (moved.x !== x || moved.y !== y) positions[node.id] = moved;
  }
  if (Object.keys(positions).length === 0) return;
  const commands: DocumentCommand[] = [
    { type: "moveNodes", canvasId: canvas.id, positions },
  ];
  if (execute(`Align ${edge}`, commands)) {
    announce(`Aligned ${nodes.length} nodes`);
  }
}

/**
 * Spreads the nodes between the two ends so the room from one to the next is
 * the same. The ends stay put, which is what makes this a tidy-up rather than a
 * second arrangement.
 */
export function distributeNodes(axis: ArrangeAxis) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const nodes = selectedArrangement(canvas);
  if (nodes.length < 3) return;
  const along = axis === "horizontal" ? "x" : "y";
  const extent = (node: WorkflowNode) =>
    axis === "horizontal" ? node.bounds.width : node.bounds.height;
  const sorted = [...nodes].sort((a, b) => a.bounds[along] - b.bounds[along]);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const start = first.bounds[along];
  const end = last.bounds[along] + extent(last);
  const taken = sorted.reduce((total, node) => total + extent(node), 0);
  const gap = (end - start - taken) / (sorted.length - 1);
  const positions: Record<NodeId, Point> = {};
  let cursor = start;
  for (const node of sorted) {
    const { x, y } = node.bounds;
    const moved: Point =
      axis === "horizontal" ? { x: cursor, y } : { x, y: cursor };
    cursor += extent(node) + gap;
    if (moved.x !== x || moved.y !== y) positions[node.id] = moved;
  }
  if (Object.keys(positions).length === 0) return;
  const commands: DocumentCommand[] = [
    { type: "moveNodes", canvasId: canvas.id, positions },
  ];
  if (execute(`Distribute ${axis}`, commands)) {
    announce(`Spread ${nodes.length} nodes evenly`);
  }
}

/** Gives every selected node the width — or the height — of the widest one. */
export function equalizeNodes(axis: SizeAxis) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const nodes = selectedArrangement(canvas);
  if (nodes.length < 2) return;
  const extent = (node: WorkflowNode) =>
    axis === "width" ? node.bounds.width : node.bounds.height;
  const target = Math.max(...nodes.map(extent));
  const commands: DocumentCommand[] = [];
  for (const node of nodes) {
    if (extent(node) === target) continue;
    commands.push({
      type: "resizeNode",
      canvasId: canvas.id,
      nodeId: node.id,
      bounds:
        axis === "width"
          ? { ...node.bounds, width: target }
          : { ...node.bounds, height: target },
    });
  }
  if (commands.length === 0) return;
  if (execute(`Same ${axis}`, commands)) {
    announce(`Gave ${nodes.length} nodes the same ${axis}`);
  }
}

/**
 * Commits a port-to-port connection. An occupied cardinality-one input is
 * replaced explicitly: the old edge is removed in the same history entry.
 */
export function connectPorts(source: PortRef, target: PortRef) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const result = validateEdgeCandidate(canvas, source, target);
  const commands: DocumentCommand[] = [];
  if (!result.ok) {
    if (result.code === "CARDINALITY_VIOLATION") {
      const occupying = canvas.edges
        .filter(
          (edge) =>
            edge.target.nodeId === target.nodeId &&
            edge.target.portId === target.portId,
        )
        .map((edge) => edge.id);
      commands.push({
        type: "removeEdges",
        canvasId: canvas.id,
        edgeIds: occupying,
      });
    } else {
      toastError(result.message);
      announce(`Connection rejected: ${result.message}`);
      return;
    }
  }
  commands.push({
    type: "addEdge",
    canvasId: canvas.id,
    edge: { id: newId(), source, target, createdAt: nowIso() },
  });
  if (execute("Connect ports", commands)) {
    const from = findNode(canvas, source.nodeId)?.title ?? "node";
    const to = findNode(canvas, target.nodeId)?.title ?? "node";
    announce(`Connected ${from} to ${to}`);
  }
}

/** True when a fresh node of `kind` could accept the source output. */
export function kindAcceptsConnection(
  canvas: CanvasDocument,
  source: PortRef,
  kind: NodeKind,
): boolean {
  const sourceNode = findNode(canvas, source.nodeId);
  const sourcePort = sourceNode?.ports.find((p) => p.id === source.portId);
  if (!sourcePort) return false;
  const candidate = createNode(kind, { x: 0, y: 0 });
  return candidate.ports.some(
    (p) =>
      p.direction === "input" &&
      portTypesIntersect(sourcePort.dataTypes, p.dataTypes),
  );
}

/** Removes a single edge (inspector chip disconnect). */
export function disconnectEdge(edgeId: EdgeId) {
  const canvas = activeCanvas();
  if (!canvas) return;
  if (
    execute("Disconnect", [
      { type: "removeEdges", canvasId: canvas.id, edgeIds: [edgeId] },
    ])
  ) {
    announce("Disconnected input");
  }
}

/** Removes every edge feeding one input port. */
export function disconnectInput(nodeId: NodeId, portId: string) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const edgeIds = canvas.edges
    .filter(
      (edge) => edge.target.nodeId === nodeId && edge.target.portId === portId,
    )
    .map((edge) => edge.id);
  if (edgeIds.length === 0) return;
  if (
    execute("Disconnect input", [
      { type: "removeEdges", canvasId: canvas.id, edgeIds },
    ])
  ) {
    announce("Disconnected input");
  }
}

/**
 * Moves one edge to another input of the node it already feeds, taking over
 * whatever was there.
 *
 * The leaving and the arriving are one step of history: an undo that only undid
 * the arrival would leave the node fed from both, which is not where it was.
 */
export function moveInput(edgeId: EdgeId, portId: string) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const edge = canvas.edges.find((entry) => entry.id === edgeId);
  if (!edge || edge.target.portId === portId) return;
  const target: PortRef = { nodeId: edge.target.nodeId, portId };
  const result = validateEdgeCandidate(canvas, edge.source, target);
  if (!result.ok && result.code !== "CARDINALITY_VIOLATION") {
    toastError(result.message);
    announce(`Connection rejected: ${result.message}`);
    return;
  }
  const leaving = canvas.edges
    .filter(
      (entry) =>
        entry.id === edgeId ||
        (entry.target.nodeId === target.nodeId &&
          entry.target.portId === portId),
    )
    .map((entry) => entry.id);
  const label =
    findNode(canvas, target.nodeId)?.ports.find((port) => port.id === portId)
      ?.label ?? portId;
  if (
    execute("Move an input", [
      { type: "removeEdges", canvasId: canvas.id, edgeIds: leaving },
      { type: "addEdge", canvasId: canvas.id, edge: { ...edge, target } },
    ])
  ) {
    announce(`Moved to ${label}`);
  }
}

/**
 * Nodes that could source the given input: every node with an output port
 * the domain validator accepts (an occupied input is a valid replace).
 */
export function pickSourceCandidates(
  canvas: CanvasDocument,
  target: PortRef,
): Set<NodeId> {
  const candidates = new Set<NodeId>();
  for (const node of canvas.nodes) {
    if (node.id === target.nodeId || node.kind === "group") continue;
    for (const port of node.ports) {
      if (port.direction !== "output") continue;
      const result = validateEdgeCandidate(
        canvas,
        { nodeId: node.id, portId: port.id },
        target,
      );
      if (result.ok || result.code === "CARDINALITY_VIOLATION") {
        candidates.add(node.id);
        break;
      }
    }
  }
  return candidates;
}

/** Pick mode resolution: connect the chosen node's first valid output. */
export function resolveInputPick(sourceNodeId: NodeId) {
  const canvas = activeCanvas();
  const pick = useEditorStore.getState().inputPick;
  useEditorStore.getState().stopInputPick();
  if (!canvas || !pick) return;
  const sourceNode = findNode(canvas, sourceNodeId);
  if (!sourceNode) return;
  for (const port of sourceNode.ports) {
    if (port.direction !== "output") continue;
    const result = validateEdgeCandidate(
      canvas,
      { nodeId: sourceNodeId, portId: port.id },
      pick,
    );
    if (result.ok || result.code === "CARDINALITY_VIOLATION") {
      connectPorts({ nodeId: sourceNodeId, portId: port.id }, pick);
      return;
    }
  }
  toastError("That node has no compatible output");
}

/** Nodes across every canvas that reference the asset. */
export function assetReferencingNodeIds(assetId: string): NodeId[] {
  const { moka } = useProjectStore.getState();
  if (!moka) return [];
  const ids: NodeId[] = [];
  for (const canvas of moka.canvas) {
    for (const node of canvas.nodes) {
      const data = node.data as { assetId?: string; posterAssetId?: string };
      if (data.assetId === assetId || data.posterAssetId === assetId) {
        ids.push(node.id);
      }
    }
  }
  return ids;
}

/**
 * Writes down whether this file is kept to hand. The registry entry is all it
 * touches, so marking a video a keeper costs nothing of the video's.
 */
export async function markAssetKeeper(
  entry: ResourceEntry,
  keeper: boolean,
): Promise<void> {
  try {
    const change = await assetsApi.patchShelf(entry.id, { favorite: keeper });
    useProjectStore.getState().integrateAssetEntry(change.entry, {
      revision: change.revision,
      updatedAt: change.updatedAt,
    });
    announce(`${entry.name} ${keeper ? "is a keeper" : "is no keeper"}`);
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : "Could not write to the shelf",
    );
  }
}

/**
 * Writes down the words an entry is filed under and whatever was noted about
 * it. The file underneath is not touched.
 */
export async function editShelfEntry(
  entry: ResourceEntry,
  edit: AssetShelfEdit,
): Promise<void> {
  try {
    const change = await assetsApi.patchShelf(entry.id, edit);
    useProjectStore.getState().integrateAssetEntry(change.entry, {
      revision: change.revision,
      updatedAt: change.updatedAt,
    });
    announce(`Refiled ${change.entry.name}`);
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : "Could not write to the shelf",
    );
  }
}

/** Whether a node holds work the shelf could take as it stands. */
export function filingPossible(node: WorkflowNode): boolean {
  if (node.kind === "text") {
    const content = (node.data as { content?: string }).content ?? "";
    return content.trim() !== "";
  }
  if (node.kind === "image" || node.kind === "audio" || node.kind === "video") {
    return Boolean((node.data as { assetId?: AssetId }).assetId);
  }
  return false;
}

/**
 * Keeps a node's work to hand.
 *
 * The server reads the node from the document on disk, so anything still on
 * its way there is saved first: a text node filed the moment its words were
 * typed would otherwise be filed as they were a moment before.
 */
export async function fileNodeAsAsset(
  canvasId: CanvasId,
  nodeId: NodeId,
): Promise<void> {
  try {
    await useProjectStore.getState().flush();
    if (useProjectStore.getState().pending.length > 0) {
      toastError("Changes are still saving — try again in a moment");
      return;
    }
    const filed = await assetsApi.fileNode(canvasId, nodeId);
    useProjectStore.getState().integrateAssetEntry(filed.entry, {
      revision: filed.revision,
      updatedAt: filed.updatedAt,
    });
    announce(
      filed.created
        ? `${filed.entry.name} saved to the shelf`
        : `${filed.entry.name} is already on the shelf`,
    );
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : "Could not save to the shelf",
    );
  }
}

/**
 * Delete flow: unreferenced assets go straight to the server; referenced
 * ones open a confirmation that also removes the referencing nodes.
 */
export async function requestDeleteAsset(assetId: string) {
  const nodeIds = assetReferencingNodeIds(assetId);
  if (nodeIds.length > 0) {
    useEditorStore.getState().openAssetDeletePrompt({ assetId, nodeIds });
    return;
  }
  await removeAssetNow(assetId);
}

async function removeAssetNow(assetId: string) {
  try {
    // The server rejects deletes while its copy still references the asset;
    // pending edits (like the just-removed nodes) must land first.
    await useProjectStore.getState().flush();
    if (useProjectStore.getState().pending.length > 0) {
      toastError("Changes are still saving — try again in a moment");
      return;
    }
    const result = await assetsApi.remove(assetId);
    useProjectStore.getState().removeAssetEntry(assetId, result);
    announce("Asset removed");
  } catch (error) {
    toastError(error instanceof Error ? error.message : "Delete failed");
  }
}

/** Confirmed delete: drop the referencing nodes (edges cascade), then the file. */
export async function confirmDeleteAsset() {
  const prompt = useEditorStore.getState().assetDeletePrompt;
  useEditorStore.getState().closeAssetDeletePrompt();
  if (!prompt) return;
  const { moka } = useProjectStore.getState();
  if (!moka) return;
  const commands: DocumentCommand[] = [];
  for (const canvas of moka.canvas) {
    const here = canvas.nodes.filter((node) =>
      prompt.nodeIds.includes(node.id),
    );
    if (here.length > 0) {
      commands.push({
        type: "removeNodes",
        canvasId: canvas.id,
        nodeIds: here.map((node) => node.id),
      });
    }
  }
  if (commands.length > 0 && !execute("Remove referencing nodes", commands)) {
    return;
  }
  useEditorStore.getState().setSelection({ nodeIds: [], edgeIds: [] });
  await removeAssetNow(prompt.assetId);
}

/**
 * Builds the node a registered asset becomes: its kind from where the file
 * lives, its title from the file's own name, and its body from what the asset
 * holds. `at` is the corner the node is placed at.
 */
async function makeAssetNode(
  assetId: AssetId,
  at: Point,
): Promise<WorkflowNode | null> {
  const { moka } = useProjectStore.getState();
  if (!moka) return null;
  const entry = buildResourceIndex(moka).get(assetId);
  if (!entry) return null;
  const category = entry.path.split("/")[1];
  let kind: NodeKind;
  if (category === "images") kind = "image";
  else if (category === "videos") kind = "video";
  else if (category === "music" || category === "voice") kind = "audio";
  else kind = "text";
  const node = createNode(kind, at);
  node.title = entry.name;
  if (kind === "audio") {
    node.data = {
      assetId,
      audioCategory: category === "voice" ? "voice" : "music",
    };
  } else if (kind === "text") {
    let content = "";
    try {
      const response = await fetch(assetUrl(assetId));
      if (response.ok) {
        content = (await response.text()).slice(0, MAX_TEXT_CONTENT_LENGTH);
      }
    } catch {
      // Keep the empty body; the asset link still identifies the file.
    }
    node.data = { content, assetId };
  } else {
    node.data = {
      assetId,
      posterAssetId: entry.probe?.posterAssetId,
    };
  }
  return node;
}

/** Creates a source node for a registered asset at a world position. */
export async function addAssetNode(assetId: AssetId, at?: Point) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const anchor = at ?? viewCenterWorld() ?? { x: 0, y: 0 };
  const node = await makeAssetNode(assetId, {
    x: anchor.x - NODE_DROP_OFFSET.x,
    y: anchor.y - NODE_DROP_OFFSET.y,
  });
  if (!node) return;
  if (
    execute("Add asset node", [{ type: "addNode", canvasId: canvas.id, node }])
  ) {
    useEditorStore.getState().selectOnly(node.id);
    announce(`Added ${node.title}`);
  }
}

/**
 * Creates a node for an asset beside the node it is meant to feed, and hands
 * back its id.
 *
 * The selection is left where it was, which is the whole of the difference from
 * dropping the same asset on the canvas: this is how a node is given something
 * while its own panel is open, and a panel follows the selection.
 *
 * `step` walks a run of nodes down and to the right of the one before it, for
 * when several are being laid out in one go: without it every one of them would
 * land on the same spot and only the last would be reachable.
 */
export async function addAssetBeside(
  targetNodeId: NodeId,
  assetId: AssetId,
  step = 0,
): Promise<NodeId | null> {
  const canvas = activeCanvas();
  const target = canvas ? findNode(canvas, targetNodeId) : null;
  if (!canvas || !target) return null;
  const node = await makeAssetNode(assetId, {
    x:
      target.bounds.x -
      BESIDE_GAP_PX -
      DEFAULT_NODE_WIDTH +
      step * CASCADE_DROP_OFFSET,
    y: target.bounds.y + step * CASCADE_DROP_OFFSET,
  });
  if (!node) return null;
  if (
    execute("Add a reference", [{ type: "addNode", canvasId: canvas.id, node }])
  ) {
    announce(`Added ${node.title}`);
    return node.id;
  }
  return null;
}

/**
 * Lays out a source node for each of the chosen assets in one undo step, and
 * selects all of them, so what arrived together can be moved together.
 *
 * Several at once because that is what the picker asks: one choice of several
 * files is one action, and undoing it should take all of them back rather than
 * one per file that happened to be picked.
 */
export async function addAssetNodes(
  assetIds: AssetId[],
  at?: Point,
): Promise<NodeId[]> {
  const canvas = activeCanvas();
  if (!canvas || assetIds.length === 0) return [];
  const anchor = at ?? viewCenterWorld() ?? { x: 0, y: 0 };
  const commands: DocumentCommand[] = [];
  const made: NodeId[] = [];
  for (const [index, assetId] of assetIds.entries()) {
    const node = await makeAssetNode(assetId, {
      x: anchor.x - NODE_DROP_OFFSET.x + index * CASCADE_DROP_OFFSET,
      y: anchor.y - NODE_DROP_OFFSET.y + index * CASCADE_DROP_OFFSET,
    });
    if (!node) continue;
    commands.push({ type: "addNode", canvasId: canvas.id, node });
    made.push(node.id);
  }
  if (made.length === 0) return [];
  if (!execute("Add asset nodes", commands)) return [];
  useEditorStore.getState().setSelection({ nodeIds: made, edgeIds: [] });
  announce(`Added ${made.length} ${made.length === 1 ? "node" : "nodes"}`);
  return made;
}

/**
 * Gives a node each of the chosen assets, each as a node of its own beside it.
 *
 * Where the node takes what it is given from the wiring, each new node is wired
 * in; where it takes it from a list kept by hand, the list gains every one of
 * them in a single step, in the order they were chosen.
 */
export async function attachAssetsToNode(
  targetNodeId: NodeId,
  assetIds: AssetId[],
): Promise<void> {
  const canvas = activeCanvas();
  const target = canvas ? findNode(canvas, targetNodeId) : null;
  if (!canvas || !target) return;
  const made: NodeId[] = [];
  for (const [index, assetId] of assetIds.entries()) {
    const nodeId = await addAssetBeside(targetNodeId, assetId, index);
    if (nodeId) made.push(nodeId);
  }
  if (made.length === 0) return;
  const spec = (target.data as { generation?: GenerationSpec }).generation;
  if (spec?.inputMode === "manual") {
    setNodeGeneration(canvas.id, targetNodeId, {
      ...spec,
      referenceNodeIds: [...spec.referenceNodeIds, ...made],
      updatedAt: nowIso(),
    });
    return;
  }
  const unwired = made.filter((nodeId) => !feedInto(nodeId, targetNodeId));
  if (unwired.length > 0) {
    announce("It is on the canvas, but this node has no input for it");
  }
}

/**
 * Works on a picture the project already holds with a tool that asks nothing of
 * anybody, and lays out what came back.
 *
 * The subject is left exactly as it was, which is the whole of what makes a tool
 * safe to press: what it makes is filed as an asset of its own and gets a node
 * of its own to the right, wired from the subject, so the step reads in the graph
 * as one picture made out of another rather than as a file that changed
 * underneath a node. Every piece lands in one undo step and all of them are
 * selected, so a division can be grouped the moment it arrives.
 *
 * Null when nothing was made: a refusal, which is said out loud here rather than
 * left to be read in the dialog that asked, or a subject this canvas has lost.
 */
export async function applyPictureTool(
  nodeId: NodeId,
  assetId: AssetId,
  tool: PictureTool,
  params: PictureToolParams[PictureTool],
): Promise<NodeId[] | null> {
  const canvas = activeCanvas();
  const subject = canvas ? findNode(canvas, nodeId) : undefined;
  if (!canvas || !subject) return null;

  let report: ToolReport;
  try {
    report = await toolsApi.apply(tool, assetId, params);
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : "The tool could not be done",
    );
    return null;
  }

  const out = subject.ports.find((port) => port.direction === "output");
  const beside = {
    x: subject.bounds.x + subject.bounds.width + BESIDE_GAP_PX,
    y: subject.bounds.y,
  };
  const commands: DocumentCommand[] = [];
  const made: NodeId[] = [];
  for (const [index, entry] of report.entries.entries()) {
    // Filed in the registry before the node is built, because a node is built
    // out of what the registry says the asset is.
    useProjectStore.getState().integrateAssetEntry(entry, report);
    const node = await makeAssetNode(entry.id, {
      x: beside.x + index * CASCADE_DROP_OFFSET,
      y: beside.y + index * CASCADE_DROP_OFFSET,
    });
    if (!node) continue;
    commands.push({ type: "addNode", canvasId: canvas.id, node });
    made.push(node.id);
    // Matched by what the ports carry rather than asked of the canvas, which has
    // not seen this node yet. An output feeds as many inputs as it is given.
    const into = out
      ? node.ports.find(
          (port) =>
            port.direction === "input" &&
            portTypesIntersect(out.dataTypes, port.dataTypes),
        )
      : undefined;
    if (out && into) {
      commands.push({
        type: "addEdge",
        canvasId: canvas.id,
        edge: {
          id: newId(),
          source: { nodeId: subject.id, portId: out.id },
          target: { nodeId: node.id, portId: into.id },
          createdAt: nowIso(),
        },
      });
    }
  }
  if (made.length === 0) return null;
  if (!execute(`${TOOL_LABELS[tool]} a picture`, commands)) return null;
  useEditorStore.getState().setSelection({ nodeIds: made, edgeIds: [] });
  // A turn reports the words its picture was made from, and they are worth more
  // than a count: they are what the next ask made out of it is written against.
  announce(
    report.prompt ??
      (made.length === 1
        ? `Made ${report.entries[0].name}`
        : `Made ${made.length} pieces, and selected them`),
  );
  return made;
}

/** The port a mask is fed through, and the only one that carries it as one. */
const MASK_PORT = "mask";

export interface RepaintAsk {
  nodeId: NodeId;
  /** The picture the region was marked on, which is the one left as it is. */
  assetId: AssetId;
  /** The name of that picture, which is what the mask filed beside it is named. */
  sourceName: string;
  /** The finished mask: white where the picture may change, black where it may not. */
  mask: Blob;
  /** What the marked part should become. */
  prompt: string;
}

/**
 * Files a marked region as a mask of its own and points the picture at it.
 *
 * Nothing is repainted here, and that is the point: what this makes is the two
 * halves of an ask — a picture with a region marked on it and the words saying
 * what the region should become — laid out on the canvas where they can be read,
 * changed and run again. The mask is a node like any other reference, so a
 * second attempt is a matter of editing the words rather of painting again.
 *
 * The picture's ask becomes an edit that reads what is wired into it. A mask
 * travels as a mask only along a wire: picked by hand into a list of references
 * it arrives as just another picture, and the region marked on it means nothing.
 * A picture wears one of them, so marking a second region takes the port over.
 *
 * Null when nothing was filed, which is said out loud here rather than left to
 * be read in the dialog that asked.
 */
export async function fileRepaint(ask: RepaintAsk): Promise<NodeId | null> {
  const canvas = activeCanvas();
  const subject = canvas ? findNode(canvas, ask.nodeId) : undefined;
  if (!canvas || !subject) return null;
  const sink = subject.ports.find((port) => port.id === MASK_PORT);
  if (!sink) return null;

  const name = maskName(ask.sourceName);
  let saved;
  try {
    saved = await assetsApi.upload(
      new File([ask.mask], name, { type: "image/png" }),
      { categoryHint: "images" },
    );
  } catch (error) {
    toastError(
      error instanceof Error ? error.message : "The mask could not be filed",
    );
    return null;
  }
  useProjectStore.getState().integrateAssetEntry(saved.entry, saved);

  // A picture wears one mask: the port takes a single wire, so marking again
  // takes the port over rather than adding to it.
  const worn = canvas.edges.find(
    (edge) =>
      edge.target.nodeId === subject.id && edge.target.portId === MASK_PORT,
  );
  const before = worn ? findNode(canvas, worn.source.nodeId) : undefined;
  // To the left, where an input comes from, and below the mask this replaces
  // rather than on top of it, so the attempts stay readable in the order they
  // were made. What was there is left on the canvas as the picture it is.
  const node = await makeAssetNode(saved.entry.id, {
    x: subject.bounds.x - BESIDE_GAP_PX - DEFAULT_NODE_WIDTH,
    y: before ? before.bounds.y + CASCADE_DROP_OFFSET : subject.bounds.y,
  });
  if (!node) return null;
  const out = node.ports.find((port) => port.direction === "output");
  if (!out) return null;

  const held = subject.data as { generation?: GenerationSpec };
  const base = held.generation ?? defaultGenerationSpec(subject.kind);
  const commands: DocumentCommand[] = [];
  // Let go of the old wire in the same step as the new one arrives, since the
  // port would refuse a second and the two are never meaningfully apart.
  if (worn) {
    commands.push({
      type: "removeEdges",
      canvasId: canvas.id,
      edgeIds: [worn.id],
    });
  }
  commands.push(
    { type: "addNode", canvasId: canvas.id, node },
    {
      type: "addEdge",
      canvasId: canvas.id,
      edge: {
        id: newId(),
        source: { nodeId: node.id, portId: out.id },
        target: { nodeId: subject.id, portId: sink.id },
        createdAt: nowIso(),
      },
    },
  );
  if (base) {
    commands.push({
      type: "updateNode",
      canvasId: canvas.id,
      nodeId: subject.id,
      patch: {
        data: {
          ...(subject.data as Record<string, unknown>),
          generation: {
            ...base,
            mode: "edit",
            prompt: ask.prompt,
            inputMode: "upstream",
            updatedAt: nowIso(),
          },
        } as NodeData,
      },
    });
  }
  if (!execute("Mark a region to repaint", commands)) return null;

  useEditorStore.getState().selectOnly(subject.id);
  // Left open on the picture rather than closed with the painting: the next
  // thing to do with a mask is ask what it marks, and that is one press away.
  useEditorStore.getState().openPromptPanel(subject.id);
  announce(`Marked a region of ${ask.sourceName} to repaint`);
  return node.id;
}

/** The port the words read out of a picture are fed back through. */
const PROMPT_PORT = "prompt";

export interface DescriptionAsk {
  nodeId: NodeId;
  /** The name of the picture the words were read out of. */
  sourceName: string;
  /** What the model said, which is what gets filed. */
  words: string;
}

/**
 * Files the words a model read out of a picture as a text node of their own,
 * wired back into the picture's prompt.
 *
 * Filed as a node rather than written into the picture's own ask, so that what a
 * model guessed is on the canvas where it can be read, corrected and let go of
 * rather than hiding in a field: a description is a first draft of a prompt and
 * rarely the last word on one. Wiring it back is what makes the picture askable
 * again from the words it was read back as, which is the whole of the point.
 *
 * A prompt takes as many wires as it is given, so a second reading joins the
 * first rather than taking it over — and nothing already wired in is touched,
 * since one of those wires may be a node the reader wrote by hand.
 *
 * Null when nothing was filed: a subject this canvas has lost, or a refusal
 * from the document, which is said out loud here rather than left to be read in
 * the dialog that asked.
 */
export function fileDescription(ask: DescriptionAsk): NodeId | null {
  const canvas = activeCanvas();
  const subject = canvas ? findNode(canvas, ask.nodeId) : undefined;
  if (!canvas || !subject) return null;
  const sink = subject.ports.find((port) => port.id === PROMPT_PORT);
  if (!sink) return null;

  // To the left, where an input comes from, and below whatever already feeds this
  // prompt: a picture read back twice over has two sets of words on the canvas
  // and the second has to land where a reader can see it.
  const fed = canvas.edges
    .filter(
      (edge) =>
        edge.target.nodeId === subject.id && edge.target.portId === sink.id,
    )
    .map((edge) => findNode(canvas, edge.source.nodeId))
    .filter((node): node is WorkflowNode => Boolean(node));
  const node = createNode("text", {
    x: subject.bounds.x - BESIDE_GAP_PX - DEFAULT_NODE_WIDTH,
    y:
      fed.length === 0
        ? subject.bounds.y
        : Math.max(...fed.map((entry) => entry.bounds.y)) + CASCADE_DROP_OFFSET,
  });
  node.title = `Words for ${ask.sourceName}`;
  node.data = { content: ask.words.slice(0, MAX_TEXT_CONTENT_LENGTH) };
  const out = node.ports.find((port) => port.direction === "output");
  if (!out) return null;

  const filed = execute("Read a picture back as words", [
    { type: "addNode", canvasId: canvas.id, node },
    {
      type: "addEdge",
      canvasId: canvas.id,
      edge: {
        id: newId(),
        source: { nodeId: node.id, portId: out.id },
        target: { nodeId: subject.id, portId: sink.id },
        createdAt: nowIso(),
      },
    },
  ]);
  if (!filed) return null;

  // Selected rather than the picture: what a reader wants next is the words, and
  // they are on this node.
  useEditorStore.getState().selectOnly(node.id);
  announce(`Read ${ask.sourceName} back as words`);
  return node.id;
}

/**
 * Fills a node that is waiting for something with an asset the project already
 * holds, which is the other way to fill one: nothing is asked for, so nothing
 * is spent, and the node stops being an ask and becomes the thing itself.
 */
export function linkAsset(nodeId: NodeId, assetId: AssetId) {
  const canvas = activeCanvas();
  const { moka } = useProjectStore.getState();
  const node = canvas ? findNode(canvas, nodeId) : undefined;
  if (!canvas || !node || !moka) return;
  const entry = findResource(moka, assetId);
  if (!entry) return;
  const data = { ...(node.data as Record<string, unknown>), assetId };
  if (
    execute("Link an asset", [
      {
        type: "updateNode",
        canvasId: canvas.id,
        nodeId,
        patch: { data: data as NodeData },
      },
    ])
  ) {
    announce(`Linked ${entry.name}`);
  }
}

/**
 * Wires the first output of one node that fits into the first input of another
 * that is free to take it.
 *
 * False when the two have nothing in common, which is the caller's to say out
 * loud: a node created beside this one may still have nowhere to plug into it.
 * An input already holding something is passed over rather than replaced, since
 * taking over a mask or a frame is a choice rather than a side effect.
 */
export function feedInto(sourceNodeId: NodeId, targetNodeId: NodeId): boolean {
  const canvas = activeCanvas();
  if (!canvas) return false;
  const source = findNode(canvas, sourceNodeId);
  const target = findNode(canvas, targetNodeId);
  if (!source || !target) return false;
  for (const out of source.ports) {
    if (out.direction !== "output") continue;
    for (const into of target.ports) {
      if (into.direction !== "input") continue;
      const from: PortRef = { nodeId: sourceNodeId, portId: out.id };
      const to: PortRef = { nodeId: targetNodeId, portId: into.id };
      if (!validateEdgeCandidate(canvas, from, to).ok) continue;
      connectPorts(from, to);
      return true;
    }
  }
  return false;
}

export interface ImportFilesOptions {
  /** World anchor for created nodes; each file cascades from it. */
  at?: Point;
  /** Create a source node per imported asset. */
  addNodes?: boolean;
  signal?: AbortSignal;
  onFileProgress?: (index: number, fraction: number) => void;
  /** Fires once per settled file; `error` is set when the file failed. */
  onFileDone?: (index: number, error?: string) => void;
}

/** dataTransfer type carrying an asset id dragged from the resource panel. */
export const ASSET_DRAG_MIME = "application/x-moka-asset";

/**
 * Uploads files one at a time (server sniffing routes each to its category
 * directory) and folds every accepted entry into the local registry. A failed
 * file is reported and skipped; the rest of the batch continues.
 */
export async function importFiles(
  files: File[],
  options: ImportFilesOptions = {},
): Promise<void> {
  for (const [index, file] of files.entries()) {
    if (options.signal?.aborted) break;
    try {
      const change = await assetsApi.upload(file, {
        signal: options.signal,
        onUploadProgress: options.onFileProgress
          ? (fraction) => options.onFileProgress?.(index, fraction)
          : undefined,
      });
      useProjectStore.getState().integrateAssetEntry(change.entry, {
        revision: change.revision,
        updatedAt: change.updatedAt,
      });
      if (options.addNodes) {
        const at = options.at
          ? {
              x: options.at.x + index * CASCADE_DROP_OFFSET,
              y: options.at.y + index * CASCADE_DROP_OFFSET,
            }
          : undefined;
        await addAssetNode(change.entry.id, at);
      }
      options.onFileDone?.(index);
    } catch (error) {
      if (options.signal?.aborted) break;
      const message = error instanceof Error ? error.message : "Import failed";
      toastError(`${file.name}: ${message}`);
      options.onFileDone?.(index, message);
    }
  }
}

export function addNodeAt(
  world: Point,
  kind: NodeKind,
  connectFrom: PortRef | null,
  textContent?: string,
): NodeId | null {
  const canvas = activeCanvas();
  if (!canvas) return null;
  const node = createNode(kind, {
    x: world.x - NODE_DROP_OFFSET.x,
    y: world.y - NODE_DROP_OFFSET.y,
  });
  if (textContent !== undefined && node.kind === "text") {
    node.data = { ...node.data, content: textContent };
  }
  const commands: DocumentCommand[] = [
    { type: "addNode", canvasId: canvas.id, node },
  ];
  let connected = false;
  if (connectFrom) {
    const sourceNode = findNode(canvas, connectFrom.nodeId);
    const sourcePort = sourceNode?.ports.find(
      (p) => p.id === connectFrom.portId,
    );
    const targetPort = sourcePort
      ? node.ports.find(
          (p) =>
            p.direction === "input" &&
            portTypesIntersect(sourcePort.dataTypes, p.dataTypes),
        )
      : undefined;
    if (targetPort) {
      commands.push({
        type: "addEdge",
        canvasId: canvas.id,
        edge: {
          id: newId(),
          source: connectFrom,
          target: { nodeId: node.id, portId: targetPort.id },
          createdAt: nowIso(),
        },
      });
      connected = true;
    }
  }
  if (!execute(connected ? "Add connected node" : "Add node", commands)) {
    return null;
  }
  useEditorStore.getState().selectOnly(node.id);
  announce(`Added ${node.title}${connected ? " (connected)" : ""}`);
  return node.id;
}

/**
 * Makes a node that asks for what `kind` produces, beside the node it is made
 * out of and fed by it, and opens the panel where the ask is written.
 *
 * Nothing is asked for. The run is one press away in the panel that opens, so
 * picking from a menu cannot spend anything on a provider by accident, and what
 * arrives is written where it can be read before it is sent.
 */
export function generateFrom(sourceNodeId: NodeId, kind: NodeKind) {
  const canvas = activeCanvas();
  const source = canvas ? findNode(canvas, sourceNodeId) : undefined;
  if (!source) return;
  const made = addNodeAt(
    {
      x:
        source.bounds.x +
        source.bounds.width +
        BESIDE_GAP_PX +
        NODE_DROP_OFFSET.x,
      y: source.bounds.y + NODE_DROP_OFFSET.y,
    },
    kind,
    { nodeId: source.id, portId: "out" },
  );
  if (made) useEditorStore.getState().openPromptPanel(made, true);
}

export function renameNode(nodeId: NodeId, title: string) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const trimmed = title.trim();
  const node = findNode(canvas, nodeId);
  if (!node || !trimmed || trimmed === node.title) return;
  execute("Rename node", [
    {
      type: "updateNode",
      canvasId: canvas.id,
      nodeId,
      patch: { title: trimmed },
    },
  ]);
}

export function editTextContent(nodeId: NodeId, content: string) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const node = findNode(canvas, nodeId);
  if (!node || node.kind !== "text") return;
  const current = (node.data as { content?: string }).content ?? "";
  if (content === current) return;
  execute("Edit text", [
    {
      type: "updateNode",
      canvasId: canvas.id,
      nodeId,
      patch: { data: { ...node.data, content } },
    },
  ]);
}

/**
 * Whether two specs ask for the same thing.
 *
 * The timestamp says when a spec was written rather than what it asks for, so
 * two differing only in it are one request: writing the second would cost a
 * save, a revision, and a history entry with nothing having changed.
 */
function asksTheSame(
  a: GenerationSpec | null,
  b: GenerationSpec | null,
): boolean {
  const asked = (spec: GenerationSpec | null) =>
    spec === null ? null : { ...spec, updatedAt: "" };
  return JSON.stringify(asked(a)) === JSON.stringify(asked(b));
}

/**
 * Writes or clears a node's generation spec in one undoable step. Addressed by
 * canvas id rather than the active canvas, so a background canvas can be
 * prepared while another one is on screen.
 *
 * Callers commit prompt edits on blur; an unchanged spec is skipped so those
 * commits do not add identical entries to the history stack.
 *
 * Bounds may travel with the spec: asking a node for a shape and giving the node
 * that shape are one action, and undoing it should give back both.
 */
export function setNodeGeneration(
  canvasId: CanvasId,
  nodeId: NodeId,
  generation: GenerationSpec | null,
  bounds?: Rect,
) {
  const { moka } = useProjectStore.getState();
  const canvas = moka?.canvas.find((entry) => entry.id === canvasId);
  const node = canvas ? findNode(canvas, nodeId) : undefined;
  if (!canvas || !node) return;
  if (generation && generationCapabilityFor(node.kind) === null) return;

  const data = node.data as { generation?: GenerationSpec };
  const next = { ...data } as Record<string, unknown>;
  if (generation === null) delete next.generation;
  else next.generation = generation;

  const commands: DocumentCommand[] = [];
  if (!asksTheSame(data.generation ?? null, generation)) {
    commands.push({
      type: "updateNode",
      canvasId,
      nodeId,
      patch: { data: next as NodeData },
    });
  }
  if (bounds) commands.push({ type: "resizeNode", canvasId, nodeId, bounds });
  if (commands.length === 0) return;

  execute(generation ? "Edit generation" : "Clear generation", commands);
}

interface HeldResults {
  resultSlots?: ResultSlot[];
  resultNodeIds?: NodeId[];
}

function resultsOf(node: WorkflowNode): ResultSlot[] {
  return (node.data as HeldResults).resultSlots ?? [];
}

/** Whether a result has anything in it to be shown. */
function answered(slot: ResultSlot): boolean {
  return slot.status === "succeeded";
}

/**
 * Whether two slots hold one answer: the same asset, or — where neither has one —
 * the same words. A card made for one answer of a batch holds its own copy of it,
 * and that is the only way back to the slot the batch kept for it.
 */
function sameAnswer(one: ResultSlot, other: ResultSlot): boolean {
  if (one.assetId !== undefined || other.assetId !== undefined) {
    return one.assetId === other.assetId;
  }
  return one.text !== undefined && one.text === other.text;
}

/**
 * What one answer leaves on the node holding it, mirroring the way a run writes
 * its result back: words are a text node's own content, and an asset is what any
 * other kind of node points at.
 */
function holdAnswer(
  data: Record<string, unknown>,
  slot: ResultSlot,
  kind: NodeKind,
) {
  if (kind === "text") {
    if (slot.text !== undefined) data.content = slot.text;
    return;
  }
  if (slot.assetId !== undefined) data.assetId = slot.assetId;
}

/** A result that could be shown as its node's own, and what to call the choice. */
export interface ChoosableResult {
  slotId: string;
  label: string;
}

/**
 * The results this node could show as its own, in the order they were made.
 *
 * Empty wherever there is nothing to choose: a node with one result is showing it
 * already, a result that failed has nothing in it, and a card whose holder is
 * gone — deleted, or never part of the document it arrived in — has nowhere to be
 * chosen for.
 */
export function choosableResults(
  canvas: CanvasDocument,
  node: WorkflowNode,
): ChoosableResult[] {
  const held = resultsOf(node);
  if (held.length > 1) {
    return held.flatMap((slot, index) =>
      slot.isPrimary || !answered(slot)
        ? []
        : [{ slotId: slot.id, label: `Show result ${index + 1}` }],
    );
  }
  // One answer of a batch sits on a card of its own, and the node that asked for
  // the batch is the one whose showing a choice of it changes.
  const own = held[0];
  if (!own || !answered(own)) return [];
  const holder = findHolder(canvas, node, own);
  if (!holder || holder.slot.isPrimary) return [];
  return [
    { slotId: own.id, label: `Show this result on ${holder.node.title}` },
  ];
}

/**
 * Makes one of a node's results the one it shows, in a single undoable step.
 *
 * Which node changes is not always the one asked about: a card made for one
 * answer of a batch holds only its own copy of it, so the choice is read across
 * to the node holding the batch, and it is that node that ends up showing the
 * answer and saying which of its results is the primary one.
 */
export function chooseResult(nodeId: NodeId, slotId: string) {
  const canvas = activeCanvas();
  const acted = canvas ? findNode(canvas, nodeId) : undefined;
  if (!canvas || !acted) return;
  const asked = resultsOf(acted).find((slot) => slot.id === slotId);
  if (!asked || !answered(asked)) return;

  const holder =
    resultsOf(acted).length > 1
      ? { node: acted, slot: asked }
      : findHolder(canvas, acted, asked);
  if (!holder || holder.slot.isPrimary) return;

  const data = { ...(holder.node.data as Record<string, unknown>) };
  holdAnswer(data, holder.slot, holder.node.kind);
  const slots = resultsOf(holder.node);
  data.resultSlots = slots.map((slot) => ({
    ...slot,
    isPrimary: slot.id === holder.slot.id,
  }));
  execute("Show this result", [
    {
      type: "updateNode",
      canvasId: canvas.id,
      nodeId: holder.node.id,
      patch: { data: data as NodeData },
    },
  ]);
  const index = slots.findIndex((slot) => slot.id === holder.slot.id);
  announce(`Showing result ${index + 1} of ${slots.length}`);
}

/** The node holding a batch, and the slot in it that one of its cards carries. */
function findHolder(
  canvas: CanvasDocument,
  card: WorkflowNode,
  own: ResultSlot,
): { node: WorkflowNode; slot: ResultSlot } | null {
  for (const holder of canvas.nodes) {
    if (!(holder.data as HeldResults).resultNodeIds?.includes(card.id))
      continue;
    const match = resultsOf(holder).find((slot) => sameAnswer(slot, own));
    if (match) return { node: holder, slot: match };
  }
  return null;
}

export function fitViewAction() {
  const canvas = activeCanvas();
  if (!canvas || canvas.nodes.length === 0) return;
  fitBounds(unionBounds(canvas.nodes.map((node) => node.bounds)));
}

export function fitSelectionAction() {
  const canvas = activeCanvas();
  if (!canvas) return;
  const selection = useEditorStore.getState().selection;
  const nodes = selection.nodeIds
    .map((nodeId) => findNode(canvas, nodeId))
    .filter((node): node is WorkflowNode => Boolean(node));
  if (nodes.length === 0) {
    fitViewAction();
    return;
  }
  fitBounds(unionBounds(nodes.map((node) => node.bounds)));
}

function unionBounds(rects: Rect[]): Rect {
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  return {
    x: minX,
    y: minY,
    width: Math.max(...rects.map((r) => r.x + r.width)) - minX,
    height: Math.max(...rects.map((r) => r.y + r.height)) - minY,
  };
}

function pointWithin(point: Point, bounds: Rect, pad: number): boolean {
  return (
    point.x >= bounds.x - pad &&
    point.x <= bounds.x + bounds.width + pad &&
    point.y >= bounds.y - pad &&
    point.y <= bounds.y + bounds.height + pad
  );
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Atomic position commit at the end of a node drag. Group membership updates
 * ride along: a moved node's center landing inside a group frame joins it, a
 * member dragged out past the detach threshold leaves it.
 */
export function moveNodes(positions: Record<NodeId, Point>) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const movedIds = Object.keys(positions);
  if (movedIds.length === 0) return;
  const commands: DocumentCommand[] = [
    { type: "moveNodes", canvasId: canvas.id, positions },
  ];
  const movedSet = new Set(movedIds);
  const centerOf = (nodeId: NodeId): Point | null => {
    const node = findNode(canvas, nodeId);
    const pos = positions[nodeId];
    if (!node || !pos) return null;
    return {
      x: pos.x + node.bounds.width / 2,
      y: pos.y + node.bounds.height / 2,
    };
  };
  for (const membership of canvas.groups) {
    const groupNode = findNode(canvas, membership.groupId);
    if (!groupNode) continue;
    // When the group itself moved, measure against its new frame.
    const groupPos = positions[groupNode.id];
    const groupBounds: Rect = groupPos
      ? { ...groupNode.bounds, x: groupPos.x, y: groupPos.y }
      : groupNode.bounds;
    let members = membership.childNodeIds;
    for (const nodeId of membership.childNodeIds) {
      const center = centerOf(nodeId);
      if (
        center &&
        !pointWithin(center, groupBounds, GROUP_DETACH_THRESHOLD_PX)
      ) {
        members = members.filter((id) => id !== nodeId);
      }
    }
    if (!movedSet.has(membership.groupId)) {
      for (const nodeId of movedIds) {
        if (members.includes(nodeId)) continue;
        const node = findNode(canvas, nodeId);
        if (!node || node.kind === "group") continue;
        const center = centerOf(nodeId);
        if (
          center &&
          pointWithin(center, groupBounds, -GROUP_DETACH_THRESHOLD_PX)
        ) {
          members = [...members, nodeId];
        }
      }
    }
    if (members !== membership.childNodeIds) {
      commands.push({
        type: "setGroupMembership",
        canvasId: canvas.id,
        groupId: membership.groupId,
        childNodeIds: members,
      });
    }
  }
  if (execute("Move nodes", commands)) {
    announce(
      `Moved ${movedIds.length} node${movedIds.length === 1 ? "" : "s"}`,
    );
  }
}

export function resizeNodeTo(nodeId: NodeId, bounds: Rect) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const node = findNode(canvas, nodeId);
  if (!node) return;
  const current = node.bounds;
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  ) {
    return;
  }
  if (
    execute("Resize node", [
      { type: "resizeNode", canvasId: canvas.id, nodeId, bounds },
    ])
  ) {
    announce(`Resized ${node.title}`);
  }
}

/** Marquee commit: intersect (not contain) semantics, additive keeps the baseline. */
export function marqueeSelect(bounds: Rect, additive: boolean) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const hit = canvas.nodes
    .filter((node) => rectsIntersect(node.bounds, bounds))
    .map((node) => node.id);
  const editor = useEditorStore.getState();
  const nodeIds = additive
    ? [...new Set([...editor.selection.nodeIds, ...hit])]
    : hit;
  editor.setSelection({ nodeIds, edgeIds: [] });
  announceSelection(canvas);
}

/** Store-side validation for a pending connection preview. */
export function checkConnection(
  source: PortRef,
  target: PortRef,
): ConnectionCheck {
  const canvas = activeCanvas();
  if (!canvas) return "invalid";
  const result = validateEdgeCandidate(canvas, source, target);
  if (result.ok) return "ok";
  return result.code === "CARDINALITY_VIOLATION" ? "replace" : "invalid";
}

/**
 * Direct upstream/downstream neighbors of the hovered or single-selected
 * node. Transient interaction state; null when nothing should dim.
 */
export function relatedHighlight(): {
  nodeIds: NodeId[];
  edgeIds: EdgeId[];
} | null {
  const canvas = activeCanvas();
  if (!canvas) return null;
  const editor = useEditorStore.getState();
  const focus =
    editor.hoveredNodeId ??
    (editor.selection.nodeIds.length === 1 &&
    editor.selection.edgeIds.length === 0
      ? editor.selection.nodeIds[0]
      : null);
  if (!focus) return null;
  const roots = new Set(expandWithGroupMembers(canvas, [focus]));
  const nodeIds = new Set<NodeId>(roots);
  const edgeIds: EdgeId[] = [];
  for (const edge of canvas.edges) {
    if (roots.has(edge.source.nodeId) || roots.has(edge.target.nodeId)) {
      edgeIds.push(edge.id);
      nodeIds.add(edge.source.nodeId);
      nodeIds.add(edge.target.nodeId);
    }
  }
  if (edgeIds.length === 0) return null;
  return { nodeIds: [...nodeIds], edgeIds };
}

export { GROUP_DETACH_THRESHOLD_PX };
