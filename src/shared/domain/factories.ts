import { newId, nowIso } from "./ids";
import {
  CANVAS_SCHEMA_VERSION,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  MOKA_FILE_VERSION,
} from "./constants";
import type {
  CanvasDocument,
  DataType,
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

export function port(
  id: string,
  direction: "input" | "output",
  dataTypes: DataType[],
  label: string,
  options?: { required?: boolean; cardinality?: "one" | "many" },
): PortDefinition {
  return {
    id,
    direction,
    dataTypes,
    required: options?.required ?? false,
    cardinality: options?.cardinality ?? "one",
    label,
  };
}

const NODE_PORTS: Record<NodeKind, PortDefinition[]> = {
  text: [port("out", "output", ["text"], "Text")],
  image: [port("out", "output", ["image"], "Image")],
  audio: [port("out", "output", ["audio"], "Audio")],
  video: [port("out", "output", ["video"], "Video")],
  operation: [
    port("text", "input", ["text"], "Text", { cardinality: "many" }),
    port("images", "input", ["image"], "Images", { cardinality: "many" }),
    port("audio", "input", ["audio"], "Audio"),
    port("video", "input", ["video"], "Video"),
    port("out", "output", ["text", "image", "audio", "video"], "Result", {
      cardinality: "many",
    }),
  ],
  group: [],
  export: [
    port("video", "input", ["video"], "Video"),
    port("audio", "input", ["audio"], "Audio"),
    port("out", "output", ["artifact"], "Artifact"),
  ],
};

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

export function createNode(
  kind: NodeKind,
  at: { x: number; y: number },
  options?: { title?: string; width?: number; height?: number },
): WorkflowNode {
  const now = nowIso();
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
    ports: NODE_PORTS[kind].map((p) => ({ ...p, dataTypes: [...p.dataTypes] })),
    data: defaultDataForKind(kind),
    createdAt: now,
    updatedAt: now,
  };
}
