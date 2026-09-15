import type {
  AssetCategory,
  AssetOrigin,
  Capability,
  ClipFilterPreset,
  ProblemCode,
  TransitionKind,
} from "./constants";

export type ProjectId = string;
export type CanvasId = string;
export type FolderId = string;
export type NodeId = string;
export type EdgeId = string;
export type AssetId = string;
export type RunId = string;
export type SessionId = string;
export type MessageId = string;
export type TimelineId = string;
export type TrackId = string;
export type ClipId = string;
export type TransitionId = string;
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

/**
 * A directory in the project's canvas tree.
 *
 * Folders hold canvases and other folders, and hold nothing else: they are a
 * way of arranging the boards a project has rather than a container of its
 * own, so a folder carries no nodes and no assets. The parent is left off
 * rather than named for a folder at the project root, which is what a document
 * written before folders existed says about every canvas in it.
 */
export interface CanvasFolder {
  id: FolderId;
  name: string;
  /** The folder holding this one; absent means the project root. */
  parentId?: FolderId;
  createdAt: IsoTimestamp;
}

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
  /**
   * The folder this canvas sits in, when it sits in one.
   *
   * Left off rather than named for a canvas at the project root, so a document
   * written before folders existed is read and written back as the bytes it
   * arrived with. It came in without a schema version of its own for the same
   * reason as the conversations beside it.
   */
  folderId?: FolderId;
}

export interface GroupMembership {
  groupId: NodeId;
  childNodeIds: NodeId[];
}

// ---------------------------------------------------------------------------
// The cutting room: one project's timelines
// ---------------------------------------------------------------------------

/** What a track holds, which is also what a clip of that kind may land on. */
export type TrackKind = "video" | "audio" | "text";
/** Clip kinds are the same set: a clip is a track's content. */
export type ClipKind = TrackKind;

/**
 * One row of a timeline.
 *
 * The order of the list is the order the rows draw in: an upper video track
 * draws over a lower one, and an audio or text row sits wherever the reader
 * put it. Muting is sound and hiding is picture, and the two say nothing
 * about each other: a hidden track's sound still mixes in, and a muted one's
 * picture still draws. Locking is neither — it only keeps the editor from
 * moving the row's clips, and the document itself holds no rule about it.
 */
export interface TimelineTrack {
  id: TrackId;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  createdAt: IsoTimestamp;
}

/**
 * The visual grade a video clip wears. Absent means untouched.
 *
 * Each axis is a fraction of the range the picture allows, so a quarter is
 * the same intent whatever the exporter or the previewer calls it.
 */
export interface ClipAdjust {
  /** -1..1, darkening to lightening. */
  brightness: number;
  /** -1..1, flatter to punchier. */
  contrast: number;
  /** -1..1, drained to loud. */
  saturation: number;
}

/** How a text clip is written, in pixels on the timeline's own canvas. */
export interface TextClipStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  position: "top" | "center" | "bottom";
  /** #rrggbb, or null for no backing plate. */
  background: string | null;
  /** Outline width in timeline pixels; 0 is no outline. */
  strokeWidth: number;
  /** #rrggbb; always present, harmless at zero width. */
  strokeColor: string;
}

/** What a text clip says and how it is set. */
export interface TextClipData {
  content: string;
  style: TextClipStyle;
}

/**
 * A piece of material placed on a timeline.
 *
 * `startMs` is where it sits and `durationMs` is how long it runs there, so a
 * sped-up clip is shorter on the timeline than the material it reads.
 * `inPointMs`/`outPointMs` are the material's own clock, and the identity
 * `durationMs * speed === outPointMs - inPointMs` holds everywhere: a clip
 * that breaks it is refused rather than played back wrongly. An image or a
 * text clip has no material clock of its own, so its in point is 0 and its
 * out point is its duration.
 */
