import {
  ASSET_ORIGINS,
  COORDINATE_LIMIT,
  GENERATION_PARAM_KEYS,
  MAX_ASSET_KEYWORD_LENGTH,
  MAX_ASSET_NOTE_LENGTH,
  MAX_ASSET_TAG_LENGTH,
  MAX_ASSET_TAGS,
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_SESSIONS_PER_CANVAS,
  MAX_EDGES_PER_CANVAS,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  MAX_FOLDERS_PER_PROJECT,
  MAX_NODES_PER_CANVAS,
  MAX_PROMPT_LENGTH,
  MAX_RESULT_SLOTS,
  PROJECT_ASSET_CATEGORIES,
} from "./constants";
import type {
  CanvasDocument,
  DataType,
  EdgeEndpoint,
  GenerationSpec,
  MokaFile,
  NodeId,
  PortDefinition,
  ProjectRelativePath,
  Rect,
  ResourceEntry,
  ResultSlot,
  ValidationIssue,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import { folderDepth, foldersOf } from "./folders";
import { validateTimeline } from "./timeline";

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateBounds(bounds: Rect): boolean {
  return (
    isFiniteNumber(bounds.x) &&
    isFiniteNumber(bounds.y) &&
    isFiniteNumber(bounds.width) &&
    isFiniteNumber(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    Math.abs(bounds.x) <= COORDINATE_LIMIT &&
    Math.abs(bounds.y) <= COORDINATE_LIMIT &&
    bounds.width <= COORDINATE_LIMIT * 2 &&
    bounds.height <= COORDINATE_LIMIT * 2
  );
}

export function validateResourcePath(path: ProjectRelativePath): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\\") || path.includes("	")) return false;
  if (path.startsWith("/")) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

export function portTypesIntersect(
  a: DataType[],
  b: DataType[],
): DataType | undefined {
  return a.find((t) => b.includes(t));
}

export function findNode(
  canvas: CanvasDocument,
  nodeId: NodeId,
): WorkflowNode | undefined {
  return canvas.nodes.find((n) => n.id === nodeId);
}

export function findPort(
  node: WorkflowNode,
  portId: string,
): PortDefinition | undefined {
  return node.ports.find((p) => p.id === portId);
}

export function wouldCreateCycle(
  edges: WorkflowEdge[],
  candidate: { source: EdgeEndpoint; target: EdgeEndpoint },
): boolean {
  const adjacency = new Map<NodeId, NodeId[]>();
  const addEdge = (from: NodeId, to: NodeId) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of edges) addEdge(edge.source.nodeId, edge.target.nodeId);
  addEdge(candidate.source.nodeId, candidate.target.nodeId);

  const stack: NodeId[] = [candidate.target.nodeId];
  const visited = new Set<NodeId>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === candidate.source.nodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

export type EdgeCandidateResult =
  { ok: true } | { ok: false; code: string; message: string };

export function validateEdgeCandidate(
  canvas: CanvasDocument,
  source: EdgeEndpoint,
  target: EdgeEndpoint,
): EdgeCandidateResult {
  const sourceNode = findNode(canvas, source.nodeId);
  if (!sourceNode)
    return {
      ok: false,
      code: "NODE_NOT_FOUND",
      message: "Source node missing",
    };
  const targetNode = findNode(canvas, target.nodeId);
  if (!targetNode)
    return {
      ok: false,
      code: "NODE_NOT_FOUND",
      message: "Target node missing",
    };

  const sourcePort = findPort(sourceNode, source.portId);
  if (!sourcePort)
    return {
      ok: false,
      code: "PORT_NOT_FOUND",
      message: "Source port missing",
    };
  const targetPort = findPort(targetNode, target.portId);
  if (!targetPort)
    return {
      ok: false,
      code: "PORT_NOT_FOUND",
      message: "Target port missing",
    };

  if (sourcePort.direction !== "output" || targetPort.direction !== "input") {
    return {
      ok: false,
      code: "PORT_TYPE_MISMATCH",
      message: "Edges must run from an output port to an input port",
    };
  }

  if (source.nodeId === target.nodeId) {
    return {
      ok: false,
      code: "SELF_LOOP",
      message: "A node cannot connect to itself",
    };
  }

  if (!portTypesIntersect(sourcePort.dataTypes, targetPort.dataTypes)) {
    return {
      ok: false,
      code: "PORT_TYPE_MISMATCH",
      message: `Port types are incompatible (${sourcePort.dataTypes.join("/")} → ${targetPort.dataTypes.join("/")})`,
    };
  }

  if (targetPort.cardinality === "one") {
    const incoming = canvas.edges.filter(
      (e) =>
        e.target.nodeId === target.nodeId && e.target.portId === target.portId,
    );
    if (incoming.length > 0) {
      return {
        ok: false,
        code: "CARDINALITY_VIOLATION",
        message:
          "This input accepts a single connection; replace it explicitly",
      };
    }
  }

  if (
    canvas.edges.some(
      (e) =>
        e.source.nodeId === source.nodeId &&
        e.source.portId === source.portId &&
        e.target.nodeId === target.nodeId &&
        e.target.portId === target.portId,
    )
  ) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "This connection already exists",
    };
  }

  if (wouldCreateCycle(canvas.edges, { source, target })) {
    return {
      ok: false,
      code: "GRAPH_CYCLE",
      message: "This connection would create a cycle",
    };
  }

  return { ok: true };
}

