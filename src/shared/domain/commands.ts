import {
  BACKGROUND_MODES,
  CANVAS_SCHEMA_VERSION,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_SESSIONS_PER_CANVAS,
  MAX_ASSISTANT_TITLE_LENGTH,
  MAX_CANVAS_NAME_LENGTH,
  MAX_CANVASES_PER_PROJECT,
  MAX_CLIPS_PER_COMMAND,
  MAX_CLIPS_PER_TIMELINE,
  MAX_EDGES_PER_CANVAS,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_NAME_LENGTH,
  MAX_FOLDERS_PER_PROJECT,
  MAX_NODES_PER_CANVAS,
  MAX_TIMELINES_PER_PROJECT,
  MAX_TITLE_LENGTH,
  MAX_TRACKS_PER_TIMELINE,
  MAX_TRANSITIONS_PER_TIMELINE,
  TIMELINE_FPS_CHOICES,
  TIMELINE_HEIGHT_MAX,
  TIMELINE_HEIGHT_MIN,
  TIMELINE_NAME_MAX,
  TIMELINE_WIDTH_MAX,
  TIMELINE_WIDTH_MIN,
  TIMELINE_SCHEMA_VERSION,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./constants";
import type {
  AssistantSession,
  CanvasDocument,
  CanvasFolder,
  DocumentCommand,
  DocumentSettings,
  FolderId,
  MokaFile,
  NodeId,
  TimelineClip,
  TimelineDocument,
  TimelineId,
  TimelineSettings,
  TimelineTrack,
  TrackId,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
import {
  canvasFolderOf,
  canvasSiblingIndex,
  childFolders,
  descendantFolderIds,
  folderById,
  folderCanvases,
  folderDepth,
  folderSiblingIndex,
  foldersOf,
  subtreeDepth,
} from "./folders";
import {
  checkClip,
  checkHexColor,
  checkNoOverlap,
  checkTimeline,
  checkTransitionLanding,
  checkTransitionRestoration,
  followerOf,
  invertClipPatch,
  mergeClipPatch,
  trackAccepts,
  transitionsOfSeams,
} from "./timeline";
import { findNode, validateBounds, validateEdgeCandidate } from "./validate";

export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CommandError";
  }
}

export function emptyCanvas(id: string, name: string): CanvasDocument {
  return {
    id,
    name,
    schemaVersion: CANVAS_SCHEMA_VERSION,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
    groups: [],
    settings: { background: "dots", showMinimap: true, snapToGrid: true },
  };
}

export function nextCanvasName(moka: MokaFile): string {
  const used = new Set(moka.canvas.map((c) => c.name));
  let n = moka.canvas.length + 1;
  while (used.has(`Canvas ${n}`)) n += 1;
  return `Canvas ${n}`;
}

function canvasOf(moka: MokaFile, canvasId: string): CanvasDocument {
  const canvas = moka.canvas.find((c) => c.id === canvasId);
  if (!canvas) throw new CommandError("CANVAS_NOT_FOUND", "Canvas not found");
  return canvas;
}

function replaceCanvas(moka: MokaFile, canvas: CanvasDocument): MokaFile {
  return {
    ...moka,
    canvas: moka.canvas.map((c) => (c.id === canvas.id ? canvas : c)),
  };
}

/**
 * A project carrying these folders, or carrying the field not at all when it
 * has none.
 *
 * A tree emptied of its folders writes what it would have written had nobody
 * ever tidied it, which is the honest reading of it: there is nothing to show
 * and an empty list would claim a drawer was made.
 */
function withFolders(moka: MokaFile, folders: CanvasFolder[]): MokaFile {
  return { ...moka, folders: folders.length > 0 ? folders : undefined };
}

/**
 * Puts `item` into `list` at the place `index` names among `peers`.
 *
 * The two lists a tree is made of are each a slice of one flat list, so a place
 * among siblings has to be turned back into a place in the flat list: before the
 * sibling it was asked to land ahead of, after the last of them when it was
 * asked for the end, and at the end of everything when it has no siblings at
 * all — where among none it lands cannot be seen.
 *
 * `peers` must already exclude the item, which is what a move does first.
 */
function spliceAmong<T>(list: T[], peers: T[], index: number, item: T): T[] {
  const at = Math.min(Math.max(index, 0), peers.length);
  const next = [...list];
  if (at < peers.length) {
    next.splice(next.indexOf(peers[at]), 0, item);
  } else if (peers.length > 0) {
    next.splice(next.indexOf(peers[peers.length - 1]) + 1, 0, item);
  } else {
    next.push(item);
  }
  return next;
}

function folderOf(
  moka: MokaFile,
  folderId: FolderId | null | undefined,
): FolderId | null {
  if (folderId === null || folderId === undefined) return null;
  if (!folderById(moka, folderId)) {
    throw new CommandError("FOLDER_NOT_FOUND", "Folder not found");
  }
  return folderId;
}

function checkFolderName(name: string) {
  if (name.length === 0) {
    throw new CommandError("VALIDATION_FAILED", "Folder name is empty");
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    throw new CommandError("VALIDATION_FAILED", "Folder name is too long");
  }
}

/**
 * Whether a folder put here would take the tree past the depth it is kept to.
 *
 * Measured over the document as it would be, so what the folder carries under
 * it counts as well as the folder itself: a drawer with two levels in it needs
 * two levels of room where it is dropped.
 */
function checkFolderDepth(candidate: MokaFile, folderId: FolderId) {
  const depth =
    folderDepth(candidate, folderId) + subtreeDepth(candidate, folderId) - 1;
  if (depth > MAX_FOLDER_DEPTH) {
    throw new CommandError(
      "VALIDATION_FAILED",
      `Folders nest at most ${MAX_FOLDER_DEPTH} deep`,
    );
  }
}

function sessionOf(
  canvas: CanvasDocument,
  sessionId: string,
): AssistantSession {
  const session = canvas.sessions?.find((s) => s.id === sessionId);
  if (!session)
    throw new CommandError("SESSION_NOT_FOUND", "Session not found");
  return session;
}

/**
 * A canvas carrying these conversations, or carrying the field not at all when
 * there are none.
 *
 * A canvas emptied of its conversations writes what it would have written had
 * nobody ever asked it anything, which is the honest reading of it: there is
 * nothing left to say about, and an empty list would claim a place was made.
 */
function withSessions(
  canvas: CanvasDocument,
  sessions: AssistantSession[],
): CanvasDocument {
  return { ...canvas, sessions: sessions.length > 0 ? sessions : undefined };
}

