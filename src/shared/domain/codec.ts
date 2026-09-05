import { Double, Long, deserialize, serialize } from "bson";
import {
  MOKA_FILE_VERSION,
  MOKA_MAGIC,
  PROJECT_ASSET_CATEGORIES,
} from "./constants";
import type {
  CanvasDocument,
  GroupMembership,
  MokaFile,
  NodeData,
  ProjectMetadata,
  ResourceEntry,
  ResultSlot,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import { validateResourcePath } from "./validate";

export class MokaCodecError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MokaCodecError";
  }
}

function asDouble(value: number): Double {
  return new Double(value);
}

function asLong(value: number): Long {
  return Long.fromNumber(value);
}

function unwrapNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (value instanceof Long) return value.toNumber();
  if (value instanceof Double) return value.valueOf();
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return undefined;
}

function encodeViewport(viewport: { x: number; y: number; zoom: number }) {
  return {
    x: asDouble(viewport.x),
    y: asDouble(viewport.y),
    zoom: asDouble(viewport.zoom),
  };
}

function encodeBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    x: asDouble(bounds.x),
    y: asDouble(bounds.y),
    width: asDouble(bounds.width),
    height: asDouble(bounds.height),
  };
}

function encodeResultSlot(slot: ResultSlot): Record<string, unknown> {
  const doc: Record<string, unknown> = { id: slot.id, status: slot.status };
  if (slot.assetId !== undefined) doc.assetId = slot.assetId;
  if (slot.text !== undefined) doc.text = slot.text;
  if (slot.error !== undefined) doc.error = slot.error;
  doc.isPrimary = slot.isPrimary;
  return doc;
}

function encodeNodeData(kind: string, data: NodeData): Record<string, unknown> {
  const record = data as Record<string, unknown>;
  const doc: Record<string, unknown> = {};
  const put = (key: string) => {
    if (record[key] !== undefined) doc[key] = record[key];
  };
  switch (kind) {
    case "text":
      put("content");
      put("style");
      put("assetId");
      break;
    case "image":
    case "audio":
    case "video":
      put("assetId");
      put("posterAssetId");
      put("audioCategory");
      break;
    case "operation":
      put("operationType");
      put("parameters");
      put("executorKey");
      break;
    case "group":
      put("color");
      put("childNodeIds");
      break;
    case "export":
      put("format");
      put("parameters");
      break;
  }
  if (record.resultSlots !== undefined) {
    doc.resultSlots = (record.resultSlots as ResultSlot[]).map(
      encodeResultSlot,
    );
  }
  if (record.resultNodeIds !== undefined)
    doc.resultNodeIds = record.resultNodeIds;
  if (record.metadata !== undefined) doc.metadata = record.metadata;
  return doc;
}

function encodeNode(node: WorkflowNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    bounds: encodeBounds(node.bounds),
    zIndex: node.zIndex,
    ports: node.ports.map((port) => ({
      id: port.id,
      direction: port.direction,
      dataTypes: [...port.dataTypes],
      required: port.required,
      cardinality: port.cardinality,
      label: port.label,
    })),
    data: encodeNodeData(node.kind, node.data),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function encodeEdge(edge: WorkflowEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: { nodeId: edge.source.nodeId, portId: edge.source.portId },
    target: { nodeId: edge.target.nodeId, portId: edge.target.portId },
    createdAt: edge.createdAt,
  };
}

function encodeGroup(group: GroupMembership): Record<string, unknown> {
  return { groupId: group.groupId, childNodeIds: [...group.childNodeIds] };
}

function encodeCanvas(canvas: CanvasDocument): Record<string, unknown> {
  return {
    id: canvas.id,
    name: canvas.name,
    schemaVersion: canvas.schemaVersion,
    viewport: encodeViewport(canvas.viewport),
    nodes: canvas.nodes.map(encodeNode),
    edges: canvas.edges.map(encodeEdge),
    groups: canvas.groups.map(encodeGroup),
    settings: {
      background: canvas.settings.background,
      showMinimap: canvas.settings.showMinimap,
      snapToGrid: canvas.settings.snapToGrid,
    },
  };
}