export interface TimelineClip {
  id: ClipId;
  trackId: TrackId;
  kind: ClipKind;
  /** What the timeline reads on the clip; the asset's name by default. */
  label: string;
  /** The material the clip reads; a text clip names none. */
  assetId?: AssetId;
  startMs: number;
  durationMs: number;
  inPointMs: number;
  outPointMs: number;
  /** 0.25..4, 1 being the material's own pace. */
  speed: number;
  /** 0..2, 1 being the material's own level. Video clips carry audio too. */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  muted: boolean;
  /** Visual grade; absent means the clip is untouched. */
  adjust?: ClipAdjust;
  /** Preset look; absent and "none" mean the same untouched thing. */
  filter?: ClipFilterPreset;
  /** 0..1, for a clip on an upper video track drawing over the one below. */
  opacity: number;
  /** Present exactly on text clips. */
  text?: TextClipData;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/**
 * How two neighbouring clips meet.
 *
 * A transition sits on the seam after `afterClipId`: its window is the tail of
 * that clip and the head of the clip that follows it on the same track, and
 * the two play together through the window. The follower's start is moved
 * back by the window's length when the transition is added, so the overlap
 * is in the document's geometry rather than implied here — and while the
 * record exists, `follower.startMs === leader.endMs − durationMs` is a
 * promise the document holds. It is the one overlap of clips a track may
 * carry; any other overlap is refused.
 */
export interface TimelineTransition {
  id: TransitionId;
  afterClipId: ClipId;
  kind: TransitionKind;
  durationMs: number;
  createdAt: IsoTimestamp;
}

/** The frame the cutting room works at and the colour it cuts to. */
export interface TimelineSettings {
  fps: number;
  width: number;
  height: number;
  background: string;
}

/**
 * One timeline: the tracks, the clips on them, and the transitions on their
 * seams.
 *
 * Clips hold their own `trackId` rather than sitting in per-track lists, so a
 * clip moved between rows is one field's change and the rows are an order the
 * reader chose, not one the document has to keep in two places.
 */
export interface TimelineDocument {
  id: TimelineId;
  name: string;
  schemaVersion: number;
  settings: TimelineSettings;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  transitions: TimelineTransition[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
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
  /** A model configuration id; empty means fall back to the category default. */
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
  /**
   * The directories of the canvas tree, in the order the tree reads them.
   *
   * Left off rather than left empty on a document that has no folders, which is
   * every document written before they existed: a project with a flat list of
   * canvases says so by carrying nothing here.
   */
  folders?: CanvasFolder[];
  /**
   * The project's timelines, in the order the cutting room's tabs read them.
   *
   * Left off rather than left empty on a document that has no timelines,
   * which is every document written before the cutting room existed: a
   * project that has cut nothing says so by carrying nothing here, and an
   * older build reading a newer document skips the field it does not know
   * rather than failing on it.
   */
  timelines?: TimelineDocument[];
  canvas: CanvasDocument[];
}

export interface NodePatch {
  title?: string;
  zIndex?: number;
  data?: NodeData;
}

/**
 * The fields a caller may move on a clip.
 *
 * A field left off is not touched; `adjust: null` is how a grade is cleared,
 * since JSON cannot spell "this key goes away" any other way. Every patch
 * that arrives through the document pipeline is JSON, so the merge rule and
 * the undo rule are one rule: what a patch carries moves, what a patch
 * carries as null goes.
 */
export type ClipPatch = Partial<Omit<TimelineClip, "adjust">> & {
  adjust?: ClipAdjust | null;
};

/** A change to one clip, named by id, for `updateClips`. */
export interface ClipPatchEntry {
  clipId: ClipId;
  patch: ClipPatch;
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
  | { type: "removeCanvas"; canvasId: CanvasId }
  /**
   * The canvas tree.
   *
   * A folder is added whole, its parent named on it rather than beside it, and
   * `index` is the place it takes among that parent's folders. What a canvas
   * sits in is moved by `moveCanvas`, whose `index` is the place it takes among
   * the canvases of the folder it lands in — both are read within their own
   * siblings, since the tree holds folders and canvases as two lists.
   */
  | { type: "addFolder"; folder: CanvasFolder; index?: number }
  | { type: "renameFolder"; folderId: FolderId; name: string }
  | {
      type: "moveFolder";
      folderId: FolderId;
      parentId: FolderId | null;
      index: number;
    }
  /**
   * Takes a folder out of the tree and leaves what it held where a reader can
   * still reach it: its folders and its canvases move up into the folder that
   * held it, at the place it held among its own siblings. Nothing on a canvas
   * is deleted by tidying the tree, so a folder let go of by mistake is one
   * undo from being as it was, boards and all.
   */
  | { type: "removeFolder"; folderId: FolderId }
  | {
      type: "moveCanvas";
      canvasId: CanvasId;
      folderId: FolderId | null;
      index: number;
    }
  // -------------------------------------------------------------------------
  // The cutting room. Every command names the timeline it works on, and none
  // of them reaches into the canvases: the two halves of a document do not
  // borrow each other's geometry.
  // -------------------------------------------------------------------------
  /** A timeline is added whole — its tracks, clips, and transitions included. */
  | { type: "addTimeline"; timeline: TimelineDocument; index?: number }
  | { type: "removeTimeline"; timelineId: TimelineId }
  | { type: "renameTimeline"; timelineId: TimelineId; name: string }
  /**
   * A change to the timeline's own frame: only what is named moves, so a
   * reader changing the frame rate leaves the resolution where it was.
   */
  | {
      type: "updateTimelineSettings";
      timelineId: TimelineId;
      settings: Partial<TimelineSettings>;
    }
  /** A track is added empty; its clips arrive by `addClips` naming it. */
  | {
      type: "addTrack";
      timelineId: TimelineId;
      track: TimelineTrack;
      index?: number;
    }
  /**
   * Takes a track out only when it holds nothing: taking a track and its clips
   * in one go is a deletion the reader did not watch, so the caller is asked to
   * clear the row first.
   */
  | { type: "removeTrack"; timelineId: TimelineId; trackId: TrackId }
  /** Only what is named moves, so renaming a track leaves its mute where it was. */
  | {
      type: "updateTrack";
      timelineId: TimelineId;
      trackId: TrackId;
      patch: Partial<
        Pick<TimelineTrack, "name" | "muted" | "hidden" | "locked">
      >;
    }
  /**
   * Clips land together — a division or a paste arrives as many clips in one
   * step of history, and one seam's transition is taken out with the clip it
   * belongs to by `removeClips`, never by this command.
   *
   * `seams` restores transitions together with the clips they join, in one
   * step: the undo of a removal must not pass through the bare overlap a
   * landed seam would otherwise be. Restored seams are read as already in
   * place — nothing is pulled back — while `addTransitions` is the command
   * that makes a seam, pulling the follower itself.
   */
  | {
      type: "addClips";
      timelineId: TimelineId;
      clips: TimelineClip[];
      seams?: TimelineTransition[];
    }
  | { type: "removeClips"; timelineId: TimelineId; clipIds: ClipId[] }
  /**
   * A change to what a clip is or how it plays. Only the fields the patch
   * carries move, so changing a clip's volume leaves its text alone; a clip
   * whose patch moves or stretches it is re-checked against its neighbours,
   * since two clips cannot hold the same place on a track.
   */
  | {
      type: "updateClips";
      timelineId: TimelineId;
      patches: ClipPatchEntry[];
    }
  /**
   * Only where a clip sits: `startMs` on the timeline's clock and, when the
   * clip is named for a different track, the `trackId` it lands on. A move
   * re-checks against the clips already on the track it lands on.
   */
  | {
      type: "moveClips";
      timelineId: TimelineId;
      moves: { clipId: ClipId; startMs: number; trackId?: TrackId }[];
    }
  /**
   * A transition lands on a seam: the clip it follows must have a neighbour
   * behind it and the two must be butted, and the command pulls the follower
   * back by the window's length itself so the overlap the window plays is
   * the geometry the document then holds. A batch is listed left to right
   * along the track.
   */
  | {
      type: "addTransitions";
      timelineId: TimelineId;
      transitions: TimelineTransition[];
    }
  /**
   * Transitions come off their seams and the followers take their places
   * back. A batch is listed left to right along the track, and seams this
   * batch itself undoes do not count against it; what remains broken — a
   * follower running into the clip behind it, or a seam the release tears
   * out from under another — is refused.
   */
  | {
      type: "removeTransitions";
      timelineId: TimelineId;
      transitionIds: TransitionId[];
    };

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
  timelineId?: TimelineId;
  trackId?: TrackId;
  clipId?: ClipId;
  transitionId?: TransitionId;
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
