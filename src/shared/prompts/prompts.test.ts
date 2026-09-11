import { describe, expect, it } from "vitest";

import {
  answerSystemPrompt,
  askPrompt,
  contextBlockPrompt,
  describeDefaultPrompt,
  describeFramingPrompt,
  historyLinePrompt,
  historyPrompt,
  rewriteSystemPrompt,
} from "./index";

/**
 * Every template is read here rather than only through the code that sends it,
 * so a template that does not parse, or one whose words drifted from what the
 * callers were written against, fails in one place instead of in whichever
 * dialog happened to be opened.
 */
describe("prompts", () => {
  it("answers from the cards and says so", () => {
    expect(answerSystemPrompt()).toBe(
      "Answer from the cards given to you. Where they do not say, say that rather than filling the gap.",
    );
  });

  it("asks a rewrite for the text and nothing around it", () => {
    expect(rewriteSystemPrompt()).toBe(
      "Send the text given to you back written again as the reader asked. Return only that text, with no heading and nothing said about it.",
    );
  });

  it("starts a description with a question a reader can change", () => {
    expect(describeDefaultPrompt()).toBe(
      "Describe this picture as the prompt that would make it.",
    );
  });

  it("frames a description as the words that would make the picture", () => {
    const framing = describeFramingPrompt();
    expect(framing).toContain("Answer with a description of the picture alone");
    expect(framing.endsWith("no mention of this request.")).toBe(true);
  });

  it("names who said a line of the conversation", () => {
    expect(historyLinePrompt("You", "what is that?")).toBe(
      "You: what is that?",
    );
    expect(historyLinePrompt("Assistant", "a lantern.")).toBe(
      "Assistant: a lantern.",
    );
  });

  it("carries the earlier turns under one heading", () => {
    expect(historyPrompt(["You: hi", "Assistant: hello"])).toBe(
      "Earlier in this conversation:\nYou: hi\nAssistant: hello",
    );
  });

  it("quotes a card under its title", () => {
    expect(contextBlockPrompt("Brief", "A lantern over a lake.")).toBe(
      "[Brief]\nA lantern over a lake.",
    );
  });

  it("puts the parts of a question in the order they are read", () => {
    expect(askPrompt(["cards", "earlier", "the ask"])).toBe(
      "cards\n\n---\n\nearlier\n\n---\n\nthe ask",
    );
  });

  it("leaves out a part there is nothing to say", () => {
    expect(askPrompt(["", "earlier", "the ask"])).toBe(
      "earlier\n\n---\n\nthe ask",
    );
    expect(askPrompt(["the ask"])).toBe("the ask");
    expect(askPrompt([])).toBe("");
  });

  it("writes a reader's own characters rather than a reference to them", () => {
    expect(contextBlockPrompt("Brief", "rock & roll <b>now</b>")).toBe(
      "[Brief]\nrock & roll <b>now</b>",
    );
  });

  it("carries no newline of its own", () => {
    for (const words of [
      answerSystemPrompt(),
      rewriteSystemPrompt(),
      describeDefaultPrompt(),
      describeFramingPrompt(),
      historyLinePrompt("You", "hi"),
      contextBlockPrompt("Brief", "words"),
    ]) {
      expect(words.endsWith("\n")).toBe(false);
    }
  });
});