function encodeProbe(
  probe: ResourceEntry["probe"],
): Record<string, unknown> | undefined {
  if (!probe) return undefined;
  const doc: Record<string, unknown> = {
    mime: probe.mime,
    bytes: asLong(probe.bytes),
    sha256: probe.sha256,
  };
  if (probe.width !== undefined) doc.width = probe.width;
  if (probe.height !== undefined) doc.height = probe.height;
  if (probe.durationMs !== undefined) doc.durationMs = asLong(probe.durationMs);
  if (probe.sampleRate !== undefined) doc.sampleRate = probe.sampleRate;
  if (probe.channels !== undefined) doc.channels = probe.channels;
  if (probe.codecSummary !== undefined) doc.codecSummary = probe.codecSummary;
  if (probe.posterAssetId !== undefined)
    doc.posterAssetId = probe.posterAssetId;
  return doc;
}

function encodeProvenance(
  provenance: ResourceEntry["provenance"],
): Record<string, unknown> | undefined {
  if (!provenance) return undefined;
  const doc: Record<string, unknown> = {};
  if (provenance.runId !== undefined) doc.runId = provenance.runId;
  if (provenance.canvasId !== undefined) doc.canvasId = provenance.canvasId;
  if (provenance.operationNodeId !== undefined)
    doc.operationNodeId = provenance.operationNodeId;
  if (provenance.inputAssetIds !== undefined)
    doc.inputAssetIds = [...provenance.inputAssetIds];
  if (provenance.parameterSnapshot !== undefined)
    doc.parameterSnapshot = provenance.parameterSnapshot;
  doc.createdAt = provenance.createdAt;
  return doc;
}

function encodeResource(entry: ResourceEntry): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: entry.id,
    name: entry.name,
    path: entry.path,
  };
  if (entry.mime !== undefined) doc.mime = entry.mime;
  if (entry.bytes !== undefined) doc.bytes = asLong(entry.bytes);
  if (entry.sha256 !== undefined) doc.sha256 = entry.sha256;
  doc.createdAt = entry.createdAt;
  doc.updatedAt = entry.updatedAt;
  const probe = encodeProbe(entry.probe);
  if (probe) doc.probe = probe;
  const provenance = encodeProvenance(entry.provenance);
  if (provenance) doc.provenance = provenance;
  return doc;
}

function encodeMetadata(metadata: ProjectMetadata): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    id: metadata.id,
    name: metadata.name,
  };
  if (metadata.description !== undefined)
    doc.description = metadata.description;
  if (metadata.coverPath !== undefined) doc.coverPath = metadata.coverPath;
  doc.revision = metadata.revision;
  doc.createdAt = metadata.createdAt;
  doc.updatedAt = metadata.updatedAt;
  return doc;
}

export function encodeMokaFile(moka: MokaFile, maxBytes?: number): Uint8Array {
  const doc = {
    version: moka.version,
    metadata: encodeMetadata(moka.metadata),
    resources: Object.fromEntries(
      PROJECT_ASSET_CATEGORIES.map((category) => [
        category,
        (moka.resources[category] ?? []).map(encodeResource),
      ]),
    ),
    canvas: moka.canvas.map(encodeCanvas),
  };
  const bson = serialize(doc);
  const bytes = new Uint8Array(4 + bson.length);
  bytes.set(MOKA_MAGIC, 0);
  bytes.set(bson, 4);
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    throw new MokaCodecError(
      "MOKA_TOO_LARGE",
      `canvas.moka would be ${bytes.length} bytes, exceeding the ${maxBytes} byte limit`,
    );
  }
  return bytes;
}

