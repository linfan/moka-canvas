import type { GenerateInput, GenerateRequest } from "../../api/generate";
import type {
  AssetId,
  AssistantMessage,
  AssistantReference,
  AssistantRole,
  Capability,
  CanvasDocument,
  NodeId,
  WorkflowNode,
} from "../../shared/domain";
import { findNode, mentionSpans } from "../../shared/domain";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  type GroupKey,
} from "../editor/canvas/mentions";

/** What one turn of a conversation asks for: words, or a card to hold them. */
export type AssistantIntent =
  "answer" | "rewrite" | "image" | "video" | "audio";

export const ASSISTANT_INTENTS: readonly AssistantIntent[] = [
  "answer",
  "rewrite",
  "image",
  "video",
  "audio",
];

export const INTENT_LABELS: Record<AssistantIntent, string> = {
  answer: "Ask",
  rewrite: "Rewrite",
  image: "Image",
  video: "Video",
  audio: "Audio",
};

export const INTENT_HINTS: Record<AssistantIntent, string> = {
  answer: "Ask about the cards this conversation is about",
  rewrite: "Send the chosen text back written again, and nothing else",
  image: "Put a picture on the canvas, asked with the cards this names",
  video: "Put a moving picture on the canvas, asked with the cards this names",
  audio: "Put a sound on the canvas, asked with the cards this names",
};

/** The kinds of card a conversation can ask for. */
export type CardKind = "image" | "video" | "audio";

/**
 * The kind of card a turn puts on the canvas, or null when it only answers.
 *
 * The words line up on purpose — the thing a reader chooses to ask for is the
 * kind of card that arrives — which is also how the ask knows which capability
 * to be refused for not having a model.
 */
export function mediaKindFor(intent: AssistantIntent): CardKind | null {
  return intent === "image" || intent === "video" || intent === "audio"
    ? intent
    : null;
}

/** What each intent invites the reader to type. */
export const INTENT_PLACEHOLDERS: Record<AssistantIntent, string> = {
  answer: "Ask about the cards you chose…",
  rewrite: "How should it read instead?",
  image: "What should the picture be?",
  video: "What should the shot be?",
  audio: "What should it sound like?",
};

/**
 * The models an intent needs one of.
 *
 * A card is asked for through a run, so the model it wants is not on this wire
 * at all — but a board with no picture model has no way to answer a request for
 * a picture either, and saying so before the ask is worth more than a run that
 * would only be refused.
 */
export function capabilityFor(intent: AssistantIntent): Capability {
  return mediaKindFor(intent) ?? "text";
}

/**
 * How much of the cards a turn is about travels with it.
 *
 * A ceiling rather than a refusal: the ask goes over one wire with a size it
 * cannot pass, and a canvas holding long text cards could ask for more than
 * that in a single question. What does not fit is left out and said, so the
 * reader hears that part of it stayed behind rather than watching a request
 * that never arrive.
 */
export const ASSISTANT_CONTEXT_CHARS = 24_000;

/**
 * How many pictures travel with one ask.
 *
 * Fewer than a canvas may hold, because every one of them is read by the model
 * it is sent to and paid for again, and a question asked of a whole board is
 * answered no better for the fortieth thumbnail than for the eighth.
 */
export const ASSISTANT_PICTURE_LIMIT = 8;

/**
 * How far back a question may be sent with what was said before it.
 *
 * Chosen rather than counted out, because the reader is the one who knows whether
 * the answer needs the earlier turns or only the cards: a conversation is a long
 * thing to send and every character of it is paid for again by the model that
 * reads it.
 */
export const HISTORY_CHOICES = [2, 4, 8] as const;

export type HistoryChoice = (typeof HISTORY_CHOICES)[number];

const HISTORY_WORDS: Record<AssistantRole, string> = {
  user: "You",
  assistant: "Assistant",
  error: "Trouble",
};

/**
 * The last few things said, oldest first, as the block a question travels with.
 *
 * Nothing at all unless it was asked for: a turn by itself carries the cards it
 * names and no memory of the turns before it, which is what keeps a long
 * conversation from growing the ask every time something is asked.
 */
