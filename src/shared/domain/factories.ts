import { newId, nowIso } from "./ids";
import {
  CANVAS_SCHEMA_VERSION,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  MOKA_FILE_VERSION,
  NODE_PORTS,
} from "./constants";
import type { Capability } from "./constants";
import type {
  CanvasDocument,
  GenerationSpec,
  MokaFile,
  NodeKind,
  PortDefinition,
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