export function topologicalOrder(canvas: CanvasDocument): WorkflowNode[] {
  const indegree = new Map<NodeId, number>();
  const outgoing = new Map<NodeId, NodeId[]>();
  for (const node of canvas.nodes) indegree.set(node.id, 0);
  for (const edge of canvas.edges) {
    if (!indegree.has(edge.source.nodeId) || !indegree.has(edge.target.nodeId))
      continue;
    indegree.set(
      edge.target.nodeId,
      (indegree.get(edge.target.nodeId) ?? 0) + 1,
    );
    const list = outgoing.get(edge.source.nodeId);
    if (list) list.push(edge.target.nodeId);
    else outgoing.set(edge.source.nodeId, [edge.target.nodeId]);
  }

  const byRank = (a: WorkflowNode, b: WorkflowNode) =>
    a.zIndex - b.zIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const nodeById = new Map(canvas.nodes.map((n) => [n.id, n]));
  let frontier = canvas.nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .sort(byRank);
  const ordered: WorkflowNode[] = [];
  while (frontier.length > 0) {
    const nextFrontier: WorkflowNode[] = [];
    for (const node of frontier) {
      ordered.push(node);
      for (const targetId of outgoing.get(node.id) ?? []) {
        const remaining = (indegree.get(targetId) ?? 0) - 1;
        indegree.set(targetId, remaining);
        if (remaining === 0) nextFrontier.push(nodeById.get(targetId)!);
      }
    }
    frontier = nextFrontier.sort(byRank);
  }
  return ordered;
}

/**
 * What points at each asset, as a list of the cards and clips that do.
 *
 * Both halves of a document hold assets — a canvas node shows one, a timeline
 * clip reads one — so the two are collected together: whether an asset is
 * still in use is a question about the project, not about one board.
 */
export function collectAssetReferences(moka: MokaFile): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const add = (assetId: string | undefined, holderId: string) => {
    if (!assetId) return;
    const list = refs.get(assetId);
    if (list) list.push(holderId);
    else refs.set(assetId, [holderId]);
  };
  for (const canvas of moka.canvas) {
    for (const node of canvas.nodes) {
      const data = node.data as Record<string, unknown>;
      add(data.assetId as string | undefined, node.id);
      add(data.posterAssetId as string | undefined, node.id);
      const slots = data.resultSlots as { assetId?: string }[] | undefined;
      if (Array.isArray(slots)) {
        for (const slot of slots) add(slot.assetId, node.id);
      }
    }
  }
  for (const timeline of moka.timelines ?? []) {
    for (const clip of timeline.clips) add(clip.assetId, clip.id);
  }
  return refs;
}

