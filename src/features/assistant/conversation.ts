import { isApiError } from "../../api";
import type {
  AssistantMessage,
  AssistantReference,
  AssistantSession,
  AssistantToolCall,
  CanvasDocument,
  NodeId,
  ProblemCode,
  RunId,
  SessionId,
} from "../../shared/domain";
import { PROBLEM_CODES, newId } from "../../shared/domain";
import { i18n } from "../../shared/i18n";

/**
 * How much of a first question becomes the conversation's name.
 *
 * Well under the length a title may be, because a name is read in a list of
 * them rather than in a document, and a list of first sentences in full is a
 * list nobody can pick from.
 */
const TITLE_CHARS = 60;

/**
 * The conversation to carry on with: the one something was last said in.
 *
 * Found by when rather than by place, since the list is not kept in any order
 * that means anything: a conversation put back by an undo lands where the undo
 * puts it, and the one a reader expects to open onto is the one they were just
 * talking in.
 */
export function latestSession(
  sessions: readonly AssistantSession[],
): AssistantSession | null {
  let newest: AssistantSession | null = null;
  for (const session of sessions) {
    if (newest === null || session.updatedAt > newest.updatedAt) {
      newest = session;
    }
  }
  return newest;
}

/** What a conversation is called once it starts: the first of what was asked. */
export function titleFor(asked: string): string {
  const line = asked.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
}

/**
 * Which conversation a canvas is being read at.
 *
 * "newest" is the one something was last said in, which is where a canvas is
 * found from its tabs; an id is one picked out of a list, since a conversation
 * kept is something to go back to rather than only to carry on; and "fresh" is
 * one that has not been written yet, asked for by a reader who wants to say
 * something that is not part of what went before.
 */
export type ShownSession = SessionId | "newest" | "fresh";

/**
 * The conversation on show, or null when there is nothing to show.
 *
 * An id naming a conversation that has since been removed reads as the newest
 * again rather than as nothing, because the removal is what it was: the reader
 * did not ask to stop seeing conversations, only to stop seeing that one.
 */
export function sessionShown(
  canvas: CanvasDocument,
  shown: ShownSession,
): AssistantSession | null {
  if (shown === "fresh") return null;
  if (shown === "newest") return latestSession(canvas.sessions ?? []);
  return (
    (canvas.sessions ?? []).find((session) => session.id === shown) ??
    latestSession(canvas.sessions ?? [])
  );
}

/** The conversation a turn is written to, and whether the turn opens it. */
export interface SessionTarget {
  id: SessionId;
  opening: boolean;
}

/**
 * Which conversation this turn belongs to.
 *
 * Settled before the turn is had, because a card asked on a conversation's
 * behalf is filed with its id and has to be filed with the id the turn will
 * itself be kept under — which, for a first turn, does not exist yet. Making the
 * id here is what lets the two agree on it.
 */
export function sessionTarget(
  canvas: CanvasDocument,
  shown: ShownSession,
): SessionTarget {
  const carrying = sessionShown(canvas, shown);
  return carrying
    ? { id: carrying.id, opening: false }
    : { id: newId(), opening: true };
}

/** The line that records what was asked, and what it was asked about. */
export function lineAsked(
  asked: string,
  references: readonly AssistantReference[],
  at: string,
): AssistantMessage {
  return {
    id: newId(),
    role: "user",
    text: asked,
    createdAt: at,
    ...(references.length > 0 ? { references: [...references] } : {}),
  };
}

/** The line that records an answer that arrived. */
export function lineSaid(said: string, at: string): AssistantMessage {
  return { id: newId(), role: "assistant", text: said, createdAt: at };
}

/**
 * The line that records what a run made, or the trouble it ran into.
 *
 * The run is named on the line beside what came of it, because a paid ask that
 * failed is asked again from where it stands: the card it was for is already on
 * the canvas, and the record already holds what it was asked for. A line that
 * said only that nothing arrived loses both of those.
 */
export function lineFromRun(options: {
  summary: string;
  runId: RunId;
  nodeId: NodeId;
  at: string;
  failure?: { message: string; code: ProblemCode; retryable: boolean };
}): AssistantMessage {
  const call: AssistantToolCall = {
    runId: options.runId,
    nodeId: options.nodeId,
    summary: options.summary,
  };
  const trouble = options.failure;
  if (!trouble) {
    return {
      id: newId(),
      role: "assistant",
      text: options.summary,
      createdAt: options.at,
      toolCalls: [call],
    };
  }
  return {
    id: newId(),
    role: "error",
    text: trouble.message,
    createdAt: options.at,
    failure: { code: trouble.code, retryable: trouble.retryable },
    toolCalls: [call],
  };
}

/**
 * The line that records an answer that did not.
 *
 * A line rather than a toast, because what went wrong is part of the
 * conversation: a reader coming back to it later has to be able to see that
 * this question was asked and nothing came, and asking again is offered from
 * the line that says so.
 */
export function lineFailed(error: unknown, at: string): AssistantMessage {
  const code = isApiError(error) ? error.code : "PROVIDER_UNAVAILABLE";
  return {
    id: newId(),
    role: "error",
    text:
      error instanceof Error && error.message !== ""
        ? error.message
        : i18n.t("assistant:failure.noAnswer"),
    createdAt: at,
    failure: {
      code: problemOf(code),
      // A stream carries whether asking again could work in the frame that
      // closes it; anything else that went wrong is not known to be transient,
      // so it is not offered as though it were.
      retryable: isApiError(error) && error.details?.retryable === true,
    },
  };
}

/**
 * The line that records an answer somebody stopped.
 *
 * What had arrived is kept as an answer, because it was one as far as it went
 * and throwing it away would lose words the reader asked for and paid for. Only
 * a turn stopped before anything came is a failure, and that is the one offered
 * a retry: asking again for an answer that is already partly here would spend
 * twice for the same thing.
 */
export function lineCutShort(said: string, at: string): AssistantMessage {
  if (said.trim() !== "") return lineSaid(said, at);
  return {
    id: newId(),
    role: "error",
    text: i18n.t("assistant:failure.stoppedEarly"),
    createdAt: at,
    failure: { code: "GENERATION_CANCELLED", retryable: true },
  };
}

/**
 * The document's own word for what went wrong.
 *
 * An ask can fail before it reaches a provider, in a way no provider's list of
 * troubles covers, and a line that said so in a word the document does not have
 * would not be readable back. The nearest word it has is used instead.
 */
function problemOf(code: string): ProblemCode {
  return (PROBLEM_CODES as readonly string[]).includes(code)
    ? (code as ProblemCode)
    : "PROVIDER_UNAVAILABLE";
}