export function earlierWords(
  lines: readonly AssistantMessage[],
  count: HistoryChoice | null,
): string {
  if (count === null) return "";
  const said: string[] = [];
  let room = ASSISTANT_CONTEXT_CHARS;
  for (let at = lines.length - 1; at >= 0 && said.length < count; at -= 1) {
    const line = lines[at];
    const words = line.text.trim();
    if (words === "") continue;
    const entry = `${HISTORY_WORDS[line.role]}: ${words}`;
    if (entry.length > room) break;
    room -= entry.length;
    said.unshift(entry);
  }
  if (said.length === 0) return "";
  return `Earlier in this conversation:\n${said.join("\n")}`;
}

/**
 * Everything that feeds the given cards, however far back it starts.
 *
 * Walked rather than read off the wires into a card, because a question about a
 * card at the end of a chain is a question about what the chain was built from.
 * What a generation takes is only the last step of it.
 */
export function upstreamOf(
  canvas: CanvasDocument,
  from: readonly NodeId[],
): NodeId[] {
  const feeds = new Map<NodeId, NodeId[]>();
  for (const edge of canvas.edges) {
    const list = feeds.get(edge.target.nodeId);
    if (list) list.push(edge.source.nodeId);
    else feeds.set(edge.target.nodeId, [edge.source.nodeId]);
  }

  const found: NodeId[] = [];
  const seen = new Set<NodeId>(from);
  const walking = [...from];
  for (let at = 0; at < walking.length; at += 1) {
    for (const source of feeds.get(walking[at]) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      found.push(source);
      walking.push(source);
    }
  }
  return found;
}

/**
 * The cards a turn is about: the ones chosen, everything feeding them, and
 * anything the question names by hand.
 *
 * Named last and taken all the same, so naming a card is a way of adding one
 * that the selection would never have reached.
 */
export function referenceNodes(
  canvas: CanvasDocument,
  chosen: readonly NodeId[],
  named: readonly NodeId[],
): WorkflowNode[] {
  const found: WorkflowNode[] = [];
  const seen = new Set<NodeId>();
  const take = (id: NodeId) => {
    if (seen.has(id)) return;
    const node = findNode(canvas, id);
    if (!node) return;
    seen.add(id);
    found.push(node);
  };

  const onCanvas = chosen.filter((id) => findNode(canvas, id) !== undefined);
  for (const id of onCanvas) take(id);
  for (const id of upstreamOf(canvas, onCanvas)) take(id);
  for (const id of named) take(id);
  return found;
}

/** The kinds a count is kept of: the ones that hold something to send. */
function countedKind(reference: AssistantReference): GroupKey | null {
  return GROUP_ORDER.find((kind) => kind === reference.kind) ?? null;
}

/**
 * One line saying what a turn is about, in counts a reader can take in.
 *
 * Counted from what the ask worked out rather than from the cards it was
 * pointed at, because a card holding nothing is about something and sends
 * nothing, and a line promising it would promise an answer it cannot bring.
 */
export function referenceSummary(
  references: readonly AssistantReference[],
): string {
  const counted = new Map<GroupKey, number>();
  for (const reference of references) {
    const kind = countedKind(reference);
    if (kind === null) continue;
    counted.set(kind, (counted.get(kind) ?? 0) + 1);
  }
  return GROUP_ORDER.filter((kind) => counted.has(kind))
    .map((kind) => `${counted.get(kind)} ${GROUP_LABELS[kind].toLowerCase()}`)
    .join(" · ");
}

/**
 * The question as it reads: what it named becomes the name of the card.
 *
 * The sentence keeps its shape, which cutting the tokens out would not — "what
 * is this doing" and "what is [Lantern] doing" ask different things. The name
 * is also what the block carrying that card is labelled with below, so the two
 * are tied together for whoever reads the ask.
 *
 * Nothing in what comes back points at an id. The cards a question was about
 * travel beside the line as references, which is what makes them a snapshot
 * rather than a pointer that can come loose.
 */
function readable(asked: string, names: ReadonlyMap<NodeId, string>): string {
  let words = "";
  let at = 0;
  for (const span of mentionSpans(asked)) {
    words += asked.slice(at, span.start);
    words += `[${names.get(span.nodeId) ?? "a card that is gone"}]`;
    at = span.end;
  }
  return `${words}${asked.slice(at)}`.trim();
}

