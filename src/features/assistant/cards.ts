import {
  CASCADE_DROP_OFFSET,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  createNode,
  newId,
  nowIso,
  validateEdgeCandidate,
  type CanvasDocument,
  type DocumentCommand,
  type EdgeEndpoint,
  type GenerationSpec,
  type NodeId,
  type NodeKind,
  type Point,
  type Rect,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../shared/domain";
import { viewCenterWorld } from "../editor/canvas/canvasControl";

/**
 * How many places a card is moved on before it is dropped where it was told.
 *
 * A bounded search, because a board filled corner to corner has no clear spot
 * for it, and a card that cannot land clear is better arriving overlapping than
 * not arriving at all.
 */
const LANDING_TRIES = 12;

/** Where a card dropped at the middle of the view sits under that point. */
const DROP_OFFSET: Point = { x: DEFAULT_NODE_WIDTH / 2, y: 40 };

export interface CardPlan {
  nodeId: NodeId;
  /** The card and the wires feeding it, which together are one thing to undo. */
  commands: DocumentCommand[];
  /** Which of the cards the ask was about reached this one by a wire. */
  wired: NodeId[];
}

/**
 * What a card that has been asked for says it made.
 *
 * Counted rather than described, because one ask may be answered with several
 * and a line saying "an image" for three of them sends a reader looking for the
 * one. A card that came back holding nothing says so, since the empty card is
 * still on the canvas and the line is where a reader will look for the reason.
 */
export function madeWords(kind: NodeKind, count: number): string {
  if (count === 0) return "Made nothing";
  const noun =
    kind === "audio" ? "sound" : kind === "video" ? "video" : "image";
  return `Made ${count} ${count === 1 ? noun : `${noun}s`}`;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Where a card a conversation asked for lands: the middle of what is showing,
 * stepped clear of anything already sitting there.
 *
 * The view rather than the neighbourhood of the cards it was wired from, because
 * a card made while a reader is looking somewhere is expected to appear where
 * they are looking — and behind a pile of other cards it would appear nowhere.
 */
export function landingSpot(canvas: CanvasDocument): Point {
  const centre = viewCenterWorld() ?? { x: 0, y: 0 };
  let at = { x: centre.x - DROP_OFFSET.x, y: centre.y - DROP_OFFSET.y };
  for (let tried = 0; tried < LANDING_TRIES; tried += 1) {
    const bounds: Rect = {
      ...at,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    };
    if (!canvas.nodes.some((node) => overlaps(bounds, node.bounds))) break;
    at = { x: at.x + CASCADE_DROP_OFFSET, y: at.y + CASCADE_DROP_OFFSET };
  }
  return at;
}

/**
 * The card a turn asks for, laid out with the wires that feed it.
 *
 * A card and its wires rather than the words of the cards it is about: what a
 * generation takes in is what is wired into it, so a question asked about three
 * pictures reaches the model through them only once this batch has landed. Each
 * source joins the first input it fits, in the order the port table lists them,
 * which is what sends a picture to `images` rather than into a mask somebody was
 * saving — and a source with nothing to plug into is left out and said, rather
 * than wired somewhere the run would only be refused for.
 *
 * The question is written onto the card as its own prompt and the rest is taken
 * from upstream, which is what lets a reader edit the ask afterwards the way they
 * would edit any other card: what was asked stays on the card rather than hidden
 * in a conversation that has already moved on.
 */
export function planCard(options: {
  canvas: CanvasDocument;
  kind: NodeKind;
  title: string;
  asked: string;
  sources: readonly WorkflowNode[];
}): CardPlan {
  const { canvas, kind, title, asked, sources } = options;
  const node = createNode(kind, landingSpot(canvas), { title, generate: true });
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  if (spec) {
    spec.prompt = asked;
    spec.updatedAt = nowIso();
  }

  const wired: NodeId[] = [];
  const edges: WorkflowEdge[] = [];
  const withCard: CanvasDocument = {
    ...canvas,
    nodes: [...canvas.nodes, node],
  };

  for (const source of sources) {
    if (source.id === node.id) continue;
    // Read against the board as it will be once each wire above has landed, so a
    // second picture cannot be promised an input the first one filled.
    const board: CanvasDocument = {
      ...withCard,
      edges: [...withCard.edges, ...edges],
    };
    let taken = false;
    for (const out of source.ports) {
      if (taken || out.direction !== "output") continue;
      for (const into of node.ports) {
        if (into.direction !== "input") continue;
        const from: EdgeEndpoint = { nodeId: source.id, portId: out.id };
        const to: EdgeEndpoint = { nodeId: node.id, portId: into.id };
        if (!validateEdgeCandidate(board, from, to).ok) continue;
        edges.push({
          id: newId(),
          source: from,
          target: to,
          createdAt: nowIso(),
        });
        taken = true;
        break;
      }
    }
    if (taken) wired.push(source.id);
  }

  return {
    nodeId: node.id,
    commands: [
      { type: "addNode", canvasId: canvas.id, node },
      ...edges.map((edge): DocumentCommand => ({
        type: "addEdge",
        canvasId: canvas.id,
        edge,
      })),
    ],
    wired,
  };
}
