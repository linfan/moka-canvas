/**
 * The words this client asks a model with, kept out of the code that sends them.
 *
 * A prompt written into a component is a sentence nobody thinks to look for when
 * the answer coming back is wrong, and one kept under `shared/prompts/` is a file
 * a reader can open, change, and read again without first finding the place that
 * happens to send it. Each one is imported as raw text, so the words a build asks
 * with are the words that build was tested with: nothing is fetched at runtime,
 * and a prompt cannot depend on a network that has nothing to do with it.
 *
 * The Rust side keeps its own set under `src-tauri/prompts/`, embedded into the
 * binary the same way. The two deliberately do not share files. They are built by
 * different tools into different artifacts, and a template that had to cross that
 * boundary would need a server running to be readable at all.
 */
import { Environment } from "nunjucks";

import ask from "./assistant/ask.tmpl?raw";
import answerSystem from "./assistant/answer-system.tmpl?raw";
import contextBlock from "./assistant/context-block.tmpl?raw";
import history from "./assistant/history.tmpl?raw";
import historyLine from "./assistant/history-line.tmpl?raw";
import rewriteSystem from "./assistant/rewrite-system.tmpl?raw";
import describeFraming from "./editor/describe-framing.tmpl?raw";
import describeDefault from "./editor/describe-default.tmpl?raw";

/**
 * The engine, configured once.
 *
 * Autoescaping is off because a prompt is plain words rather than a page: text
 * quoted into one has to arrive as it was written, and a reader's ampersand or
 * angle bracket turned into a character reference would be asking for something
 * else. Nothing rendered here is ever written into HTML, which is the only thing
 * escaping would have protected.
 */
const engine = new Environment(null, { autoescape: false });

/**
 * One template's words, with `values` filling the holes in them.
 *
 * A value the template does not name is ignored, and one the template names and
 * `values` does not carry is written as nothing: a hole in a prompt is a thing a
 * reader can see in the answer, and a question that never got asked is not.
 *
 * A template that does not parse throws. These are part of the build, so that is
 * a fault in the build and is not papered over here; the tests beside this file
 * read every one of them.
 */
function render(source: string, values: Record<string, unknown>): string {
  // A file that ends with a line break is what an editor writes and what a reader
  // expects to see. A newline at the end of a prompt is neither.
  return engine.renderString(source.replace(/\n$/, ""), values);
}

/**
 * What an ask is told about the cards it was given.
 *
 * A standing instruction rather than a per-question one, and the reason an ask
 * that cannot find an answer says so instead of filling the gap.
 */
export function answerSystemPrompt(): string {
  return render(answerSystem, {});
}

/**
 * What a rewrite is told, which is narrower on purpose: the text comes back and
 * nothing else, because it is going onto a card rather than into a conversation.
 */
export function rewriteSystemPrompt(): string {
  return render(rewriteSystem, {});
}

/**
 * The question a "describe this picture" dialog starts with, which a reader can
 * change before sending it.
 */
export function describeDefaultPrompt(): string {
  return render(describeDefault, {});
}

/**
 * How the answer to that question is framed.
 *
 * Sent beside it rather than left to the standing instruction for written
 * answers, which says how to be answered in general: this ask wants one
 * particular thing, words a picture could be made from and nothing around them.
 * A description that arrives wrapped in an announcement of itself has to be
 * unwrapped by hand before it is any use as a prompt.
 */
export function describeFramingPrompt(): string {
  return render(describeFraming, {});
}

/**
 * One line of a conversation, named for who said it.
 *
 * Rendered one line at a time rather than as part of the block because what fits
 * inside the budget is measured before anything is sent, and measuring the
 * rendered line is the only way the measure and the message can agree.
 */
export function historyLinePrompt(speaker: string, text: string): string {
  return render(historyLine, { speaker, text });
}

/**
 * The last few things said, as the block a question travels with.
 *
 * The lines arrive already composed by {@link historyLinePrompt}, oldest first.
 */
export function historyPrompt(lines: readonly string[]): string {
  return render(history, { lines });
}

/** One card's text, quoted under the title it is read by. */
export function contextBlockPrompt(title: string, content: string): string {
  return render(contextBlock, { title, content });
}

/**
 * The parts of a question, in the order they are read: what the cards say, what
 * was said before, and what is being asked now.
 *
 * The empties are dropped before they arrive rather than inside the template, so
 * a question asked with no cards and no memory does not travel with two
 * separators and nothing between them.
 */
export function askPrompt(parts: readonly string[]): string {
  return render(ask, { parts: parts.filter((part) => part !== "") });
}