/** What a turn is recorded as having asked, and about, either way it answers. */
interface AskAbout {
  /** The question as it reads, which is what the line recording it holds. */
  asked: string;
  /** The cards that travelled, as the line recording the turn remembers them. */
  references: AssistantReference[];
  /** Cards left behind because there was no room for them. */
  leftOut: number;
}

/** A turn answered by words, which are what goes down the ask wire. */
export type AssistantWordsAsk = AskAbout & {
  kind: null;
  request: GenerateRequest;
};

/**
 * A turn answered by a card on the canvas.
 *
 * No request, because nothing is sent in one message: the cards reach the
 * generation over the graph as wires, and the run built from the card is what
 * carries them.
 */
export type AssistantCardAsk = AskAbout & {
  kind: CardKind;
  request: null;
};

/**
 * What one turn sends, and what it will be recorded as having been about.
 *
 * The cards travel as themselves rather than as a description of themselves:
 * what a text card says is quoted, and what a picture card holds is named by
 * the asset already in the project, so no bytes are carried across the wire
 * twice and nothing is stored that was not stored already.
 */
export type AssistantAsk = AssistantWordsAsk | AssistantCardAsk;

const ANSWER_SYSTEM =
  "Answer from the cards given to you. Where they do not say, say that rather than filling the gap.";

const REWRITE_SYSTEM =
  "Send the text given to you back written again as the reader asked. Return only that text, with no heading and nothing said about it.";

export function askOf(
  intent: "answer" | "rewrite",
  nodes: readonly WorkflowNode[],
  asked: string,
  earlier?: string,
): AssistantWordsAsk;
export function askOf(
  intent: "image" | "video" | "audio",
  nodes: readonly WorkflowNode[],
  asked: string,
  earlier?: string,
): AssistantCardAsk;
export function askOf(
  intent: AssistantIntent,
  nodes: readonly WorkflowNode[],
  asked: string,
  earlier?: string,
): AssistantAsk;
export function askOf(
  intent: AssistantIntent,
  nodes: readonly WorkflowNode[],
  asked: string,
  earlier = "",
): AssistantAsk {
  const kind = mediaKindFor(intent);
  const names = new Map<NodeId, string>(
    nodes.map((node) => [node.id, node.title]),
  );
  const words = readable(asked, names);
  const blocks: string[] = [];
  const inputs: GenerateInput[] = [];
  const references: AssistantReference[] = [];
  let room = ASSISTANT_CONTEXT_CHARS;
  let media = 0;
  let leftOut = 0;

  for (const node of nodes) {
    const held = node.data as { assetId?: AssetId; content?: string };
    if (node.kind === "text") {
      const content = (held.content ?? "").trim();
      if (content === "") continue;
      if (kind === null) {
        const block = `[${node.title}]\n${content}`;
        if (block.length > room) {
          leftOut += 1;
          continue;
        }
        room -= block.length;
        blocks.push(block);
      }
      references.push({ nodeId: node.id, title: node.title, kind: node.kind });
      continue;
    }
    if (!held.assetId) continue;
    // Counted the same whichever way it travels: a picture is paid for again by
    // the model that reads it, whether it was quoted in a message or wired in.
    if (media >= ASSISTANT_PICTURE_LIMIT) {
      leftOut += 1;
      continue;
    }
    media += 1;
    if (kind === null) {
      inputs.push({ role: "reference", assetId: held.assetId });
    }
    references.push({
      nodeId: node.id,
      title: node.title,
      kind: node.kind,
      assetId: held.assetId,
    });
  }

  const context = blocks.join("\n\n");
  const about = { asked: words, references, leftOut };
  return kind === null
    ? {
        kind: null,
        request: {
          capability: "text",
          system: intent === "rewrite" ? REWRITE_SYSTEM : ANSWER_SYSTEM,
          prompt: [context, earlier, words]
            .filter((part) => part !== "")
            .join("\n\n---\n\n"),
          inputs,
        },
        ...about,
      }
    : { kind, request: null, ...about };
}