function requireField<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka is missing required field "${name}"`,
    );
  }
  return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  const field = requireField(value, name);
  if (typeof field !== "object" || Array.isArray(field)) {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka field "${name}" has the wrong shape`,
    );
  }
  return field as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  const field = requireField(value, name);
  if (!Array.isArray(field)) {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka field "${name}" has the wrong shape`,
    );
  }
  return field;
}

function asString(value: unknown, name: string): string {
  const field = requireField(value, name);
  if (typeof field !== "string") {
    throw new MokaCodecError(
      "MOKA_FIELD_MISSING",
      `canvas.moka field "${name}" has the wrong shape`,
    );
  }
  return field;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decodeViewport(value: unknown): {
  x: number;
  y: number;
  zoom: number;
} {
  const doc = asRecord(value, "viewport");
  return {
    x: requireField(unwrapNumber(doc.x), "viewport.x"),
    y: requireField(unwrapNumber(doc.y), "viewport.y"),
    zoom: requireField(unwrapNumber(doc.zoom), "viewport.zoom"),
  };
}

function decodeBounds(value: unknown) {
  const doc = asRecord(value, "bounds");
  return {
    x: requireField(unwrapNumber(doc.x), "bounds.x"),
    y: requireField(unwrapNumber(doc.y), "bounds.y"),
    width: requireField(unwrapNumber(doc.width), "bounds.width"),
    height: requireField(unwrapNumber(doc.height), "bounds.height"),
  };
}

function decodeLongField(value: unknown): number | undefined {
  const unwrapped = unwrapNumber(value);
  return unwrapped === undefined ? undefined : Math.trunc(unwrapped);
}

function decodeProbe(value: unknown): ResourceEntry["probe"] {
  if (value === undefined || value === null) return undefined;
  const doc = asRecord(value, "probe");
  return {
    mime: asString(doc.mime, "probe.mime"),
    bytes: requireField(decodeLongField(doc.bytes), "probe.bytes"),
    sha256: asString(doc.sha256, "probe.sha256"),
    width: decodeLongField(doc.width),
    height: decodeLongField(doc.height),
    durationMs: decodeLongField(doc.durationMs),
    sampleRate: decodeLongField(doc.sampleRate),
    channels: decodeLongField(doc.channels),
    codecSummary: optionalString(doc.codecSummary),
    posterAssetId: optionalString(doc.posterAssetId),
  };
}

function decodeProvenance(value: unknown): ResourceEntry["provenance"] {
  if (value === undefined || value === null) return undefined;
  const doc = asRecord(value, "provenance");
  return {
    runId: optionalString(doc.runId),
    canvasId: optionalString(doc.canvasId),
    operationNodeId: optionalString(doc.operationNodeId),
    inputAssetIds: Array.isArray(doc.inputAssetIds)
      ? (doc.inputAssetIds as string[])
      : undefined,
    parameterSnapshot:
      typeof doc.parameterSnapshot === "object" &&
      doc.parameterSnapshot !== null
        ? (doc.parameterSnapshot as Record<string, unknown>)
        : undefined,
    createdAt: asString(doc.createdAt, "provenance.createdAt"),
  };
}

function decodeResource(value: unknown): ResourceEntry {
  const doc = asRecord(value, "resources[]");
  const path = asString(doc.path, "resources[].path");
  if (!validateResourcePath(path)) {
    throw new MokaCodecError(
      "PATH_ESCAPE",
      `Resource path escapes the project root: ${path}`,
    );
  }
  const entry: ResourceEntry = {
    id: asString(doc.id, "resources[].id"),
    name: asString(doc.name, "resources[].name"),
    path,
    mime: optionalString(doc.mime),
    bytes: decodeLongField(doc.bytes),
    sha256: optionalString(doc.sha256),
    createdAt: asString(doc.createdAt, "resources[].createdAt"),
    updatedAt: asString(doc.updatedAt, "resources[].updatedAt"),
    probe: decodeProbe(doc.probe),
    provenance: decodeProvenance(doc.provenance),
  };
  return entry;
}

function decodeNode(value: unknown): WorkflowNode {
  const doc = asRecord(value, "nodes[]");
  return {
    id: asString(doc.id, "nodes[].id"),
    kind: asString(doc.kind, "nodes[].kind") as WorkflowNode["kind"],
    title: asString(doc.title, "nodes[].title"),
    bounds: decodeBounds(doc.bounds),
    zIndex: Math.trunc(
      requireField(unwrapNumber(doc.zIndex), "nodes[].zIndex"),
    ),
    ports: asArray(doc.ports, "nodes[].ports").map((port) => {
      const record = asRecord(port, "ports[]");
      return {
        id: asString(record.id, "ports[].id"),
        direction: asString(record.direction, "ports[].direction") as
          "input" | "output",
        dataTypes: asArray(record.dataTypes, "ports[].dataTypes") as never,
        required: Boolean(record.required),
        cardinality: asString(record.cardinality, "ports[].cardinality") as
          "one" | "many",
        label: asString(record.label, "ports[].label"),
      };
    }),
    data: asRecord(doc.data, "nodes[].data") as never,
    createdAt: asString(doc.createdAt, "nodes[].createdAt"),
    updatedAt: asString(doc.updatedAt, "nodes[].updatedAt"),
  };
}

function decodeEdge(value: unknown): WorkflowEdge {
  const doc = asRecord(value, "edges[]");
  const source = asRecord(doc.source, "edges[].source");
  const target = asRecord(doc.target, "edges[].target");
  return {
    id: asString(doc.id, "edges[].id"),
    source: {
      nodeId: asString(source.nodeId, "edges[].source.nodeId"),
      portId: asString(source.portId, "edges[].source.portId"),
    },
    target: {
      nodeId: asString(target.nodeId, "edges[].target.nodeId"),
      portId: asString(target.portId, "edges[].target.portId"),
    },
    createdAt: asString(doc.createdAt, "edges[].createdAt"),
  };
}

function decodeCanvas(value: unknown): CanvasDocument {
  const doc = asRecord(value, "canvas[]");
  const settings = asRecord(doc.settings, "canvas[].settings");
  return {
    id: asString(doc.id, "canvas[].id"),
    name: asString(doc.name, "canvas[].name"),
    schemaVersion: Math.trunc(
      requireField(unwrapNumber(doc.schemaVersion), "canvas[].schemaVersion"),
    ),
    viewport: decodeViewport(doc.viewport),
    nodes: asArray(doc.nodes, "canvas[].nodes").map(decodeNode),
    edges: asArray(doc.edges, "canvas[].edges").map(decodeEdge),
    groups: asArray(doc.groups, "canvas[].groups").map((group) => {
      const record = asRecord(group, "groups[]");
      return {
        groupId: asString(record.groupId, "groups[].groupId"),
        childNodeIds: asArray(
          record.childNodeIds,
          "groups[].childNodeIds",
        ) as string[],
      };
    }),
    settings: {
      background: asString(settings.background, "settings.background") as
        "dots" | "lines" | "blank",
      showMinimap: Boolean(settings.showMinimap),
      snapToGrid: Boolean(settings.snapToGrid),
    },
  };
}

export function decodeMokaFile(bytes: Uint8Array): MokaFile {
  if (bytes.length < 5) {
    throw new MokaCodecError(
      "MOKA_BSON_INVALID",
      "canvas.moka is too small to be valid",
    );
  }
  for (let i = 0; i < 4; i += 1) {
    if (bytes[i] !== MOKA_MAGIC[i]) {
      throw new MokaCodecError(
        "MOKA_MAGIC_INVALID",
        "canvas.moka does not start with the MOKA magic bytes",
      );
    }
  }
  let doc: Record<string, unknown>;
  try {
    doc = deserialize(bytes.subarray(4)) as Record<string, unknown>;
  } catch (error) {
    throw new MokaCodecError(
      "MOKA_BSON_INVALID",
      `canvas.moka contains invalid BSON: ${(error as Error).message}`,
    );
  }

  const version = asString(doc.version, "version");
  if (version !== MOKA_FILE_VERSION) {
    throw new MokaCodecError(
      "MOKA_VERSION_UNSUPPORTED",
      `canvas.moka version "${version}" is not supported (expected "v1")`,
    );
  }

  const metadataDoc = asRecord(doc.metadata, "metadata");
  const metadata: ProjectMetadata = {
    id: asString(metadataDoc.id, "metadata.id"),
    name: asString(metadataDoc.name, "metadata.name"),
    description: optionalString(metadataDoc.description),
    coverPath: optionalString(metadataDoc.coverPath),
    revision: Math.trunc(
      requireField(unwrapNumber(metadataDoc.revision), "metadata.revision"),
    ),
    createdAt: asString(metadataDoc.createdAt, "metadata.createdAt"),
    updatedAt: asString(metadataDoc.updatedAt, "metadata.updatedAt"),
  };

  const resourcesDoc = asRecord(doc.resources, "resources");
  const resources = Object.fromEntries(
    PROJECT_ASSET_CATEGORIES.map((category) => [
      category,
      asArray(resourcesDoc[category] ?? [], `resources.${category}`).map(
        decodeResource,
      ),
    ]),
  ) as MokaFile["resources"];

  const canvas = asArray(doc.canvas, "canvas").map(decodeCanvas);

  return { version: MOKA_FILE_VERSION, metadata, resources, canvas };
}
