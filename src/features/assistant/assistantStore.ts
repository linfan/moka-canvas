import { create } from "zustand";
import { generateApi } from "../../api";
import type {
  AssistantMessage,
  CanvasDocument,
  CanvasId,
  DocumentCommand,
  NodeId,
  NodeKind,
  RunId,
  SessionId,
  WorkflowNode,
} from "../../shared/domain";
import {
  MAX_ASSISTANT_TITLE_LENGTH,
  mentionNodeIds,
  nowIso,
} from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { useEditorStore } from "../editor/stores/editorStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { untilRunEnds, useRunStore } from "../editor/stores/runStore";
import {
  askOf,
  earlierWords,
  referenceNodes,
  type AssistantCardAsk,
  type AssistantIntent,
  type AssistantWordsAsk,
  type HistoryChoice,
} from "./asking";
import { madeWords, planCard } from "./cards";
import {
  lineAsked,
  lineCutShort,
  lineFailed,
  lineFromRun,
  lineSaid,
  sessionShown,
  sessionTarget,
  titleFor,
  type SessionTarget,
  type ShownSession,
} from "./conversation";

/**
 * The turn being had, which is in no document until it is over.
 *
 * A question on its way to an answer is a draft of a line rather than one. Held
 * here, the words cost nothing and a turn is written down once, when there is a
 * turn to keep; written as it went, a single answer would be a hundred saves
 * and a hundred things to undo, and one stopped halfway would have left its
 * halves in the document behind it.
 */
interface AssistantState {
  intent: AssistantIntent;
  /** What is typed, which becomes a line only when it is asked. */
  draft: string;
  /** The question on its way, so the answer arriving has something above it. */
  asking: string | null;
  /** What has arrived of the answer so far. */
  saying: string;
  busy: boolean;
  /**
   * Which conversation the panel is reading.
   *
   * Held here rather than worked out from the document each time, because which
   * one a reader is looking at is something they chose and is not written
   * anywhere in the project: a canvas switched back to goes to the conversation
   * something was last said in, but one picked out of a list stays picked.
   */
  shown: ShownSession;
  /**
   * How many earlier lines travel with a question, or null when they do not.
   *
   * Nothing is sent by default: a conversation is long, and every character of it
   * is paid for again by the model reading the ask, so the memory of a turn is
   * something a reader asks for rather than something they are given.
   */
  history: HistoryChoice | null;

  setIntent: (intent: AssistantIntent) => void;
  setDraft: (draft: string) => void;
  setHistory: (count: HistoryChoice | null) => void;
  show: (shown: ShownSession) => void;
  rename: (canvas: CanvasDocument, sessionId: SessionId, title: string) => void;
  remove: (canvas: CanvasDocument, sessionId: SessionId) => void;
  removeEvery: (canvas: CanvasDocument) => void;
  ask: (about: {
    canvas: CanvasDocument;
    chosen: readonly NodeId[];
  }) => Promise<void>;
  /**
   * Asks the card a line named to do its work over, and keeps only the answer.
   *
   * The question is already in the conversation and the card is already on the
   * canvas, so a retry writes one line rather than a whole turn: repeating the
   * ask would put a second card where one already stands and pay for it.
   */
  retry: (
    canvas: CanvasDocument,
    sessionId: SessionId,
    line: AssistantMessage,
  ) => Promise<void>;
  stop: () => void;
}

/**
 * The turn going, if one is.
 *
 * Kept beside the state rather than in it because nothing renders it: what the
 * panel shows is that a turn is going, and the handle that stops it is reached
 * for only by the control that does.
 */
let going: AbortController | null = null;

/** The run a card ask is waiting on, which is stopped rather than abandoned. */
let goingRun: RunId | null = null;

