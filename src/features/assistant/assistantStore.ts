import { create } from "zustand";
import { generateApi } from "../../api";
import type {
  AssistantMessage,
  CanvasDocument,
  DocumentCommand,
  NodeId,
} from "../../shared/domain";
import { mentionNodeIds, newId, nowIso } from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { useEditorStore } from "../editor/stores/editorStore";
import { askOf, referenceNodes, type AssistantIntent } from "./asking";
import {
  latestSession,
  lineAsked,
  lineCutShort,
  lineFailed,
  lineSaid,
  titleFor,
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

  setIntent: (intent: AssistantIntent) => void;
  setDraft: (draft: string) => void;
  ask: (about: {
    canvas: CanvasDocument;
    chosen: readonly NodeId[];
  }) => Promise<void>;
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

/**
 * Writes a finished turn to the document, as one thing to undo.
 *
 * A first turn starts the conversation it is the first of and is named after
 * what was asked, so a conversation is never in the document with nothing in
 * it: taking back the turn that started one takes the conversation with it.
 */
function keep(
  canvas: CanvasDocument,
  question: AssistantMessage,
  answer: AssistantMessage,
): void {
  const lines = [question, answer];
  const carrying = latestSession(canvas.sessions ?? []);
  const command: DocumentCommand = carrying
    ? {
        type: "appendMessages",
        canvasId: canvas.id,
        sessionId: carrying.id,
        messages: lines,
      }
    : {
        type: "addSession",
        canvasId: canvas.id,
        session: {
          id: newId(),
          title: titleFor(question.text),
          messages: lines,
          createdAt: question.createdAt,
          updatedAt: answer.createdAt,
        },
      };
  execute("Ask the assistant", [command]);
}

export const useAssistantStore = create<AssistantState>()((set, get) => ({
  intent: "answer",
  draft: "",
  asking: null,
  saying: "",
  busy: false,

  setIntent: (intent) => set({ intent }),
  setDraft: (draft) => set({ draft }),

  ask: async ({ canvas, chosen }) => {
    // One turn at a time: a second ask sent while an answer is arriving would
    // be written into the conversation before the one it interrupted, and read
    // as an answer to the wrong question.
    if (going !== null) return;
    const { intent, draft } = get();
    if (draft.trim() === "") return;

    const nodes = referenceNodes(canvas, chosen, mentionNodeIds(draft));
    const ask = askOf(intent, nodes, draft);
    const question = lineAsked(ask.asked, ask.references, nowIso());

    const controller = new AbortController();
    going = controller;
    set({ busy: true, asking: ask.asked, saying: "", draft: "" });
    let said = "";
    let answer: AssistantMessage;
    try {
      const response = await generateApi.textStream(
        ask.request,
        (piece) => {
          said += piece;
          set({ saying: said });
        },
        controller.signal,
      );
      // What is kept is the whole answer rather than the pieces it was shown
      // as, so the closing frame's is taken where it brings one.
      answer = lineSaid(response.text ?? said, nowIso());
    } catch (error) {
      answer = controller.signal.aborted
        ? lineCutShort(said, nowIso())
        : lineFailed(error, nowIso());
    } finally {
      going = null;
      set({ busy: false, asking: null, saying: "" });
    }

    if (controller.signal.aborted && answer.role === "assistant") {
      useEditorStore.getState().announce("Stopped. What had arrived was kept.");
    }
    keep(canvas, question, answer);
  },

  stop: () => going?.abort(),
}));