function withSession(
  canvas: CanvasDocument,
  session: AssistantSession,
): CanvasDocument {
  const sessions = canvas.sessions ?? [];
  return withSessions(
    canvas,
    sessions.map((s) => (s.id === session.id ? session : s)),
  );
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

// ---------------------------------------------------------------------------
// The cutting room: the shelf the timeline commands sit on. What a timeline
// may hold, and where a seam sits, lives in timeline.ts — the same rules the
// document validator reads, so a command and a validation cannot disagree.
// ---------------------------------------------------------------------------

/**
 * The timelines a project carries, or carrying the field not at all when it
 * has none — the same honest reading the folders give an empty tree.
 */
function withTimelines(
  moka: MokaFile,
  timelines: TimelineDocument[],
): MokaFile {
  return { ...moka, timelines: timelines.length > 0 ? timelines : undefined };
}

function timelineOf(moka: MokaFile, timelineId: TimelineId): TimelineDocument {
  const timeline = (moka.timelines ?? []).find((t) => t.id === timelineId);
  if (!timeline)
    throw new CommandError("TIMELINE_NOT_FOUND", "Timeline not found");
  return timeline;
}

function replaceTimeline(moka: MokaFile, timeline: TimelineDocument): MokaFile {
  return withTimelines(
    moka,
    (moka.timelines ?? []).map((t) => (t.id === timeline.id ? timeline : t)),
  );
}

function checkTimelineName(name: string) {
  if (name.length === 0)
    throw new CommandError("VALIDATION_FAILED", "Timeline name is empty");
  if (name.length > TIMELINE_NAME_MAX)
    throw new CommandError("VALIDATION_FAILED", "Timeline name is too long");
}

function isEven(value: number): boolean {
  return Number.isInteger(value) && Math.trunc(value) % 2 === 0;
}

function validateTimelineSettings(settings: Partial<TimelineSettings>) {
  if (
    settings.fps !== undefined &&
    !TIMELINE_FPS_CHOICES.includes(settings.fps as never)
  )
    throw new CommandError(
      "VALIDATION_FAILED",
      "Frame rate is not one of the choices",
    );
  if (settings.width !== undefined) {
    if (
      settings.width < TIMELINE_WIDTH_MIN ||
      settings.width > TIMELINE_WIDTH_MAX ||
      !isEven(settings.width)
    )
      throw new CommandError(
        "VALIDATION_FAILED",
        "Width is out of range or odd",
      );
  }
  if (settings.height !== undefined) {
    if (
      settings.height < TIMELINE_HEIGHT_MIN ||
      settings.height > TIMELINE_HEIGHT_MAX ||
      !isEven(settings.height)
    )
      throw new CommandError(
        "VALIDATION_FAILED",
        "Height is out of range or odd",
      );
  }
  if (settings.background !== undefined) checkHexColor(settings.background);
}

function syncGroupNodeData(canvas: CanvasDocument): CanvasDocument {
  const byId = new Map(canvas.groups.map((g) => [g.groupId, g]));
  let changed = false;
  const nodes = canvas.nodes.map((node) => {
    if (node.kind !== "group") return node;
    const membership = byId.get(node.id);
    const current = (node.data as { childNodeIds?: NodeId[] }).childNodeIds;
    const next = membership?.childNodeIds ?? [];
    if (JSON.stringify(current) === JSON.stringify(next)) return node;
    changed = true;
    return {
      ...node,
      data: { ...(node.data as object), childNodeIds: next } as never,
    };
  });
  return changed ? { ...canvas, nodes } : canvas;
}

function applyOne(
  moka: MokaFile,
  command: DocumentCommand,
): { next: MokaFile; inverse: DocumentCommand[] } {
  switch (command.type) {
    case "addNode": {
      const canvas = canvasOf(moka, command.canvasId);
      if (findNode(canvas, command.node.id))
        throw new CommandError("CONFLICT", "Node id already exists");
      if (canvas.nodes.length + 1 > MAX_NODES_PER_CANVAS)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Canvas node limit reached",
        );
      if (!validateBounds(command.node.bounds))
        throw new CommandError("BOUNDS_INVALID", "Node bounds are invalid");
      if (command.node.title.length > MAX_TITLE_LENGTH)
        throw new CommandError("VALIDATION_FAILED", "Node title is too long");
      const next: CanvasDocument = {
        ...canvas,
        nodes: [...canvas.nodes, command.node],
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "removeNodes",
            canvasId: command.canvasId,
            nodeIds: [command.node.id],
          },
        ],
      };
    }

    case "updateNode": {
      const canvas = canvasOf(moka, command.canvasId);
      const node = findNode(canvas, command.nodeId);
      if (!node) throw new CommandError("NODE_NOT_FOUND", "Node not found");
      if (
        command.patch.title !== undefined &&
        command.patch.title.length > MAX_TITLE_LENGTH
      )
        throw new CommandError("VALIDATION_FAILED", "Node title is too long");
      const inversePatch: Record<string, unknown> = {};
      if (command.patch.title !== undefined) inversePatch.title = node.title;
      if (command.patch.zIndex !== undefined) inversePatch.zIndex = node.zIndex;
      if (command.patch.data !== undefined) inversePatch.data = node.data;
      const updated: WorkflowNode = {
        ...node,
        ...(command.patch.title !== undefined
          ? { title: command.patch.title }
          : {}),
        ...(command.patch.zIndex !== undefined
          ? { zIndex: command.patch.zIndex }
          : {}),
        ...(command.patch.data !== undefined
          ? { data: command.patch.data }
          : {}),
      };
      const next: CanvasDocument = {
        ...canvas,
        nodes: canvas.nodes.map((n) => (n.id === node.id ? updated : n)),
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "updateNode",
            canvasId: command.canvasId,
            nodeId: node.id,
            patch: inversePatch as never,
          },
        ],
      };
    }

    case "moveNodes": {
      const canvas = canvasOf(moka, command.canvasId);
      const previous: Record<NodeId, { x: number; y: number }> = {};
      const nodes = canvas.nodes.map((node) => {
        const position = command.positions[node.id];
        if (!position) return node;
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
          throw new CommandError("BOUNDS_INVALID", "Position is not finite");
        previous[node.id] = { x: node.bounds.x, y: node.bounds.y };
        return {
          ...node,
          bounds: { ...node.bounds, x: position.x, y: position.y },
        };
      });
      const next = syncGroupNodeData({ ...canvas, nodes });
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "moveNodes",
            canvasId: command.canvasId,
            positions: previous,
          },
        ],
      };
    }

    case "resizeNode": {
      const canvas = canvasOf(moka, command.canvasId);
      const node = findNode(canvas, command.nodeId);
      if (!node) throw new CommandError("NODE_NOT_FOUND", "Node not found");
      if (!validateBounds(command.bounds))
        throw new CommandError("BOUNDS_INVALID", "Bounds are invalid");
      const previous = { ...node.bounds };
      const next: CanvasDocument = {
        ...canvas,
        nodes: canvas.nodes.map((n) =>
          n.id === node.id ? { ...n, bounds: { ...command.bounds } } : n,
        ),
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "resizeNode",
            canvasId: command.canvasId,
            nodeId: node.id,
            bounds: previous,
          },
        ],
      };
    }

    case "removeNodes": {
      const canvas = canvasOf(moka, command.canvasId);
      const removing = new Set(command.nodeIds);
      const removedNodes = canvas.nodes.filter((n) => removing.has(n.id));
      if (removedNodes.length !== removing.size)
        throw new CommandError("NODE_NOT_FOUND", "Some nodes were not found");
      const removedEdges = canvas.edges.filter(
        (e) => removing.has(e.source.nodeId) || removing.has(e.target.nodeId),
      );
      const previousGroups = canvas.groups;

      let nodes = canvas.nodes.filter((n) => !removing.has(n.id));
      let edges = canvas.edges.filter(
        (e) => !removing.has(e.source.nodeId) && !removing.has(e.target.nodeId),
      );
      let groups = canvas.groups
        .filter((g) => !removing.has(g.groupId))
        .map((g) => ({
          ...g,
          childNodeIds: g.childNodeIds.filter((id) => !removing.has(id)),
        }));

      // Groups that drop below two members dissolve; their group nodes go too.
      const dissolved = new Set<string>();
      for (const g of groups) {
        if (g.childNodeIds.length < 2) dissolved.add(g.groupId);
      }
      if (dissolved.size > 0) {
        const dissolvedNodes = nodes.filter(
          (n) => n.kind === "group" && dissolved.has(n.id),
        );
        for (const n of dissolvedNodes) removedNodes.push(n);
        const dissolvedEdges = edges.filter(
          (e) =>
            dissolved.has(e.source.nodeId) || dissolved.has(e.target.nodeId),
        );
        for (const e of dissolvedEdges) removedEdges.push(e);
        nodes = nodes.filter((n) => !dissolved.has(n.id));
        edges = edges.filter(
          (e) =>
            !dissolved.has(e.source.nodeId) && !dissolved.has(e.target.nodeId),
        );
        groups = groups.filter((g) => !dissolved.has(g.groupId));
      }

      const next = syncGroupNodeData({ ...canvas, nodes, edges, groups });
      const inverse: DocumentCommand[] = [];
      const orderedRemoved = canvas.nodes.filter((n) =>
        removedNodes.some((r) => r.id === n.id),
      );
      for (const node of orderedRemoved) {
        inverse.push({ type: "addNode", canvasId: command.canvasId, node });
      }
      for (const edge of removedEdges) {
        inverse.push({ type: "addEdge", canvasId: command.canvasId, edge });
      }
      for (const group of previousGroups) {
        const current = groups.find((g) => g.groupId === group.groupId);
        if (
          !current ||
          JSON.stringify(current.childNodeIds) !==
            JSON.stringify(group.childNodeIds)
        ) {
          inverse.push({
            type: "setGroupMembership",
            canvasId: command.canvasId,
            groupId: group.groupId,
            childNodeIds: group.childNodeIds,
          });
        }
      }
      return { next: replaceCanvas(moka, next), inverse };
    }

    case "addEdge": {
      const canvas = canvasOf(moka, command.canvasId);
      if (canvas.edges.some((e) => e.id === command.edge.id))
        throw new CommandError("CONFLICT", "Edge id already exists");
      if (canvas.edges.length + 1 > MAX_EDGES_PER_CANVAS)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Canvas edge limit reached",
        );
      const result = validateEdgeCandidate(
        canvas,
        command.edge.source,
        command.edge.target,
      );
      if (!result.ok) throw new CommandError(result.code, result.message);
      const next: CanvasDocument = {
        ...canvas,
        edges: [...canvas.edges, command.edge],
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: [
          {
            type: "removeEdges",
            canvasId: command.canvasId,
            edgeIds: [command.edge.id],
          },
        ],
      };
    }

    case "removeEdges": {
      const canvas = canvasOf(moka, command.canvasId);
      const removing = new Set(command.edgeIds);
      const removed: WorkflowEdge[] = canvas.edges.filter((e) =>
        removing.has(e.id),
      );
      if (removed.length !== removing.size)
        throw new CommandError("EDGE_NOT_FOUND", "Some edges were not found");
      const next: CanvasDocument = {
        ...canvas,
        edges: canvas.edges.filter((e) => !removing.has(e.id)),
      };
      return {
        next: replaceCanvas(moka, next),
        inverse: removed.map((edge) => ({
          type: "addEdge",
          canvasId: command.canvasId,
          edge,
        })),
      };
    }

    case "setGroupMembership": {
      const canvas = canvasOf(moka, command.canvasId);
      const groupNode = findNode(canvas, command.groupId);
      if (!groupNode || groupNode.kind !== "group")
        throw new CommandError("GROUP_INVALID", "Group node not found");
      const unique = new Set(command.childNodeIds);
      if (unique.size !== command.childNodeIds.length)
        throw new CommandError("GROUP_INVALID", "Duplicate group member");
      if (unique.has(command.groupId))
        throw new CommandError(
          "GROUP_INVALID",
          "A group cannot contain itself",
        );
      for (const id of unique) {
        const child = findNode(canvas, id);
        if (!child)
          throw new CommandError("NODE_NOT_FOUND", "Member not found");
        if (child.kind === "group")
          throw new CommandError(
            "GROUP_INVALID",
            "Nested groups are not supported",
          );
      }
      const previous =
        canvas.groups.find((g) => g.groupId === command.groupId)
          ?.childNodeIds ?? [];
      const others = canvas.groups.filter((g) => g.groupId !== command.groupId);

      const inverse: DocumentCommand[] = [];
      let working: CanvasDocument;
      if (command.childNodeIds.length >= 2) {
        working = {
          ...canvas,
          groups: [
            ...others,
            { groupId: command.groupId, childNodeIds: command.childNodeIds },
          ],
        };
      } else {
        // Dissolve: drop the membership, the group node, and its edges.
        const removedEdges = canvas.edges.filter(
          (e) =>
            e.source.nodeId === command.groupId ||
            e.target.nodeId === command.groupId,
        );
        inverse.push({
          type: "addNode",
          canvasId: command.canvasId,
          node: groupNode,
        });
        for (const edge of removedEdges) {
          inverse.push({ type: "addEdge", canvasId: command.canvasId, edge });
        }
        working = {
          ...canvas,
          groups: others,
          nodes: canvas.nodes.filter((n) => n.id !== command.groupId),
          edges: canvas.edges.filter(
            (e) =>
              e.source.nodeId !== command.groupId &&
              e.target.nodeId !== command.groupId,
          ),
        };
      }
      inverse.push({
        type: "setGroupMembership",
        canvasId: command.canvasId,
        groupId: command.groupId,
        childNodeIds: previous,
      });
      const next = syncGroupNodeData(working);
      return { next: replaceCanvas(moka, next), inverse };
    }

    case "setViewport": {
      const canvas = canvasOf(moka, command.canvasId);
      const viewport = {
        x: command.viewport.x,
        y: command.viewport.y,
        zoom: clampZoom(command.viewport.zoom),
      };
      if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y))
        throw new CommandError("BOUNDS_INVALID", "Viewport is not finite");
      const previous = { ...canvas.viewport };
      return {
        next: replaceCanvas(moka, { ...canvas, viewport }),
        inverse: [
          {
            type: "setViewport",
            canvasId: command.canvasId,
            viewport: previous,
          },
        ],
      };
    }

    case "setCanvasSettings": {
      const canvas = canvasOf(moka, command.canvasId);
      const settings: DocumentSettings = {
        ...canvas.settings,
        ...command.settings,
      };
      if (!BACKGROUND_MODES.includes(settings.background))
        throw new CommandError(
          "VALIDATION_FAILED",
          "Background mode is not one of the three",
        );
      if (typeof settings.showMinimap !== "boolean")
        throw new CommandError(
          "VALIDATION_FAILED",
          "Minimap preference is not a boolean",
        );
      if (typeof settings.snapToGrid !== "boolean")
        throw new CommandError(
          "VALIDATION_FAILED",
          "Snap preference is not a boolean",
        );
      const previous = { ...canvas.settings };
      return {
        next: replaceCanvas(moka, { ...canvas, settings }),
        inverse: [
          {
            type: "setCanvasSettings",
            canvasId: command.canvasId,
            settings: previous,
          },
        ],
      };
    }

    case "addSession": {
      const canvas = canvasOf(moka, command.canvasId);
      const sessions = canvas.sessions ?? [];
      if (sessions.some((s) => s.id === command.session.id))
        throw new CommandError("CONFLICT", "Session id already exists");
      if (sessions.length + 1 > MAX_ASSISTANT_SESSIONS_PER_CANVAS)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Canvas session limit reached",
        );
      if (command.session.title.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Session title is empty");
      if (command.session.title.length > MAX_ASSISTANT_TITLE_LENGTH)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Session title is too long",
        );
      if (command.session.messages.length > MAX_ASSISTANT_MESSAGES_PER_SESSION)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Session message limit reached",
        );
      const index = Math.min(
        Math.max(command.index ?? sessions.length, 0),
        sessions.length,
      );
      const list = [...sessions];
      list.splice(index, 0, command.session);
      return {
        next: replaceCanvas(moka, withSessions(canvas, list)),
        inverse: [
          {
            type: "removeSession",
            canvasId: command.canvasId,
            sessionId: command.session.id,
          },
        ],
      };
    }

    case "renameSession": {
      const canvas = canvasOf(moka, command.canvasId);
      const session = sessionOf(canvas, command.sessionId);
      if (command.title.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Session title is empty");
      if (command.title.length > MAX_ASSISTANT_TITLE_LENGTH)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Session title is too long",
        );
      const previous = session.title;
      // What a conversation is called is not something said in it, so renaming
      // leaves the moment something was last said alone: the newest conversation
      // is found by it, and a rename would otherwise make this one that.
      return {
        next: replaceCanvas(
          moka,
          withSession(canvas, { ...session, title: command.title }),
        ),
        inverse: [
          {
            type: "renameSession",
            canvasId: command.canvasId,
            sessionId: command.sessionId,
            title: previous,
          },
        ],
      };
    }

    case "removeSession": {
      const canvas = canvasOf(moka, command.canvasId);
      const sessions = canvas.sessions ?? [];
      const index = sessions.findIndex((s) => s.id === command.sessionId);
      if (index < 0)
        throw new CommandError("SESSION_NOT_FOUND", "Session not found");
      return {
        next: replaceCanvas(
          moka,
          withSessions(
            canvas,
            sessions.filter((s) => s.id !== command.sessionId),
          ),
        ),
        inverse: [
          {
            type: "addSession",
            canvasId: command.canvasId,
            session: sessions[index],
            index,
          },
        ],
      };
    }

    case "appendMessages": {
      const canvas = canvasOf(moka, command.canvasId);
      const session = sessionOf(canvas, command.sessionId);
      if (command.messages.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Nothing to append");
      const known = new Set(session.messages.map((message) => message.id));
      for (const message of command.messages) {
        if (known.has(message.id))
          throw new CommandError("CONFLICT", "Message id already exists");
        known.add(message.id);
        if (message.text.length > MAX_ASSISTANT_MESSAGE_LENGTH)
          throw new CommandError("VALIDATION_FAILED", "Message is too long");
      }

      const messages = [...session.messages];
      const at = Math.min(
        Math.max(command.at ?? messages.length, 0),
        messages.length,
      );
      messages.splice(at, 0, ...command.messages);

      // The oldest lines go to keep a conversation a length that can still be
      // read through. They go from the document and not only from the screen, so
      // the undo that takes the new lines back gives these back too, each at the
      // place it held: putting them back oldest first lands them where they were.
      const overflow = messages.length - MAX_ASSISTANT_MESSAGES_PER_SESSION;
      const dropped = overflow > 0 ? messages.splice(0, overflow) : [];
      const kept = new Set(messages.map((message) => message.id));
      const appended = command.messages
        .map((message) => message.id)
        .filter((id) => kept.has(id));

      const inverse: DocumentCommand[] = [];
      if (appended.length > 0) {
        inverse.push({
          type: "removeMessages",
          canvasId: command.canvasId,
          sessionId: session.id,
          messageIds: appended,
        });
      }
      for (const [position, message] of dropped.entries()) {
        inverse.push({
          type: "appendMessages",
          canvasId: command.canvasId,
          sessionId: session.id,
          messages: [message],
          at: position,
        });
      }

      const spokenAt = messages.at(-1)?.createdAt;
      return {
        next: replaceCanvas(
          moka,
          withSession(canvas, {
            ...session,
            messages,
            updatedAt:
              spokenAt !== undefined && spokenAt > session.updatedAt
                ? spokenAt
                : session.updatedAt,
          }),
        ),
        inverse,
      };
    }

    case "removeMessages": {
      const canvas = canvasOf(moka, command.canvasId);
      const session = sessionOf(canvas, command.sessionId);
      const removing = new Set(command.messageIds);
      const removed = session.messages.filter((message) =>
        removing.has(message.id),
      );
      if (removed.length !== removing.size)
        throw new CommandError("MESSAGE_NOT_FOUND", "Some messages not found");
      const held = new Map(
        session.messages.map((message, position) => [message.id, position]),
      );
      return {
        next: replaceCanvas(
          moka,
          withSession(canvas, {
            ...session,
            messages: session.messages.filter(
              (message) => !removing.has(message.id),
            ),
          }),
        ),
        // Each line goes back to the place it held, oldest first, which is the
        // order that lands them all where they were.
        inverse: removed.map((message) => ({
          type: "appendMessages" as const,
          canvasId: command.canvasId,
          sessionId: command.sessionId,
          messages: [message],
          at: held.get(message.id),
        })),
      };
    }

    case "addCanvas": {
      if (moka.canvas.length + 1 > MAX_CANVASES_PER_PROJECT)
        throw new CommandError("VALIDATION_FAILED", "Canvas limit reached");
      if (moka.canvas.some((c) => c.id === command.canvas.id))
        throw new CommandError("CONFLICT", "Canvas id already exists");
      // A canvas born into a folder names it, so the folder has to be there:
      // one that is not would leave the board somewhere no tree can show it.
      folderOf(moka, command.canvas.folderId ?? null);
      const index = Math.min(
        Math.max(command.index ?? moka.canvas.length, 0),
        moka.canvas.length,
      );
      const list = [...moka.canvas];
      list.splice(index, 0, command.canvas);
      return {
        next: { ...moka, canvas: list },
        inverse: [{ type: "removeCanvas", canvasId: command.canvas.id }],
      };
    }

    case "renameCanvas": {
      const canvas = canvasOf(moka, command.canvasId);
      if (command.name.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Canvas name is empty");
      if (command.name.length > MAX_CANVAS_NAME_LENGTH)
        throw new CommandError("VALIDATION_FAILED", "Canvas name is too long");
      const previous = canvas.name;
      return {
        next: replaceCanvas(moka, { ...canvas, name: command.name }),
        inverse: [
          { type: "renameCanvas", canvasId: command.canvasId, name: previous },
        ],
      };
    }

    case "reorderCanvas": {
      const index = moka.canvas.findIndex((c) => c.id === command.canvasId);
      if (index < 0)
        throw new CommandError("CANVAS_NOT_FOUND", "Canvas not found");
      const target = Math.min(
        Math.max(command.index, 0),
        moka.canvas.length - 1,
      );
      const list = [...moka.canvas];
      const [moved] = list.splice(index, 1);
      list.splice(target, 0, moved);
      return {
        next: { ...moka, canvas: list },
        inverse: [{ type: "reorderCanvas", canvasId: command.canvasId, index }],
      };
    }

    case "removeCanvas": {
      const index = moka.canvas.findIndex((c) => c.id === command.canvasId);
      if (index < 0)
        throw new CommandError("CANVAS_NOT_FOUND", "Canvas not found");
      if (moka.canvas.length <= 1)
        throw new CommandError(
          "CANVAS_REQUIRED",
          "The last canvas cannot be removed",
        );
      const removed = moka.canvas[index];
      const list = moka.canvas.filter((c) => c.id !== command.canvasId);
      return {
        next: { ...moka, canvas: list },
        inverse: [{ type: "addCanvas", canvas: removed, index }],
      };
    }

    case "addFolder": {
      const folders = foldersOf(moka);
      if (folders.length + 1 > MAX_FOLDERS_PER_PROJECT)
        throw new CommandError("VALIDATION_FAILED", "Folder limit reached");
      if (folders.some((folder) => folder.id === command.folder.id))
        throw new CommandError("CONFLICT", "Folder id already exists");
      checkFolderName(command.folder.name);
      const parentId = folderOf(moka, command.folder.parentId ?? null);
      const placed = { ...command.folder, parentId: parentId ?? undefined };
      const siblings = childFolders(moka, parentId);
      const next = spliceAmong(
        folders,
        siblings,
        command.index ?? siblings.length,
        placed,
      );
      const candidate = withFolders(moka, next);
      checkFolderDepth(candidate, placed.id);
      return {
        next: candidate,
        inverse: [{ type: "removeFolder", folderId: placed.id }],
      };
    }

    case "renameFolder": {
      const folder = folderById(moka, command.folderId);
      if (!folder)
        throw new CommandError("FOLDER_NOT_FOUND", "Folder not found");
      checkFolderName(command.name);
      const previous = folder.name;
      return {
        next: withFolders(
          moka,
          foldersOf(moka).map((item) =>
            item.id === folder.id ? { ...item, name: command.name } : item,
          ),
        ),
        inverse: [
          {
            type: "renameFolder",
            folderId: folder.id,
            name: previous,
          },
        ],
      };
    }

    case "moveFolder": {
      const folders = foldersOf(moka);
      const folder = folderById(moka, command.folderId);
      if (!folder)
        throw new CommandError("FOLDER_NOT_FOUND", "Folder not found");
      const parentId = folderOf(moka, command.parentId);
      if (parentId === folder.id)
        throw new CommandError(
          "VALIDATION_FAILED",
          "A folder cannot be moved into itself",
        );
      if (descendantFolderIds(moka, folder.id).includes(parentId ?? ""))
        throw new CommandError(
          "VALIDATION_FAILED",
          "A folder cannot be moved into one it holds",
        );
      const previousParent = folder.parentId ?? null;
      const previousIndex = folderSiblingIndex(moka, folder.id);
      const without = folders.filter((item) => item.id !== folder.id);
      const siblings = without.filter(
        (item) => (item.parentId ?? null) === parentId,
      );
      const moved: CanvasFolder = {
        ...folder,
        parentId: parentId ?? undefined,
      };
      const next = spliceAmong(without, siblings, command.index, moved);
      const candidate = withFolders(moka, next);
      checkFolderDepth(candidate, folder.id);
      return {
        next: candidate,
        inverse: [
          {
            type: "moveFolder",
            folderId: folder.id,
            parentId: previousParent,
            index: previousIndex,
          },
        ],
      };
    }

    case "removeFolder": {
      const folders = foldersOf(moka);
      const position = folders.findIndex(
        (item) => item.id === command.folderId,
      );
      if (position < 0)
        throw new CommandError("FOLDER_NOT_FOUND", "Folder not found");
      const removed = folders[position];
      const parentId = removed.parentId ?? null;
      const previousIndex = folderSiblingIndex(moka, removed.id);
      // What the folder held is not held by nothing: its folders and its
      // canvases go up into the folder that held it, which is what makes
      // tidying the tree something a reader can do without risking a board.
      const heldFolders = childFolders(moka, removed.id).map(
        (folder, index) => ({ folder, index }),
      );
      const heldCanvases = folderCanvases(moka, removed.id).map(
        (canvas, index) => ({ canvas, index }),
      );
      const heldCanvasIds = new Set(
        heldCanvases.map(({ canvas }) => canvas.id),
      );
      // Each folder it held takes its place in the list, in the order they were
      // read, so what a drawer held stays where the drawer was rather than going
      // to the end of the shelf it was poured into.
      const nextFolders = folders.flatMap((item) =>
        item.id === removed.id
          ? heldFolders.map(({ folder }) => ({
              ...folder,
              parentId: parentId ?? undefined,
            }))
          : [item],
      );
      const nextCanvases = moka.canvas.map((canvas) =>
        heldCanvasIds.has(canvas.id)
          ? { ...canvas, folderId: parentId ?? undefined }
          : canvas,
      );
      const inverse: DocumentCommand[] = [
        { type: "addFolder", folder: removed, index: previousIndex },
      ];
      for (const { folder, index } of heldFolders) {
        inverse.push({
          type: "moveFolder",
          folderId: folder.id,
          parentId: removed.id,
          index,
        });
      }
      for (const { canvas, index } of heldCanvases) {
        inverse.push({
          type: "moveCanvas",
          canvasId: canvas.id,
          folderId: removed.id,
          index,
        });
      }
      return {
        next: { ...withFolders(moka, nextFolders), canvas: nextCanvases },
        inverse,
      };
    }

    case "moveCanvas": {
      const canvas = canvasOf(moka, command.canvasId);
      const folderId = folderOf(moka, command.folderId);
      const previousFolder = canvasFolderOf(canvas);
      const previousIndex = canvasSiblingIndex(moka, canvas.id);
      const without = moka.canvas.filter((c) => c.id !== canvas.id);
      const peers = without.filter((c) => (c.folderId ?? null) === folderId);
      const moved: CanvasDocument = {
        ...canvas,
        folderId: folderId ?? undefined,
      };
      return {
        next: {
          ...moka,
          canvas: spliceAmong(without, peers, command.index, moved),
        },
        inverse: [
          {
            type: "moveCanvas",
            canvasId: canvas.id,
            folderId: previousFolder,
            index: previousIndex,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // The cutting room
    // -----------------------------------------------------------------------

    case "addTimeline": {
      const timelines = moka.timelines ?? [];
      if (timelines.length + 1 > MAX_TIMELINES_PER_PROJECT)
        throw new CommandError("VALIDATION_FAILED", "Timeline limit reached");
      if (timelines.some((t) => t.id === command.timeline.id))
        throw new CommandError("CONFLICT", "Timeline id already exists");
      checkTimelineName(command.timeline.name);
      if (command.timeline.schemaVersion > TIMELINE_SCHEMA_VERSION)
        throw new CommandError(
          "MOKA_VERSION_UNSUPPORTED",
          "Timeline schema is newer than this build reads",
        );
      const index = Math.min(
        Math.max(command.index ?? timelines.length, 0),
        timelines.length,
      );
      const list = [...timelines];
      list.splice(index, 0, command.timeline);
      return {
        next: withTimelines(moka, list),
        inverse: [{ type: "removeTimeline", timelineId: command.timeline.id }],
      };
    }

    case "removeTimeline": {
      const timelines = moka.timelines ?? [];
      const index = timelines.findIndex((t) => t.id === command.timelineId);
      if (index < 0)
        throw new CommandError("TIMELINE_NOT_FOUND", "Timeline not found");
      const removed = timelines[index];
      const list = timelines.filter((t) => t.id !== command.timelineId);
      return {
        next: withTimelines(moka, list),
        // Put back whole, at the place it was read: a timeline is a document
        // in its own right, so what it held comes back with it.
        inverse: [{ type: "addTimeline", timeline: removed, index }],
      };
    }

    case "renameTimeline": {
      const timeline = timelineOf(moka, command.timelineId);
      checkTimelineName(command.name);
      const previous = timeline.name;
      return {
        next: replaceTimeline(moka, { ...timeline, name: command.name }),
        inverse: [
          {
            type: "renameTimeline",
            timelineId: command.timelineId,
            name: previous,
          },
        ],
      };
    }

    case "updateTimelineSettings": {
      const timeline = timelineOf(moka, command.timelineId);
      validateTimelineSettings(command.settings);
      const previous: Partial<TimelineSettings> = {};
      for (const key of ["fps", "width", "height", "background"] as const) {
        if (command.settings[key] !== undefined) {
          (previous as Record<string, unknown>)[key] = timeline.settings[key];
        }
      }
      const settings: TimelineSettings = {
        ...timeline.settings,
        ...command.settings,
      };
      // The whole timeline is re-validated under the new frame: nothing stored
      // depends on the frame yet, but a document that says an impossible thing
      // under its own settings is refused here rather than on the exporter's
      // doorstep.
      return {
        next: replaceTimeline(moka, { ...timeline, settings }),
        inverse: [
          {
            type: "updateTimelineSettings",
            timelineId: command.timelineId,
            settings: previous,
          },
        ],
      };
    }

    case "addTrack": {
      const timeline = timelineOf(moka, command.timelineId);
      if (timeline.tracks.length + 1 > MAX_TRACKS_PER_TIMELINE)
        throw new CommandError("VALIDATION_FAILED", "Track limit reached");
      if (timeline.tracks.some((t) => t.id === command.track.id))
        throw new CommandError("CONFLICT", "Track id already exists");
      if (
        command.track.name.length === 0 ||
        command.track.name.length > TIMELINE_NAME_MAX
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          "Track name is empty or too long",
        );
      const index = Math.min(
        Math.max(command.index ?? timeline.tracks.length, 0),
        timeline.tracks.length,
      );
      const tracks = [...timeline.tracks];
      tracks.splice(index, 0, command.track);
      return {
        next: replaceTimeline(moka, { ...timeline, tracks }),
        inverse: [
          {
            type: "removeTrack",
            timelineId: command.timelineId,
            trackId: command.track.id,
          },
        ],
      };
    }

    case "removeTrack": {
      const timeline = timelineOf(moka, command.timelineId);
      const index = timeline.tracks.findIndex((t) => t.id === command.trackId);
      if (index < 0)
        throw new CommandError("TRACK_NOT_FOUND", "Track not found");
      // A track holding clips is not taken out: the clips are work, and a
      // caller that wants the row gone moves them first.
      if (timeline.clips.some((clip) => clip.trackId === command.trackId))
        throw new CommandError(
          "TRACK_NOT_EMPTY",
          "That track still holds clips",
        );
      const removed = timeline.tracks[index];
      const tracks = timeline.tracks.filter((t) => t.id !== command.trackId);
      return {
        next: replaceTimeline(moka, { ...timeline, tracks }),
        inverse: [
          {
            type: "addTrack",
            timelineId: command.timelineId,
            track: removed,
            index,
          },
        ],
      };
    }

    case "updateTrack": {
      const timeline = timelineOf(moka, command.timelineId);
      const track = timeline.tracks.find((t) => t.id === command.trackId);
      if (!track) throw new CommandError("TRACK_NOT_FOUND", "Track not found");
      if (
        command.patch.name !== undefined &&
        (command.patch.name.length === 0 ||
          command.patch.name.length > TIMELINE_NAME_MAX)
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          "Track name is empty or too long",
        );
      const previous: Partial<
        Pick<TimelineTrack, "name" | "muted" | "hidden" | "locked">
      > = {};
      if (command.patch.name !== undefined) previous.name = track.name;
      if (command.patch.muted !== undefined) previous.muted = track.muted;
      if (command.patch.hidden !== undefined) previous.hidden = track.hidden;
      if (command.patch.locked !== undefined) previous.locked = track.locked;
      const tracks = timeline.tracks.map((t) =>
        t.id === track.id ? { ...t, ...command.patch } : t,
      );
      return {
        next: replaceTimeline(moka, { ...timeline, tracks }),
        inverse: [
          {
            type: "updateTrack",
            timelineId: command.timelineId,
            trackId: track.id,
            patch: previous,
          },
        ],
      };
    }

    case "addClips": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.clips.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Nothing to add");
      if (command.clips.length > MAX_CLIPS_PER_COMMAND)
        throw new CommandError(
          "VALIDATION_FAILED",
          `One step lands at most ${MAX_CLIPS_PER_COMMAND} clips`,
        );
      if (timeline.clips.length + command.clips.length > MAX_CLIPS_PER_TIMELINE)
        throw new CommandError(
          "VALIDATION_FAILED",
          "Timeline clip limit reached",
        );
      const known = new Set(timeline.clips.map((clip) => clip.id));
      for (const clip of command.clips) {
        if (known.has(clip.id))
          throw new CommandError("CONFLICT", "Clip id already exists");
        known.add(clip.id);
        checkClip(moka, timeline, clip);
      }
      const seams = command.seams ?? [];
      // Restored seams are read against the clips as this command leaves
      // them: a seam's leader may be a clip already on the timeline or one
      // this batch is landing, and its geometry must already hold — this
      // path restores a pull-back, it does not make one (R6).
      const world: TimelineDocument = {
        ...timeline,
        clips: [...timeline.clips, ...command.clips],
      };
      const seamIds = new Set(timeline.transitions.map((t) => t.id));
      const seamLeaders = new Set(
        timeline.transitions.map((t) => t.afterClipId),
      );
      for (const seam of seams) {
        if (seamIds.has(seam.id))
          throw new CommandError("CONFLICT", "Transition id already exists");
        seamIds.add(seam.id);
        if (seamLeaders.has(seam.afterClipId))
          throw new CommandError(
            "CONFLICT",
            "That seam already carries a transition",
          );
        seamLeaders.add(seam.afterClipId);
        checkTransitionRestoration(world, seam);
      }
      checkNoOverlap(timeline, command.clips, { seams });
      const clips = [...timeline.clips, ...command.clips];
      return {
        next: replaceTimeline(moka, {
          ...timeline,
          clips,
          transitions: [...timeline.transitions, ...seams],
        }),
        // No transition can point at a clip that did not exist, so there is
        // nothing here to restore beside the clips and seams themselves.
        inverse: [
          {
            type: "removeClips",
            timelineId: command.timelineId,
            clipIds: command.clips.map((clip) => clip.id),
          },
        ],
      };
    }

    case "removeClips": {
      const timeline = timelineOf(moka, command.timelineId);
      const removing = new Set(command.clipIds);
      const removed = timeline.clips.filter((clip) => removing.has(clip.id));
      if (removed.length !== removing.size)
        throw new CommandError("CLIP_NOT_FOUND", "Some clips were not found");
      // Each seam transition goes with its seam, and both seams a removed
      // clip touched — the one ahead of it and the one behind it — go.
      const removedTransitions = transitionsOfSeams(timeline, command.clipIds);
      const clips = timeline.clips.filter((clip) => !removing.has(clip.id));
      const transitionIds = new Set(
        removedTransitions.map((transition) => transition.id),
      );
      const transitions = timeline.transitions.filter(
        (transition) => !transitionIds.has(transition.id),
      );
      return {
        next: replaceTimeline(moka, { ...timeline, clips, transitions }),
        inverse: [
          // The clips and their seams come back in one command, in the
          // geometry they were stored in. Restoring the clips alone would
          // put the follower in the bare overlap the seam is made of, and
          // the first step of a two-step restore would be refused there.
          {
            type: "addClips",
            timelineId: command.timelineId,
            clips: removed,
            ...(removedTransitions.length > 0
              ? { seams: removedTransitions }
              : {}),
          },
        ],
      };
    }

    case "updateClips": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.patches.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Nothing to update");
      if (command.patches.length > MAX_CLIPS_PER_COMMAND)
        throw new CommandError(
          "VALIDATION_FAILED",
          `One step touches at most ${MAX_CLIPS_PER_COMMAND} clips`,
        );
      const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
      const updated = new Map<string, TimelineClip>();
      const inverses: DocumentCommand[] = [];
      for (const { clipId, patch } of command.patches) {
        const clip = byId.get(clipId);
        if (!clip) throw new CommandError("CLIP_NOT_FOUND", "Clip not found");
        if (updated.has(clipId))
          throw new CommandError(
            "CONFLICT",
            "A clip is patched twice in one step",
          );
        const next = checkClip(moka, timeline, mergeClipPatch(clip, patch));
        updated.set(clipId, next);
        // The inverse patch carries back what this one moved, and nothing
        // else — undoing a volume change does not touch the text the same
        // step edited, and a field this patch brought in goes with a null.
        inverses.push({
          type: "updateClips",
          timelineId: command.timelineId,
          patches: [{ clipId, patch: invertClipPatch(clip, patch) }],
        });
      }
      const clips = timeline.clips.map((clip) => updated.get(clip.id) ?? clip);
      // The whole timeline as it would be, so a clip stretched onto a
      // neighbour is CLIP_OVERLAP and one that tears a seam is
      // TRANSITION_SEAM — the same re-check the move ends on (R5, R7).
      checkTimeline(moka, { ...timeline, clips });
      return {
        next: replaceTimeline(moka, { ...timeline, clips }),
        inverse: inverses.reverse(),
      };
    }

    case "moveClips": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.moves.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Nothing to move");
      if (command.moves.length > MAX_CLIPS_PER_COMMAND)
        throw new CommandError(
          "VALIDATION_FAILED",
          `One step moves at most ${MAX_CLIPS_PER_COMMAND} clips`,
        );
      const byId = new Map(timeline.clips.map((clip) => [clip.id, clip]));
      // Last one wins for a clip moved twice in one command, and the undo
      // remembers where the clip started.
      const moved = new Map<string, TimelineClip>();
      const positions: Record<string, { startMs: number; trackId: string }> =
        {};
      for (const { clipId, startMs, trackId } of command.moves) {
        const clip = byId.get(clipId);
        if (!clip) throw new CommandError("CLIP_NOT_FOUND", "Clip not found");
        const targetTrackId = trackId ?? clip.trackId;
        const target = timeline.tracks.find((t) => t.id === targetTrackId);
        if (!target)
          throw new CommandError("TRACK_NOT_FOUND", "Clip's track not found");
        if (!trackAccepts(target, clip.kind))
          throw new CommandError(
            "VALIDATION_FAILED",
            `A ${clip.kind} clip cannot sit on a ${target.kind} track`,
          );
        if (!Number.isInteger(startMs) || startMs < 0)
          throw new CommandError(
            "VALIDATION_FAILED",
            "Clip start is not a whole number of milliseconds",
          );
        if (!positions[clipId])
          positions[clipId] = { startMs: clip.startMs, trackId: clip.trackId };
        moved.set(clipId, { ...clip, startMs, trackId: targetTrackId });
      }
      const clips = timeline.clips.map((clip) => moved.get(clip.id) ?? clip);
      // The whole timeline as it would be: a move onto a held place is
      // CLIP_OVERLAP, and one that leaves a transition's clips no longer
      // making its seam is TRANSITION_SEAM (R5, R7). Moving both ends of a
      // seam by the same shift moves the seam along with them.
      checkTimeline(moka, { ...timeline, clips });
      return {
        next: replaceTimeline(moka, { ...timeline, clips }),
        inverse: [
          {
            type: "moveClips",
            timelineId: command.timelineId,
            moves: Object.entries(positions).map(([clipId, held]) => {
              const move: {
                clipId: string;
                startMs: number;
                trackId?: TrackId;
              } = { clipId, startMs: held.startMs };
              if (moved.get(clipId)!.trackId !== held.trackId)
                move.trackId = held.trackId;
              return move;
            }),
          },
        ],
      };
    }

    case "addTransitions": {
      const timeline = timelineOf(moka, command.timelineId);
      if (command.transitions.length === 0)
        throw new CommandError("VALIDATION_FAILED", "Nothing to add");
      if (
        timeline.transitions.length + command.transitions.length >
        MAX_TRANSITIONS_PER_TIMELINE
      )
        throw new CommandError(
          "VALIDATION_FAILED",
          "Timeline transition limit reached",
        );
      const known = new Set(timeline.transitions.map((t) => t.id));
      const seamLeaders = new Set(
        timeline.transitions.map((t) => t.afterClipId),
      );
      // The batch reads the timeline as the command entered it: a chain
      // being reassembled has every follower still butted until this command
      // pulls them back, one after the other, as it installs the records.
      for (const transition of command.transitions) {
        if (known.has(transition.id))
          throw new CommandError("CONFLICT", "Transition id already exists");
        known.add(transition.id);
        if (seamLeaders.has(transition.afterClipId))
          throw new CommandError(
            "CONFLICT",
            "That seam already carries a transition",
          );
        seamLeaders.add(transition.afterClipId);
        checkTransitionLanding(timeline, transition);
      }
      // Install the records and pull each follower back as the timeline
      // stands at that point, so each seam of a chain is measured against
      // the geometry the seams before it left behind.
      let pulled: TimelineDocument = timeline;
      for (const transition of command.transitions) {
        const leader = pulled.clips.find(
          (clip) => clip.id === transition.afterClipId,
        )!;
        const follower = followerOf(pulled, leader)!;
        const startMs =
          leader.startMs + leader.durationMs - transition.durationMs;
        pulled = {
          ...pulled,
          clips: pulled.clips.map((clip) =>
            clip.id === follower.id ? { ...clip, startMs } : clip,
          ),
        };
      }
      const next: TimelineDocument = {
        ...pulled,
        transitions: [...timeline.transitions, ...command.transitions],
      };
      checkTimeline(moka, next);
      return {
        next: replaceTimeline(moka, next),
        inverse: [
          {
            type: "removeTransitions",
            timelineId: command.timelineId,
            transitionIds: command.transitions.map((t) => t.id),
          },
        ],
      };
    }

    case "removeTransitions": {
      const timeline = timelineOf(moka, command.timelineId);
      const byId = new Map(timeline.transitions.map((t) => [t.id, t]));
      const removing = new Set(command.transitionIds);
      if (removing.size !== command.transitionIds.length)
        throw new CommandError(
          "CONFLICT",
          "A transition is named twice in one step",
        );
      // Release each follower back against its leader, one seam at a time in
      // the order the ids are given: a chain comes apart left to right,
      // because taking a seam out right to left would move its follower into
      // one that is still pulled back.
      let working = timeline;
      for (const transitionId of command.transitionIds) {
        const transition = byId.get(transitionId);
        if (!transition)
          throw new CommandError(
            "TRANSITION_NOT_FOUND",
            "Some transitions were not found",
          );
        const leader = working.clips.find(
          (clip) => clip.id === transition.afterClipId,
        );
        const follower = leader ? followerOf(working, leader) : undefined;
        if (!leader || !follower)
          throw new CommandError(
            "TRANSITION_NOT_FOUND",
            "The seam a transition names is not on the timeline",
          );
        const startMs = leader.startMs + leader.durationMs;
        working = {
          ...working,
          clips: working.clips.map((clip) =>
            clip.id === follower.id ? { ...clip, startMs } : clip,
          ),
        };
      }
      const removed = command.transitionIds.map((id) => byId.get(id)!);
      const next: TimelineDocument = {
        ...working,
        transitions: working.transitions.filter(
          (transition) => !removing.has(transition.id),
        ),
      };
      // What the releases leave behind has to be a state the document may
      // hold: a follower running into the clip behind it is CLIP_OVERLAP,
      // and a seam torn out from under the seam behind it is
      // TRANSITION_SEAM. Seams this same batch released are no longer on the
      // timeline, so they are not among what this reads (R4, R7).
      checkTimeline(moka, next);
      return {
        next: replaceTimeline(moka, next),
        // Same order in, same order out: the pull-backs replay left to right.
        inverse: [
          {
            type: "addTransitions",
            timelineId: command.timelineId,
            transitions: removed,
          },
        ],
      };
    }
  }
}

export function applyCommands(
  moka: MokaFile,
  commands: DocumentCommand[],
): { next: MokaFile; inverse: DocumentCommand[] } {
  let current = moka;
  const inverses: DocumentCommand[] = [];
  for (const command of commands) {
    const { next, inverse } = applyOne(current, command);
    current = next;
    inverses.unshift(...inverse);
  }
  return { next: current, inverse: inverses };
}
