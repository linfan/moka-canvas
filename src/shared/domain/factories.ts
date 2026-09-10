import { newId, nowIso } from "./ids";
import {
  CANVAS_SCHEMA_VERSION,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MOKA_FILE_VERSION,
  NODE_PORTS,
  PROVIDER_EXECUTOR_KEY,
} from "./constants";
import type { Capability } from "./constants";
import type {
  AssistantSession,
  CanvasDocument,
  GenerationInputMode,
  GenerationMode,
  GenerationSpec,
  MokaFile,
  NodeId,
  NodeKind,
  PortDefinition,
  Rect,
  ResourceRegistry,
  WorkflowNode,
} from "./types";

export function emptyResources(): ResourceRegistry {
  return { images: [], music: [], voice: [], texts: [], videos: [] };
}

export function createCanvas(name: string): CanvasDocument {
  return {
    id: newId(),
    name,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    groups: [],
    settings: { background: "dots", showMinimap: true, snapToGrid: true },
  };
}

export function createSession(title: string): AssistantSession {
  const now = nowIso();
  return { id: newId(), title, messages: [], createdAt: now, updatedAt: now };
}

export function createProject(name: string): MokaFile {
  const now = nowIso();
  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: newId(),
      name,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    },
    resources: emptyResources(),
    canvas: [createCanvas("Canvas 1")],
  };
}

export function derivePorts(kind: NodeKind): PortDefinition[] {
  return NODE_PORTS[kind].map((p) => ({ ...p, dataTypes: [...p.dataTypes] }));
}

/**
 * Ports are derived data: the table wins for every port it knows, and
 * stored ports the table does not list are kept verbatim after it.
 */
export function reconcilePorts(
  kind: NodeKind,
  stored: PortDefinition[],
): PortDefinition[] {
  const derived = derivePorts(kind);
  const known = new Set(derived.map((p) => p.id));
  const extras = stored
    .filter((p) => !known.has(p.id))
    .map((p) => ({ ...p, dataTypes: [...p.dataTypes] }));
  return [...derived, ...extras];
}

const NODE_TITLES: Record<NodeKind, string> = {
  text: "Text",
  image: "Image",
  audio: "Audio",
  video: "Video",
  operation: "Operation",
  group: "Group",
  export: "Export",
};

export function defaultDataForKind(kind: NodeKind): WorkflowNode["data"] {
  switch (kind) {
    case "text":
      return { content: "" };
    case "image":
    case "video":
      return {};
    case "audio":
      return { audioCategory: "music" };
    case "operation":
      return {
        operationType: "deterministic.text",
        parameters: {},
        executorKey: "deterministic",
        resultSlots: [],
        resultNodeIds: [],
      };
    case "group":
      return { color: "#3b82f6", childNodeIds: [] };
    case "export":
      return { format: "mp4", parameters: {} };
  }
}

export function generationCapabilityFor(kind: NodeKind): Capability | null {
  return kind === "operation" || kind === "group" || kind === "export"
    ? null
    : kind;
}

export function defaultGenerationSpec(kind: NodeKind): GenerationSpec | null {
  const capability = generationCapabilityFor(kind);
  if (!capability) return null;
  return {
    capability,
    mode: "generate",
    model: "",
    prompt: "",
    inputMode: "upstream",
    params: {},
    referenceNodeIds: [],
    updatedAt: nowIso(),
  };
}

/**
 * The bounds a node takes when it is asked for a shape, around the centre it
 * already has.
 *
 * The width is kept and the height follows it, so a node asked for a shape
 * stays where it was put across the canvas. A shape too wide to leave the node
 * as short as a node may be widens it instead: the ask has to be drawable, and
 * a rectangle below the smallest size would be refused by the document.
 */
