import {
  CANVAS_SCHEMA_VERSION,
  MAX_ASSISTANT_MESSAGE_LENGTH,
  MAX_ASSISTANT_MESSAGES_PER_SESSION,
  MAX_ASSISTANT_SESSIONS_PER_CANVAS,
  MAX_ASSISTANT_TITLE_LENGTH,
  MAX_CANVAS_NAME_LENGTH,
  MAX_CANVASES_PER_PROJECT,
  MAX_EDGES_PER_CANVAS,
  MAX_NODES_PER_CANVAS,
  MAX_TITLE_LENGTH,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./constants";
import type {
  AssistantSession,
  CanvasDocument,
  DocumentCommand,
  MokaFile,
  NodeId,
  WorkflowEdge,
  WorkflowNode,
} from "./types";
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
