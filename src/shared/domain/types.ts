import type {
  AssetCategory,
  AssetOrigin,
  Capability,
  ProblemCode,
} from "./constants";

export type ProjectId = string;
export type CanvasId = string;
export type NodeId = string;
export type EdgeId = string;
export type AssetId = string;
export type RunId = string;
export type SessionId = string;
export type MessageId = string;
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
  /**
   * What a reader says about the asset, so the shelf can be searched by it.
   *
   * All of it came in without a schema version of its own: an entry stored
   * before these existed leaves them off rather than leaves them empty, so
   * reading such a project and writing it back gives the bytes it arrived with.
   */
  tags?: string[];
  note?: string;
  favorite?: boolean;
  origin?: AssetOrigin;
  /** What it is a picture of, in words: the ask it came from or the text it holds. */
  keyword?: string;
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
  /**
   * The conversation that asked for this, when one did.
   *
   * Like a run, it is a reference only the machine that made it can honour:
   * conversations travel with a full backup and not with a package of the work.
   */
  assistantSessionId?: SessionId;
  inputAssetIds?: AssetId[];
  parameterSnapshot?: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

export type ResourceRegistry = Record<AssetCategory, ResourceEntry[]>;

export type BackgroundMode = "dots" | "lines" | "blank";

export interface DocumentSettings {
  background: BackgroundMode;
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
  /**
   * The conversations had over this canvas.
   *
   * Left off rather than left empty on a document written before conversations
   * existed, so that reading such a document and writing it back gives the bytes
   * it arrived with. It came in without a schema version of its own for the same
   * reason: nothing stored had to change to make room for it.
   */
  sessions?: AssistantSession[];
}

export interface GroupMembership {
  groupId: NodeId;
  childNodeIds: NodeId[];
}

/** Who a line of a conversation is from: the reader, a model, or a failure. */
export type AssistantRole = "user" | "assistant" | "error";

/**
 * A card a line was asked about, as that line remembered it.
 *
 * The title and the kind are kept beside the id because the card may be gone by
 * the time the line is read again, and a line that can say only "a card that no
 * longer exists" tells nobody what was asked about.
 */
export interface AssistantReference {
  nodeId: NodeId;
  title: string;
  kind: NodeKind;
  assetId?: AssetId;
}

/** A run a line set going, noted so the line can say what it started. */
export interface AssistantToolCall {
  runId: RunId;
  nodeId?: NodeId;
  summary: string;
}

/** Why a line that failed failed, and whether asking again could work. */
export interface AssistantFailure {
  code: ProblemCode;
  retryable: boolean;
}

export interface AssistantMessage {
  id: MessageId;
  role: AssistantRole;
  text: string;
  createdAt: IsoTimestamp;
  references?: AssistantReference[];
  toolCalls?: AssistantToolCall[];
  failure?: AssistantFailure;
}

/**
 * One conversation about one canvas, carried by the canvas itself.
 *
 * A canvas holds its own and never another's: what was asked about the cards on
 * this board belongs to this board, so opening a document opens onto the
 * conversations that were had over it.
 */
export interface AssistantSession {
  id: SessionId;
  title: string;
  messages: AssistantMessage[];
  createdAt: IsoTimestamp;
  /**
   * When something was last said, which is how the newest conversation is found.
   *
   * Only ever moves forward: taking a line back does not put this back with it,
   * since a conversation just taken back out of is still the one to open onto.
   */
  updatedAt: IsoTimestamp;
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
  /**
   * A change to how the canvas itself is shown. Only what is named moves, so a
   * caller changing the background leaves the minimap preference where it was.
   */
  | {
      type: "setCanvasSettings";
      canvasId: CanvasId;
      settings: Partial<DocumentSettings>;
    }
  /**
   * A canvas's conversations. Lines are added and taken away rather than the
   * list rewritten, so a turn carries only what it said: a conversation is kept
   * to a length that can be read through, and sending the whole of one across
   * for every line would cost more than the line.
   */
  | {
      type: "addSession";
      canvasId: CanvasId;
      session: AssistantSession;
      index?: number;
    }
  | {
      type: "renameSession";
      canvasId: CanvasId;
      sessionId: SessionId;
      title: string;
    }
  | { type: "removeSession"; canvasId: CanvasId; sessionId: SessionId }
  /**
   * `at` is where the lines land in the list as it stands when the command is
   * applied, and is the tail when left off. It exists for the undo of a
   * conversation that had to let its oldest lines go to make room.
   */
  | {
      type: "appendMessages";
      canvasId: CanvasId;
      sessionId: SessionId;
      messages: AssistantMessage[];
      at?: number;
    }
  | {
      type: "removeMessages";
      canvasId: CanvasId;
      sessionId: SessionId;
      messageIds: MessageId[];
    }
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
  /**
   * The conversation that asked for this, when a conversation did.
   *
   * What the assets this run files are traced back to, which is why the record
   * holds it: a card made on somebody's behalf has to be told whose.
   */
  assistantSessionId?: SessionId;
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