/** How many lines a conversation holds in the document as it now stands. */
function lineCount(canvasId: CanvasId, sessionId: SessionId): number | null {
  const canvas = useProjectStore
    .getState()
    .moka?.canvas.find((entry) => entry.id === canvasId);
  const session = (canvas?.sessions ?? []).find(
    (entry) => entry.id === sessionId,
  );
  return session ? session.messages.length : null;
}

/**
 * Writes what a turn ended with to the document, as one thing to undo.
 *
 * A first turn starts the conversation it is the first of and is named after
 * what was asked, so a conversation is never in the document with nothing in
 * it: taking back the turn that started one takes the conversation with it.
 *
 * What the write cost is read out of the document rather than worked out from a
 * limit, because the turn could be the one that pushed a conversation past the
 * length it is kept to and lost its oldest lines with nobody having asked them
 * to go.
 */
function keep(
  canvas: CanvasDocument,
  target: SessionTarget,
  label: string,
  lines: readonly [AssistantMessage, ...AssistantMessage[]],
): void {
  const before = target.opening ? null : lineCount(canvas.id, target.id);
  const first = lines[0];
  const last = lines[lines.length - 1];
  const command: DocumentCommand = target.opening
    ? {
        type: "addSession",
        canvasId: canvas.id,
        session: {
          id: target.id,
          title: titleFor(first.text),
          messages: [...lines],
          createdAt: first.createdAt,
          updatedAt: last.createdAt,
        },
      }
    : {
        type: "appendMessages",
        canvasId: canvas.id,
        sessionId: target.id,
        messages: [...lines],
      };
  if (!execute(label, [command])) return;
  if (before === null) return;
  const lost = before + lines.length - (lineCount(canvas.id, target.id) ?? 0);
  if (lost > 0) {
    const words =
      lost === 1
        ? "1 old line let go to keep the conversation readable. Undo brings it back."
        : `${lost} old lines let go to keep the conversation readable. Undo brings them back.`;
    useEditorStore.getState().announce(words);
  }
}

/**
 * The line a run is recorded as having said, once it has ended.
 *
 * Shared by the ask that made the run and the one that asked for it again, so
 * both answer in the same words about the same card, and neither reads as a
 * different kind of turn from the other.
 */
async function lineOfRun(options: {
  runId: RunId;
  nodeId: NodeId;
  kind: NodeKind;
}): Promise<AssistantMessage> {
  const { runId, nodeId, kind } = options;
  const settled = await untilRunEnds(runId);
  // The record says a run is over before the document it changed does: what a
  // run made arrives by the server rewriting it, and a turn written onto the
  // reading that is on its way out would be replaced by it a moment later.
  await useProjectStore.getState().untilAdopted();
  const step = settled?.steps.find((entry) => entry.nodeId === nodeId);
  const summary = madeWords(kind, step?.outputAssetIds?.length ?? 0);
  if (settled?.status === "succeeded") {
    return lineFromRun({ summary, runId, nodeId, at: nowIso() });
  }
  const stopped = settled?.status === "cancelled";
  return lineFromRun({
    summary,
    runId,
    nodeId,
    at: nowIso(),
    failure: {
      message: stopped
        ? "Stopped. The card is on the canvas to ask again."
        : (step?.error ??
          settled?.error ??
          "The card did not come back with anything."),
      code: stopped ? "GENERATION_CANCELLED" : "PROVIDER_UNAVAILABLE",
      // A run that did not finish is asked again from the record, which is
      // what the line names, so nothing is spent twice by accident.
      retryable: true,
    },
  });
}

/**
 * A turn that asks a card for something, rather than asking for words.
 *
 * The card goes on the canvas first and the conversation is written last, which
 * makes the turn two undo steps rather than one: taking the conversation back
 * should not quietly delete a picture somebody paid for, and a card left behind
 * by an answer that did not arrive is where the ask can be made again by hand.
 *
 * Only the cards that reached the new one by a wire are recorded as what the
 * turn was about. A card that was named and never plugged in contributed
 * nothing to what came back, and a line claiming it did would be describing an
 * ask that did not happen.
 */
