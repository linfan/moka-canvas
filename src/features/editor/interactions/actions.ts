import {
  CASCADE_DROP_OFFSET,
  GROUP_DETACH_THRESHOLD_PX,
  MAX_TEXT_CONTENT_LENGTH,
  createNode,
  findNode,
  generationCapabilityFor,
  newId,
  nowIso,
  portTypesIntersect,
  validateEdgeCandidate,
  type AssetId,
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
  type WorkflowNode,
} from "../../../shared/domain";
import { assetsApi, assetUrl } from "../../../api";
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
import { buildResourceIndex } from "../canvas/mediaCards";
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
 * holds. The anchor is where the node is wanted, before the offset every new
 * node is placed by.
 */
async function makeAssetNode(
  assetId: AssetId,
  anchor: Point,
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
  const node = createNode(kind, { x: anchor.x - 140, y: anchor.y - 40 });
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
  const node = await makeAssetNode(assetId, anchor);
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
 */
export async function addAssetBeside(
  targetNodeId: NodeId,
  assetId: AssetId,
): Promise<NodeId | null> {
  const canvas = activeCanvas();
  const target = canvas ? findNode(canvas, targetNodeId) : null;
  if (!canvas || !target) return null;
  const node = await makeAssetNode(assetId, {
    x: target.bounds.x - 120,
    y: target.bounds.y + 40,
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
