import { isApiError } from "../../api";
import type {
  AssistantMessage,
  AssistantReference,
  AssistantSession,
  ProblemCode,
} from "../../shared/domain";
import { PROBLEM_CODES, newId } from "../../shared/domain";

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
        : "The answer did not arrive.",
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
    text: "Stopped before anything arrived.",
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