async function answerByCard(options: {
  canvas: CanvasDocument;
  nodes: readonly WorkflowNode[];
  ask: AssistantCardAsk;
  sessionId: SessionId;
}): Promise<{ question: AssistantMessage; answer: AssistantMessage }> {
  const { canvas, nodes, ask, sessionId } = options;
  const byId = new Map<NodeId, WorkflowNode>(
    nodes.map((node) => [node.id, node]),
  );
  const plan = planCard({
    canvas,
    kind: ask.kind,
    title: titleFor(ask.asked),
    asked: ask.asked,
    sources: ask.references.flatMap((reference) => {
      const node = byId.get(reference.nodeId);
      return node ? [node] : [];
    }),
  });
  const wired = new Set<NodeId>(plan.wired);
  const question = lineAsked(
    ask.asked,
    ask.references.filter((reference) => wired.has(reference.nodeId)),
    nowIso(),
  );
  if (!execute("Ask for a card", plan.commands)) {
    return {
      question,
      answer: lineFailed(
        new Error("The canvas would not take the card."),
        nowIso(),
      ),
    };
  }

  let runId: RunId;
  try {
    // A run is served from the document on disk, so the card it is to drive is
    // saved before it is asked to do anything.
    await useProjectStore.getState().flush();
    runId = (
      await useRunStore.getState().start(canvas.id, [plan.nodeId], sessionId)
    ).id;
    goingRun = runId;
  } catch (error) {
    return { question, answer: lineFailed(error, nowIso()) };
  }

  return {
    question,
    answer: await lineOfRun({ runId, nodeId: plan.nodeId, kind: ask.kind }),
  };
}

/**
 * A turn answered by words, read out as they arrive.
 *
 * What is kept is the whole answer rather than the pieces it was shown as, so
 * the closing frame's is taken where it brings one.
 */
async function answerInWords(
  ask: AssistantWordsAsk,
  controller: AbortController,
  onSaid: (words: string) => void,
): Promise<{ question: AssistantMessage; answer: AssistantMessage }> {
  const question = lineAsked(ask.asked, ask.references, nowIso());
  let said = "";
  let answer: AssistantMessage;
  try {
    const response = await generateApi.textStream(
      ask.request,
      (piece) => {
        said += piece;
        onSaid(said);
      },
      controller.signal,
    );
    answer = lineSaid(response.text ?? said, nowIso());
  } catch (error) {
    answer = controller.signal.aborted
      ? lineCutShort(said, nowIso())
      : lineFailed(error, nowIso());
  }
  if (controller.signal.aborted && answer.role === "assistant") {
    useEditorStore.getState().announce("Stopped. What had arrived was kept.");
  }
  return { question, answer };
}