export function boundsForShape(bounds: Rect, shape: string): Rect | null {
  const ratio = proportionOf(shape);
  if (!ratio) return null;
  let width = bounds.width;
  let height = Math.round(width / ratio);
  if (height < MIN_NODE_HEIGHT) {
    height = MIN_NODE_HEIGHT;
    width = Math.round(height * ratio);
  }
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    width,
    height,
  };
}

/**
 * The width over the height a shape states, or null when it states none.
 *
 * Both ways of stating one are read: a proportion is what a node is asked for,
 * and a size in pixels is what a provider answers with, and the shape of an
 * answer is the shape of the ask.
 */
function proportionOf(shape: string): number | null {
  const sides = shape.trim().toLowerCase().split(/[:x]/);
  if (sides.length !== 2) return null;
  const width = Number(sides[0]);
  const height = Number(sides[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return width / height;
}

/**
 * The executor a node's step would be handed to, or null when a run could do
 * nothing with it.
 *
 * The server answers this from the same rule. Asking it here too is what keeps
 * a Run button from being offered for a node the server would only refuse.
 */
export function executorKeyForNode(node: WorkflowNode): string | null {
  const data = node.data as {
    executorKey?: string;
    generation?: GenerationSpec;
  };
  switch (node.kind) {
    case "operation":
      return data.executorKey ?? "";
    case "text":
    case "image":
    case "audio":
    case "video":
      return data.generation ? PROVIDER_EXECUTOR_KEY : null;
    default:
      return null;
  }
}

const GENERATION_MODES: readonly GenerationMode[] = [
  "generate",
  "edit",
  "extend",
  "question",
];

const GENERATION_INPUT_MODES: readonly GenerationInputMode[] = [
  "upstream",
  "manual",
  "mentions",
];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  or: T,
): T {
  return allowed.includes(value as T) ? (value as T) : or;
}

function words(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifiers(value: unknown): NodeId[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is NodeId => typeof entry === "string")
    : [];
}

/**
 * The spec a snapshot says was asked for, or null when it does not describe one
 * for this kind of node.
 *
 * A snapshot comes out of a document, which another version may have written or
 * a hand may have edited, so what it says is read rather than cast: a spec
 * carrying a capability that is not one would sit on the node looking sound and
 * only be refused once a run reached it. Asking again is then the snapshot whole
 * plus a fresh timestamp, since a snapshot records what to ask for and not when
 * it was asked for.
 */
export function generationSpecFromSnapshot(
  snapshot: Record<string, unknown> | undefined,
  kind: NodeKind,
): GenerationSpec | null {
  const capability = generationCapabilityFor(kind);
  if (!capability || !snapshot || snapshot.capability !== capability)
    return null;
  if (typeof snapshot.prompt !== "string") return null;
  return {
    capability,
    mode: oneOf(snapshot.mode, GENERATION_MODES, "generate"),
    model: typeof snapshot.model === "string" ? snapshot.model : "",
    prompt: snapshot.prompt,
    inputMode: oneOf(snapshot.inputMode, GENERATION_INPUT_MODES, "upstream"),
    params: words(snapshot.params),
    referenceNodeIds: identifiers(snapshot.referenceNodeIds),
    updatedAt: nowIso(),
  };
}

export function createNode(
  kind: NodeKind,
  at: { x: number; y: number },
  options?: {
    title?: string;
    width?: number;
    height?: number;
    generate?: boolean;
  },
): WorkflowNode {
  const now = nowIso();
  const data = defaultDataForKind(kind);
  if (options?.generate) {
    const spec = defaultGenerationSpec(kind);
    if (spec) (data as { generation?: GenerationSpec }).generation = spec;
  }
  return {
    id: newId(),
    kind,
    title: options?.title ?? NODE_TITLES[kind],
    bounds: {
      x: at.x,
      y: at.y,
      width: options?.width ?? DEFAULT_NODE_WIDTH,
      height: options?.height ?? DEFAULT_NODE_HEIGHT,
    },
    zIndex: 0,
    ports: derivePorts(kind),
    data,
    createdAt: now,
    updatedAt: now,
  };
}
