import type { AssetCategory, Capability } from "./constants";

export type ProjectId = string;
export type CanvasId = string;
export type NodeId = string;
export type EdgeId = string;
export type AssetId = string;
export type RunId = string;
export type IsoTimestamp = string;
export type ProjectRelativePath = string;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProjectMetadata {
  id: ProjectId;
  name: string;
  description?: string;
  coverPath?: ProjectRelativePath;
  revision: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ResourceEntry {
  id: AssetId;
  name: string;
  path: ProjectRelativePath;
  mime?: string;
  bytes?: number;
  sha256?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  probe?: AssetProbe;
  provenance?: AssetProvenance;
}

export interface AssetProbe {
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  codecSummary?: string;
  posterAssetId?: AssetId;
}

export interface AssetProvenance {
  runId?: RunId;
  canvasId?: CanvasId;
  operationNodeId?: NodeId;
  inputAssetIds?: AssetId[];
  parameterSnapshot?: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

export type ResourceRegistry = Record<AssetCategory, ResourceEntry[]>;

export interface DocumentSettings {
  background: "dots" | "lines" | "blank";
  showMinimap: boolean;
  snapToGrid: boolean;
}

export interface CanvasDocument {
  id: CanvasId;
  name: string;
  schemaVersion: number;
  viewport: Viewport;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: GroupMembership[];
  settings: DocumentSettings;
}

export interface GroupMembership {
  groupId: NodeId;
  childNodeIds: NodeId[];
}

export type NodeKind =
  "text" | "image" | "audio" | "video" | "operation" | "group" | "export";

export type DataType =
  "text" | "image" | "audio" | "video" | "timeline" | "artifact";

export interface PortDefinition {
  id: string;
  direction: "input" | "output";
  dataTypes: DataType[];
  required: boolean;
  cardinality: "one" | "many";
  label: string;
}

export interface ResultSlot {
  id: string;
  status: "empty" | "pending" | "succeeded" | "failed";
  assetId?: AssetId;
  text?: string;
  error?: string;
  isPrimary: boolean;
}

export type GenerationMode = "generate" | "edit" | "extend" | "question";

export type GenerationInputMode = "upstream" | "manual" | "mentions";

/**
 * What a node asks a provider to make. Absent on nodes created before the
 * generation features and on nodes the user never configured.
 */
export interface GenerationSpec {
  capability: Capability;
  mode: GenerationMode;
  /** "channelId::modelId"; empty means fall back to the provider defaults. */
  model: string;
  prompt: string;
  inputMode: GenerationInputMode;
  params: Record<string, unknown>;
  referenceNodeIds: NodeId[];
  updatedAt: IsoTimestamp;
}

export interface TextNodeStyle {
  fontSize?: number;
  align?: "left" | "center" | "right";
}

export interface TextNodeData {
  content: string;
  style?: TextNodeStyle;
  assetId?: AssetId;
  resultSlots?: ResultSlot[];
  generation?: GenerationSpec;
}

export interface MediaNodeData {
  assetId?: AssetId;
  posterAssetId?: AssetId;
  audioCategory?: "music" | "voice";
  resultSlots?: ResultSlot[];
  /**
   * Child nodes holding the results past the first, when one generation asked
   * for several. This node keeps the primary result itself.
   */
  resultNodeIds?: NodeId[];
  metadata?: Record<string, unknown>;
  generation?: GenerationSpec;
}

export interface OperationNodeData {
  operationType: string;
  parameters: Record<string, unknown>;
  executorKey: string;
  resultSlots?: ResultSlot[];
  resultNodeIds?: NodeId[];
}

export interface GroupNodeData {
  color: string;
  childNodeIds: NodeId[];
}

export interface ExportNodeData {
  format: string;
  parameters: Record<string, unknown>;
}

export type NodeData =
  | TextNodeData
  | MediaNodeData
  | OperationNodeData
  | GroupNodeData
  | ExportNodeData;

export interface WorkflowNode {
  id: NodeId;
  kind: NodeKind;
  title: string;
  bounds: Rect;
  zIndex: number;
  ports: PortDefinition[];
  data: NodeData;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface EdgeEndpoint {
  nodeId: NodeId;
  portId: string;
}

export interface WorkflowEdge {
  id: EdgeId;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  createdAt: IsoTimestamp;
}

export interface MokaFile {
  version: "v1";
  metadata: ProjectMetadata;
  resources: ResourceRegistry;
  canvas: CanvasDocument[];
}

export interface NodePatch {
  title?: string;
  zIndex?: number;
  data?: NodeData;
}

export type DocumentCommand =
  | { type: "addNode"; canvasId: CanvasId; node: WorkflowNode }
  | {
      type: "updateNode";
      canvasId: CanvasId;
      nodeId: NodeId;
      patch: NodePatch;
    }
  | {
      type: "moveNodes";
      canvasId: CanvasId;
      positions: Record<NodeId, Point>;
    }
  | { type: "resizeNode"; canvasId: CanvasId; nodeId: NodeId; bounds: Rect }
  | { type: "removeNodes"; canvasId: CanvasId; nodeIds: NodeId[] }
  | { type: "addEdge"; canvasId: CanvasId; edge: WorkflowEdge }
  | { type: "removeEdges"; canvasId: CanvasId; edgeIds: EdgeId[] }
  | {
      type: "setGroupMembership";
      canvasId: CanvasId;
      groupId: NodeId;
      childNodeIds: NodeId[];
    }
  | { type: "setViewport"; canvasId: CanvasId; viewport: Viewport }
  | { type: "addCanvas"; canvas: CanvasDocument; index?: number }
  | { type: "renameCanvas"; canvasId: CanvasId; name: string }
  | { type: "reorderCanvas"; canvasId: CanvasId; index: number }
  | { type: "removeCanvas"; canvasId: CanvasId };

export interface SelfCheckIssue {
  assetId: AssetId;
  name: string;
  expectedPath: ProjectRelativePath;
  reason: "missing" | "changed" | "empty";
  referencingNodes: { canvasId: CanvasId; nodeId: NodeId; title: string }[];
}

export interface SelfCheckReport {
  ok: boolean;
  issues: SelfCheckIssue[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  canvasId?: CanvasId;
  nodeId?: NodeId;
  portId?: string;
  edgeId?: EdgeId;
}

export type RunStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface RunStepRecord {
  nodeId: NodeId;
  status: RunStatus;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  error?: string;
  outputAssetIds?: AssetId[];
  outputText?: string;
  /**
   * The handle a step that runs as an upstream job is polled by. This process
   * issued it, so it names no provider.
   */
  taskId?: string;
  taskCreatedAt?: IsoTimestamp;
  /** 0 to 1. Absent means nobody reported one, which is not the same as 0. */
  progress?: number;
}

export interface RunRecord {
  id: RunId;
  projectId: ProjectId;
  canvasId: CanvasId;
  requestedNodeIds: NodeId[];
  status: RunStatus;
  executorKey: string;
  graphHash: string;
  parameters: Record<string, unknown>;
  retryOfRunId?: RunId;
  steps: RunStepRecord[];
  error?: string;
  cancelRequested: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type WorkflowValue =
  | { type: "text"; text: string; source: ValueProvenance }
  | {
      type: "image" | "audio" | "video";
      assetId: AssetId;
      source: ValueProvenance;
    }
  | {
      type: "artifact";
      assetId: AssetId;
      mediaType?: DataType;
      source: ValueProvenance;
    };

export interface ValueProvenance {
  nodeId: NodeId;
  portId: string;
}