export const useAssistantStore = create<AssistantState>()((set, get) => ({
  intent: "answer",
  draft: "",
  asking: null,
  saying: "",
  busy: false,
  shown: "newest",
  history: null,

  setIntent: (intent) => set({ intent }),
  setDraft: (draft) => set({ draft }),
  setHistory: (count) => set({ history: count }),
  show: (shown) => set({ shown }),

  rename: (canvas, sessionId, title) => {
    const name = title.trim().slice(0, MAX_ASSISTANT_TITLE_LENGTH);
    const held = (canvas.sessions ?? []).find(
      (session) => session.id === sessionId,
    );
    if (!held || name === "" || name === held.title) return;
    execute("Rename conversation", [
      { type: "renameSession", canvasId: canvas.id, sessionId, title: name },
    ]);
  },

  remove: (canvas, sessionId) => {
    const held = (canvas.sessions ?? []).find(
      (session) => session.id === sessionId,
    );
    if (!held) return;
    const lines = held.messages.length;
    if (
      lines > 0 &&
      !window.confirm(
        `Delete “${held.title}” and its ${lines} ${lines === 1 ? "line" : "lines"}?`,
      )
    ) {
      return;
    }
    execute("Remove conversation", [
      { type: "removeSession", canvasId: canvas.id, sessionId },
    ]);
  },

  removeEvery: (canvas) => {
    const sessions = canvas.sessions ?? [];
    if (sessions.length === 0) return;
    const lines = sessions.reduce(
      (total, session) => total + session.messages.length,
      0,
    );
    const many = sessions.length === 1 ? "conversation" : "conversations";
    if (
      !window.confirm(
        `Delete all ${sessions.length} ${many} and their ${lines} ${lines === 1 ? "line" : "lines"}?`,
      )
    ) {
      return;
    }
    // One thing to undo, so a clear meant as a sweep cannot half-happen: a
    // conversation put back on its own would be one the reader had said go.
    execute(
      "Remove conversations",
      sessions.map((session) => ({
        type: "removeSession",
        canvasId: canvas.id,
        sessionId: session.id,
      })),
    );
  },

  ask: async ({ canvas, chosen }) => {
    // One turn at a time: a second ask sent while an answer is arriving would
    // be written into the conversation before the one it interrupted, and read
    // as an answer to the wrong question.
    if (going !== null) return;
    const { intent, draft, shown, history } = get();
    if (draft.trim() === "") return;

    const nodes = referenceNodes(canvas, chosen, mentionNodeIds(draft));
    const earlier = earlierWords(
      sessionShown(canvas, shown)?.messages ?? [],
      history,
    );
    const ask = askOf(intent, nodes, draft, earlier);
    const target = sessionTarget(canvas, shown);

    const controller = new AbortController();
    going = controller;
    set({ busy: true, asking: ask.asked, saying: "", draft: "" });

    try {
      const turn =
        ask.kind === null
          ? await answerInWords(ask, controller, (words) =>
              set({ saying: words }),
            )
          : await answerByCard({ canvas, nodes, ask, sessionId: target.id });
      keep(canvas, target, "Ask the assistant", [turn.question, turn.answer]);
      // A conversation the turn opened is one the reader is now in: left
      // unnamed, the next turn would open a second one beside it.
      if (target.opening) set({ shown: target.id });
    } finally {
      going = null;
      goingRun = null;
      set({ busy: false, asking: null, saying: "" });
    }
  },

  retry: async (canvas, sessionId, line) => {
    if (going !== null) return;
    const made = line.toolCalls?.[0];
    const nodeId = made?.nodeId;
    if (!made || !nodeId) return;
    const card = canvas.nodes.find((node) => node.id === nodeId);
    if (!card) {
      useEditorStore
        .getState()
        .announce("The card that answer named is no longer on the canvas.");
      return;
    }
    // Saying what is paid for again, because the card was not: it is the making
    // that failed, and the ask that failed with it is still in this conversation.
    if (
      !window.confirm(
        `Ask “${card.title}” to make it again? The card is already on the canvas, so only the making is paid for.`,
      )
    ) {
      return;
    }

    const controller = new AbortController();
    going = controller;
    set({ busy: true });
    try {
      const record = await useRunStore.getState().retry(made.runId);
      goingRun = record.id;
      const answer = await lineOfRun({
        runId: record.id,
        nodeId,
        kind: card.kind,
      });
      // Only the answer: the question was kept the first time and is still the
      // line above, and a second copy of it would read as a second ask.
      keep(canvas, { id: sessionId, opening: false }, "Ask the card again", [
        answer,
      ]);
    } catch {
      // The run layer has already said why the retry was refused. Writing a line
      // about it would be two failures for one ask that never started.
    } finally {
      going = null;
      goingRun = null;
      set({ busy: false });
    }
  },

  stop: () => {
    // A card is asked of a run, which has to be told to give up: aborting the
    // ask would only stop the waiting, and the generation would go on being
    // paid for behind a panel that had stopped looking.
    if (goingRun !== null) void useRunStore.getState().cancel(goingRun);
    going?.abort();
  },
}));