export function allResources(moka: MokaFile): ResourceEntry[] {
  return PROJECT_ASSET_CATEGORIES.flatMap(
    (category) => moka.resources[category] ?? [],
  );
}

/**
 * The assets nothing on any canvas points at.
 *
 * A package asked to carry only what is placed leaves these behind, so the
 * question has to be able to say how many and how much room they take before
 * it is answered rather than after.
 */
export function unreferencedAssets(moka: MokaFile): ResourceEntry[] {
  const placed = collectAssetReferences(moka);
  return allResources(moka).filter((entry) => !placed.has(entry.id));
}

export function findResource(
  moka: MokaFile,
  assetId: string,
): ResourceEntry | undefined {
  return allResources(moka).find((r) => r.id === assetId);
}

/** The opening of a mention, and the whole of the token it starts. */
const MENTION_PREFIX = "@[node:";

export interface MentionSpan {
  start: number;
  end: number;
  nodeId: string;
}

/**
 * Every `@[node:<id>]` mention in a prompt, in the order they appear, with the
 * span the whole token occupies so a caller can replace exactly that much and
 * leave the prose around it alone.
 *
 * A token with no closing bracket ends the scan: what follows is prose that
 * happens to contain the opening, not a reference. A token naming nothing
 * (`@[node:]`) is still a token, and what to make of it is the caller's
 * business.
 */
export function mentionSpans(prompt: string): MentionSpan[] {
  const found: MentionSpan[] = [];
  let cursor = 0;
  for (;;) {
    const start = prompt.indexOf(MENTION_PREFIX, cursor);
    if (start < 0) break;
    const body = start + MENTION_PREFIX.length;
    const close = prompt.indexOf("]", body);
    if (close < 0) break;
    found.push({ start, end: close + 1, nodeId: prompt.slice(body, close) });
    cursor = close + 1;
  }
  return found;
}

export function mentionNodeIds(prompt: string): string[] {
  return mentionSpans(prompt)
    .map((span) => span.nodeId)
    .filter((nodeId) => nodeId !== "");
}

/**
 * True when `model` is shaped like a model configuration identifier: one
 * piece, no whitespace, and no legacy "channelId::modelId" separator — the
 * halves of an old reference name nothing now, so a document carrying one is
 * from before model configurations replaced channels.
 */
export function modelIdentifierShaped(model: string): boolean {
  return model !== "" && !model.includes("::") && !/\s/.test(model);
}

