import {
  MAX_TEXT_CONTENT_LENGTH,
  createNode,
  findNode,
  type CanvasDocument,
  type MokaFile,
  type NodeId,
  type ResourceEntry,
  type RunId,
} from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { focusNode } from "../editor/canvas/canvasControl";
import { editTextContent } from "../editor/interactions/actions";
import { useEditorStore } from "../editor/stores/editorStore";
import { landingSpot } from "./cards";
import { titleFor } from "./conversation";

/**
 * What a line of a conversation can be done with.
 *
 * An answer is words until a reader says otherwise, so these are the ways to stop
 * it being words: a card of its own, a card already on the canvas written over,
 * the clipboard, a file. Each is one thing to undo where it touches the document
 * at all, and none of them writes a byte that was not already held.
 */

/**
 * The words an answer came back as, put on the canvas as a text card.
 *
 * A card of its own rather than a rewrite of the card the question was about:
 * what a model said is a draft, and writing it into the card something was asked
 * with would spend the ask to keep the answer.
 */
export function fileAnswer(
  canvas: CanvasDocument,
  words: string,
): NodeId | null {
  if (words.trim() === "") return null;
  const node = createNode("text", landingSpot(canvas), {
    title: titleFor(words),
  });
  node.data = { content: words.slice(0, MAX_TEXT_CONTENT_LENGTH) };
  if (
    !execute("Put an answer on the canvas", [
      { type: "addNode", canvasId: canvas.id, node },
    ])
  ) {
    return null;
  }
  // The new card rather than what the question was about: the words are what a
  // reader asked to have, and they are on this card.
  useEditorStore.getState().selectOnly(node.id);
  useEditorStore.getState().announce("An answer is on the canvas");
  return node.id;
}

/**
 * An answer written over the words one text card holds.
 *
 * Offered only for a text card: written over a picture, the answer would be the
 * one thing the picture had, and it was not asked to replace it.
 */
export function overwriteCard(nodeId: NodeId, words: string): void {
  editTextContent(nodeId, words.slice(0, MAX_TEXT_CONTENT_LENGTH));
}

/** The one text card a selection offers to have an answer written into it. */
export function overwriteTarget(
  canvas: CanvasDocument,
  chosen: readonly NodeId[],
): NodeId | null {
  if (chosen.length !== 1) return null;
  const node = findNode(canvas, chosen[0]);
  return node && node.kind === "text" ? node.id : null;
}

/**
 * Where the card an answer made is, for a reader who has moved on since.
 *
 * Said rather than shown when the card is gone, because a conversation is read
 * long after the canvas it was had on was changed: a card taken away leaves the
 * line that remembers it, and a reader following it back needs to hear that the
 * card is what is missing rather than the way to it.
 */
export function showOnCanvas(canvas: CanvasDocument, nodeId: NodeId): void {
  const editor = useEditorStore.getState();
  if (!findNode(canvas, nodeId)) {
    editor.announce("That card is not on this canvas any more");
    return;
  }
  editor.selectOnly(nodeId);
  focusNode(nodeId);
}

/**
 * Which run filed what, read out of the document's own record.
 *
 * The provenance says which run filed an asset, which is the only way back to a
 * picture once the card it was promoted onto has been taken away — the card is
 * what the conversation names, and the card is what gets deleted.
 *
 * Indexed once per document rather than looked up per line: a conversation may
 * remember dozens of runs and a project thousands of assets, and the panel that
 * shows them asks after every character typed.
 */
export function runsOfAssets(
  moka: MokaFile,
): Map<RunId, readonly ResourceEntry[]> {
  const byRun = new Map<RunId, ResourceEntry[]>();
  for (const entry of Object.values(moka.resources).flat()) {
    const runId = entry.provenance?.runId;
    if (!runId) continue;
    const filed = byRun.get(runId);
    if (filed) filed.push(entry);
    else byRun.set(runId, [entry]);
  }
  return byRun;
}

/**
 * An answer carried off to somewhere else, which is what a conversation with no
 * way to leave it is: a holding pen.
 */
export async function copyWords(words: string): Promise<void> {
  const editor = useEditorStore.getState();
  try {
    await navigator.clipboard.writeText(words);
    editor.announce("Copied");
  } catch {
    // The clipboard refuses for reasons the page cannot see — no permission, no
    // focus, another window holding it — so it is said, rather than left to be
    // read in a paragraph that looks as though it had been copied.
    editor.announce("The clipboard would not take it");
  }
}

/**
 * An answer as a file.
 *
 * A data URL rather than an object one: there is nothing to keep alive after the
 * click, and a blob URL outlives the anchor that was clicked to spend it.
 */
export function answerFile(words: string): { href: string; name: string } {
  return {
    href: `data:text/plain;charset=utf-8,${encodeURIComponent(words)}`,
    name: `${titleFor(words).replace(/[\\/:*?"<>|]/g, "")}.txt`,
  };
}
