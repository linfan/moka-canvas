import type {
  AssetId,
  CanvasDocument,
  GenerationSpec,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import { ASSET_KIND_LABELS, findNode } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import {
  mediaInfoForNode,
  type MediaCardInfo,
  type MediaState,
} from "./mediaCards";

/** How a mention is written into the document. */
const PREFIX = "@[node:";

/** How much of a text a candidate row shows. */
export const MENTION_SUMMARY_CHARS = 40;
/** How much of a text the card a chip summons shows. */
export const MENTION_HOVER_CHARS = 200;

/** What a mention is written as, which is the only form the resolver reads. */
export function mentionToken(nodeId: string): string {
  return `${PREFIX}${nodeId}]`;
}

/**
 * The mention a caret is in the middle of typing, or null when it is in prose.
 *
 * An `@` only offers candidates when it starts a word: one with something
 * unbroken before it is part of an address somebody was writing. Whitespace
 * after it ends the offer, and so does a closing bracket, because that mention
 * is finished and the caret behind it is back in the sentence.
 */
export function mentionBeingTyped(
  prompt: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) return null;
  const start = prompt.lastIndexOf("@", caret - 1);
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(prompt[start - 1])) return null;
  const typed = prompt.slice(start + 1, caret);
  if (/[\s\]]/.test(typed)) return null;
  return { start, query: typed };
}

/** Why a node is being offered: it feeds this one, it is named, or it is here. */
export type MentionOrigin = "upstream" | "reference" | "canvas";

export interface MentionChoice {
  node: WorkflowNode;
  origin: MentionOrigin;
  /** The node as a picture, when it holds one: a thumbnail, or a shot's poster. */
  media: MediaCardInfo | null;
  /** One line: the start of a text, or what the project measured about a media. */
  summary: string;
}

export interface MentionGroup {
  label: string;
  choices: MentionChoice[];
}

/** The order groups are read in: words first, then what they are about. */
export const GROUP_ORDER = [
  "text",
  "image",
  "video",
  "audio",
  "group",
] as const;

export type GroupKey = (typeof GROUP_ORDER)[number];

export const GROUP_LABELS: Record<GroupKey, string> = {
  text: ASSET_KIND_LABELS.text,
  image: ASSET_KIND_LABELS.image,
  video: ASSET_KIND_LABELS.video,
  audio: ASSET_KIND_LABELS.audio,
  group: "domain:nodeTitle.group",
};

/** A node offered as a candidate, and why it is being offered. */
export interface MentionWanted {
  id: string;
  origin: MentionOrigin;
}

/** A sentence's first line, cut to a length that fits one row. */
function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function membersOf(canvas: CanvasDocument, node: WorkflowNode): string[] {
  return (
    canvas.groups.find((group) => group.groupId === node.id)?.childNodeIds ?? []
  );
}

/**
 * Whether a node holds anything worth mentioning.
 *
 * An empty one is left out rather than offered and then quietly sending nothing:
 * a candidate that answers with silence reads as a picker that is broken.
 */
function holds(canvas: CanvasDocument, node: WorkflowNode): boolean {
  const data = node.data as { assetId?: string; content?: string };
  switch (node.kind) {
    case "text":
      return (data.content ?? "").trim() !== "";
    case "image":
    case "audio":
    case "video":
      return Boolean(data.assetId);
    case "group":
      return membersOf(canvas, node).length > 0;
    default:
      return false;
  }
}

function groupOf(canvas: CanvasDocument, node: WorkflowNode): GroupKey | null {
  if (!holds(canvas, node)) return null;
  if (node.kind === "group") return "group";
  const capability = node.kind as GroupKey;
  return GROUP_ORDER.includes(capability) ? capability : null;
}

function summaryFor(
  canvas: CanvasDocument,
  node: WorkflowNode,
  media: MediaCardInfo | null,
): string {
  const data = node.data as { content?: string };
  if (node.kind === "text") {
    return oneLine(data.content ?? "", MENTION_SUMMARY_CHARS);
  }
  if (node.kind === "group") {
    const count = membersOf(canvas, node).length;
    return count === 1
      ? i18n.t("editor:counts.nodesInsideOne", { count })
      : i18n.t("editor:counts.nodesInsideMany", { count });
  }
  return media?.label ?? media?.entry?.name ?? "";
}

/**
 * The listed nodes as candidate rows, grouped by the kind of thing each is.
 *
 * Offered in the order the list was given, and a node listed twice is offered
 * once as the nearer of the two, since being asked twice for the same card is
 * noise rather than emphasis.
 */
export function mentionGroups(
  canvas: CanvasDocument,
  wanted: readonly MentionWanted[],
  resources: ReadonlyMap<AssetId, ResourceEntry>,
  issues: ReadonlyMap<AssetId, MediaState>,
): MentionGroup[] {
  const grouped = new Map<GroupKey, MentionChoice[]>();
  const seen = new Set<string>();
  for (const { id, origin } of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const found = findNode(canvas, id);
    if (!found) continue;
    const key = groupOf(canvas, found);
    if (!key) continue;
    const media = mediaInfoForNode(found, resources, issues);
    const choices = grouped.get(key);
    const choice: MentionChoice = {
      node: found,
      origin,
      media,
      summary: summaryFor(canvas, found, media),
    };
    if (choices) choices.push(choice);
    else grouped.set(key, [choice]);
  }

  return GROUP_ORDER.filter((key) => grouped.has(key)).map((key) => ({
    label: i18n.t(GROUP_LABELS[key]),
    choices: grouped.get(key) ?? [],
  }));
}

/**
 * What may be mentioned from this node, grouped by the kind of thing it is.
 *
 * Offered in the order a reader would look: what is wired into the node first,
 * then what it was pointed at by hand, then everything else on the canvas that
 * holds something. The node itself is not among them, since a card that mentions
 * itself is asking for what it already says.
 */
export function mentionChoices(
  canvas: CanvasDocument,
  node: WorkflowNode,
  resources: ReadonlyMap<AssetId, ResourceEntry>,
  issues: ReadonlyMap<AssetId, MediaState>,
): MentionGroup[] {
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  const wanted: MentionWanted[] = [];
  const seen = new Set<string>([node.id]);
  const take = (id: string, origin: MentionOrigin) => {
    if (seen.has(id)) return;
    seen.add(id);
    wanted.push({ id, origin });
  };

  for (const edge of canvas.edges) {
    if (edge.target.nodeId === node.id) take(edge.source.nodeId, "upstream");
  }
  for (const id of spec?.referenceNodeIds ?? []) take(id, "reference");
  for (const other of canvas.nodes) take(other.id, "canvas");

  return mentionGroups(canvas, wanted, resources, issues);
}

/** The groups that answer to what has been typed since the `@`. */
export function narrowMentions(
  groups: MentionGroup[],
  query: string,
): MentionGroup[] {
  const asked = query.trim().toLowerCase();
  if (asked === "") return groups;
  return groups
    .map((group) => ({
      ...group,
      choices: group.choices.filter(
        (choice) =>
          choice.node.title.toLowerCase().includes(asked) ||
          choice.summary.toLowerCase().includes(asked),
      ),
    }))
    .filter((group) => group.choices.length > 0);
}