function generationIssues(
  canvas: CanvasDocument,
  node: WorkflowNode,
  nodeIds: Set<NodeId>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (code: string, message: string) => {
    issues.push({ code, message, canvasId: canvas.id, nodeId: node.id });
  };

  const data = node.data as {
    generation?: GenerationSpec;
    resultSlots?: ResultSlot[];
  };
  if ((data.resultSlots?.length ?? 0) > MAX_RESULT_SLOTS) {
    at(
      "RESULT_SLOT_LIMIT",
      `Node "${node.title}" exceeds the result slot limit (${MAX_RESULT_SLOTS})`,
    );
  }

  const spec = data.generation;
  if (!spec) return issues;

  if (spec.capability !== node.kind) {
    at(
      "GENERATION_CAPABILITY_MISMATCH",
      `Generation capability "${spec.capability}" does not match node kind "${node.kind}"`,
    );
  }
  if (spec.model !== "" && !modelIdentifierShaped(spec.model)) {
    at(
      "GENERATION_MODEL_MISSING",
      `Generation model "${spec.model}" is not a model configuration identifier`,
    );
  }
  if (spec.prompt.length > MAX_PROMPT_LENGTH) {
    at(
      "VALIDATION_FAILED",
      `Generation prompt exceeds the ${MAX_PROMPT_LENGTH} character limit`,
    );
  }

  const hasPromptEdge = canvas.edges.some(
    (edge) => edge.target.nodeId === node.id && edge.target.portId === "prompt",
  );
  if (
    spec.prompt.trim() === "" &&
    !hasPromptEdge &&
    spec.referenceNodeIds.length === 0
  ) {
    at(
      "GENERATION_PROMPT_EMPTY",
      `Node "${node.title}" has no prompt, no upstream prompt connection, and no references`,
    );
  }

  for (const id of mentionNodeIds(spec.prompt)) {
    if (id === node.id) {
      at("MENTION_SELF_REFERENCE", "Prompt mentions its own node");
    } else if (!nodeIds.has(id)) {
      at("MENTION_NODE_NOT_FOUND", `Prompt mentions missing node ${id}`);
    }
  }

  const allowed = GENERATION_PARAM_KEYS[spec.capability];
  if (allowed) {
    for (const key of Object.keys(spec.params)) {
      if (!allowed.includes(key)) {
        at(
          "VALIDATION_FAILED",
          `Unknown parameter "${key}" for ${spec.capability} generation`,
        );
      }
    }
  }

  return issues;
}

/**
 * What is wrong with the conversations a canvas carries.
 *
 * A line naming a card that has since been deleted is not among them. The line
 * kept that card's title and kind for exactly this case, so what it says is
 * still what was asked about; only the card is gone, and saying so is the
 * reader's job rather than a fault in the document.
 */
function sessionIssues(canvas: CanvasDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const canvasId = canvas.id;
  const sessions = canvas.sessions ?? [];
  if (sessions.length > MAX_ASSISTANT_SESSIONS_PER_CANVAS) {
    issues.push({
      code: "VALIDATION_FAILED",
      message: `Canvas exceeds the session limit (${MAX_ASSISTANT_SESSIONS_PER_CANVAS})`,
      canvasId,
    });
  }
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: `Duplicate session id ${session.id}`,
        canvasId,
      });
    }
    seen.add(session.id);
    if (session.messages.length > MAX_ASSISTANT_MESSAGES_PER_SESSION) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: `Session "${session.title}" exceeds the message limit (${MAX_ASSISTANT_MESSAGES_PER_SESSION})`,
        canvasId,
      });
    }
  }
  return issues;
}

