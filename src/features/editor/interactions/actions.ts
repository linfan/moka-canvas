import {
  CASCADE_DROP_OFFSET,
  GROUP_DETACH_THRESHOLD_PX,
  createNode,
  findNode,
  newId,
  nowIso,
  portTypesIntersect,
  validateEdgeCandidate,
  type CanvasDocument,
  type DocumentCommand,
  type EdgeId,
  type NodeId,
  type NodeKind,
  type Point,
  type Rect,
  type WorkflowNode,
} from "../../../shared/domain";
import { assetsApi } from "../../../api";
import { useAppStore } from "../stores/appStore";
import {
  useEditorStore,
  type PortRef,
  type Selection,
} from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
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
import type { ConnectionCheck } from "../canvas/controller";

function toastError(message: string) {
  useAppStore.getState().pushToast("error", message);
}

function announce(message: string) {
  useEditorStore.getState().announce(message);
}

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

export function addNodeAt(
  world: Point,
  kind: NodeKind,
  connectFrom: PortRef | null,
  textContent?: string,
) {
  const canvas = activeCanvas();
  if (!canvas) return;
  const node = createNode(kind, { x: world.x - 140, y: world.y - 40 });
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
  if (execute(connected ? "Add connected node" : "Add node", commands)) {
    useEditorStore.getState().selectOnly(node.id);
    announce(`Added ${node.title}${connected ? " (connected)" : ""}`);
  }
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