export function validateCanvas(canvas: CanvasDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const canvasId = canvas.id;

  if (canvas.nodes.length > MAX_NODES_PER_CANVAS) {
    issues.push({
      code: "VALIDATION_FAILED",
      message: `Canvas exceeds the node limit (${MAX_NODES_PER_CANVAS})`,
      canvasId,
    });
  }
  if (canvas.edges.length > MAX_EDGES_PER_CANVAS) {
    issues.push({
      code: "VALIDATION_FAILED",
      message: `Canvas exceeds the edge limit (${MAX_EDGES_PER_CANVAS})`,
      canvasId,
    });
  }
  issues.push(...sessionIssues(canvas));

  const nodeIds = new Set<string>();
  for (const node of canvas.nodes) {
    if (nodeIds.has(node.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: `Duplicate node id ${node.id}`,
        canvasId,
        nodeId: node.id,
      });
    }
    nodeIds.add(node.id);
    if (!validateBounds(node.bounds)) {
      issues.push({
        code: "BOUNDS_INVALID",
        message: `Node "${node.title}" has invalid bounds`,
        canvasId,
        nodeId: node.id,
      });
    }
    const portIds = new Set<string>();
    for (const port of node.ports) {
      if (portIds.has(port.id)) {
        issues.push({
          code: "VALIDATION_FAILED",
          message: `Duplicate port id ${port.id} on node "${node.title}"`,
          canvasId,
          nodeId: node.id,
          portId: port.id,
        });
      }
      portIds.add(port.id);
    }
  }

  for (const node of canvas.nodes) {
    issues.push(...generationIssues(canvas, node, nodeIds));
  }

  const edgeIds = new Set<string>();
  for (const edge of canvas.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: `Duplicate edge id ${edge.id}`,
        canvasId,
        edgeId: edge.id,
      });
    }
    edgeIds.add(edge.id);
    const remaining = canvas.edges.filter((e) => e.id !== edge.id);
    const scopedCanvas = { ...canvas, edges: remaining };
    const result = validateEdgeCandidate(
      scopedCanvas,
      edge.source,
      edge.target,
    );
    if (!result.ok) {
      issues.push({
        code: result.code,
        message: result.message,
        canvasId,
        edgeId: edge.id,
        nodeId: edge.target.nodeId,
        portId: edge.target.portId,
      });
    }
  }

  const groupOf = new Map<NodeId, NodeId>();
  for (const group of canvas.groups) {
    const groupNode = findNode(canvas, group.groupId);
    if (!groupNode || groupNode.kind !== "group") {
      issues.push({
        code: "GROUP_INVALID",
        message: "Membership references a missing or non-group node",
        canvasId,
        nodeId: group.groupId,
      });
      continue;
    }
    const seen = new Set<NodeId>();
    for (const childId of group.childNodeIds) {
      if (childId === group.groupId) {
        issues.push({
          code: "GROUP_INVALID",
          message: "A group cannot contain itself",
          canvasId,
          nodeId: group.groupId,
        });
      }
      if (seen.has(childId)) {
        issues.push({
          code: "GROUP_INVALID",
          message: "Group membership contains a duplicate node",
          canvasId,
          nodeId: childId,
        });
      }
      seen.add(childId);
      if (!nodeIds.has(childId)) {
        issues.push({
          code: "GROUP_INVALID",
          message: "Group membership references a missing node",
          canvasId,
          nodeId: childId,
        });
      }
      if (groupOf.has(childId)) {
        issues.push({
          code: "GROUP_INVALID",
          message: "A node belongs to more than one group",
          canvasId,
          nodeId: childId,
        });
      }
      groupOf.set(childId, group.groupId);
    }
    if (group.childNodeIds.length < 2) {
      issues.push({
        code: "GROUP_INVALID",
        message: "A group requires at least two member nodes",
        canvasId,
        nodeId: group.groupId,
      });
    }
  }

  return issues;
}

/**
 * What a reader says about an asset, held to its sizes and its vocabulary.
 *
 * These are the only registry fields written by hand, so a document out of the
 * wild can carry an asset too tagged to read through, or an origin nothing here
 * recognises.
 */
function shelfIssues(entry: ResourceEntry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const say = (message: string) =>
    issues.push({ code: "VALIDATION_FAILED", message });
  if (entry.tags) {
    if (entry.tags.length > MAX_ASSET_TAGS) {
      say(
        `Asset "${entry.name}" carries more tags than the ${MAX_ASSET_TAGS} allowed`,
      );
    }
    if (entry.tags.some((tag) => tag.length > MAX_ASSET_TAG_LENGTH)) {
      say(
        `Asset "${entry.name}" carries a tag over ${MAX_ASSET_TAG_LENGTH} characters`,
      );
    }
  }
  if (entry.note && entry.note.length > MAX_ASSET_NOTE_LENGTH) {
    say(`Asset "${entry.name}" carries a note over ${MAX_ASSET_NOTE_LENGTH}`);
  }
  if (entry.keyword && entry.keyword.length > MAX_ASSET_KEYWORD_LENGTH) {
    say(
      `Asset "${entry.name}" carries a summary over ${MAX_ASSET_KEYWORD_LENGTH}`,
    );
  }
  if (entry.origin !== undefined && !ASSET_ORIGINS.includes(entry.origin)) {
    say(
      `Asset "${entry.name}" says an origin nothing recognises: ${entry.origin}`,
    );
  }
  return issues;
}

/**
 * What is wrong with the canvas tree.
 *
 * A folder naming a parent that is not there is a fault in the document rather
 * than an empty drawer: the boards under it would sit somewhere no tree can
 * show, so it is said outright instead of being quietly read as a folder at the
 * project root. A name that leads round in a circle is a fault for the same
 * reason, and is named as one rather than reported as too deep.
 */
function folderIssues(moka: MokaFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const say = (message: string) =>
    issues.push({ code: "VALIDATION_FAILED", message });
  const folders = foldersOf(moka);
  if (folders.length > MAX_FOLDERS_PER_PROJECT) {
    say(`Project exceeds the folder limit (${MAX_FOLDERS_PER_PROJECT})`);
  }
  const ids = new Set(folders.map((folder) => folder.id));
  if (ids.size !== folders.length) say("Duplicate folder id");
  for (const folder of folders) {
    if (folder.name.length === 0) say(`Folder ${folder.id} has no name`);
    if (folder.name.length > MAX_FOLDER_NAME_LENGTH) {
      say(
        `Folder "${folder.name}" has a name over ${MAX_FOLDER_NAME_LENGTH} characters`,
      );
    }
    if (folder.parentId !== undefined && !ids.has(folder.parentId)) {
      say(`Folder "${folder.name}" sits in a folder that is not there`);
      continue;
    }
    if (holdsItself(moka, folder.id)) {
      say(`Folder "${folder.name}" is inside itself`);
      continue;
    }
    if (folderDepth(moka, folder.id) > MAX_FOLDER_DEPTH) {
      say(
        `Folder "${folder.name}" sits deeper than the ${MAX_FOLDER_DEPTH} levels allowed`,
      );
    }
  }
  for (const canvas of moka.canvas) {
    if (canvas.folderId !== undefined && !ids.has(canvas.folderId)) {
      issues.push({
        code: "FOLDER_NOT_FOUND",
        message: `Canvas "${canvas.name}" sits in a folder that is not there`,
        canvasId: canvas.id,
      });
    }
  }
  return issues;
}

/** Whether walking up from a folder leads back to it. */
function holdsItself(moka: MokaFile, folderId: string): boolean {
  const seen = new Set<string>();
  let current = foldersOf(moka).find((folder) => folder.id === folderId);
  while (current?.parentId !== undefined) {
    if (seen.has(current.parentId)) return true;
    seen.add(current.parentId);
    const parentId = current.parentId;
    current = foldersOf(moka).find((folder) => folder.id === parentId);
  }
  return false;
}

export function validateMokaFile(moka: MokaFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...folderIssues(moka));
  const canvasIds = new Set<string>();
  for (const canvas of moka.canvas) {
    if (canvasIds.has(canvas.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: `Duplicate canvas id ${canvas.id}`,
        canvasId: canvas.id,
      });
    }
    canvasIds.add(canvas.id);
    issues.push(...validateCanvas(canvas));
  }

  const resourceIds = new Set<string>();
  for (const entry of allResources(moka)) {
    if (resourceIds.has(entry.id)) {
      issues.push({
        code: "VALIDATION_FAILED",
        message: `Duplicate resource id ${entry.id}`,
      });
    }
    resourceIds.add(entry.id);
    if (!validateResourcePath(entry.path)) {
      issues.push({
        code: "PATH_ESCAPE",
        message: `Resource path escapes the project root: ${entry.path}`,
      });
    }
    issues.push(...shelfIssues(entry));
  }

  for (const timeline of moka.timelines ?? []) {
    issues.push(...validateTimeline(timeline, moka));
  }

  const refs = collectAssetReferences(moka);
  for (const assetId of refs.keys()) {
    if (!resourceIds.has(assetId)) {
      issues.push({
        code: "ASSET_MISSING",
        message: `Something in the project references unregistered asset ${assetId}`,
      });
    }
  }
  return issues;
}
