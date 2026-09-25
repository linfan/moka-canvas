import { describe, expect, it } from "vitest";

import { parseStoryJson } from "./json";

describe("reading json out of an answer", () => {
  it("takes the block a model fenced for it", () => {
    const answer = 'Here is the board:\n\n```json\n{ "acts": [] }\n```\n';
    const read = parseStoryJson(answer);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual({ acts: [] });
  });

  it("reads a block with no language on the fence", () => {
    const read = parseStoryJson('```\n{ "title": "雨" }\n```');
    expect(read.ok && read.value).toEqual({ title: "雨" });
  });

  it("takes the first block that parses, not the first block", () => {
    // A model that shows the shape before answering in it is common enough
    // that stopping at the first fence would throw the answer away.
    const answer =
      'The shape you asked for:\n\n```json\n{ … }\n```\n\nAnd the answer:\n\n```json\n{ "title": "雨" }\n```';
    const read = parseStoryJson(answer);
    expect(read.ok && read.value).toEqual({ title: "雨" });
  });

  it("reads the outermost braces when nothing is fenced", () => {
    const read = parseStoryJson(
      'Sure! { "title": "雨", "n": 1 } Hope that helps.',
    );
    expect(read.ok && read.value).toEqual({ title: "雨", n: 1 });
  });

  it("reads a bare array the same way", () => {
    const read = parseStoryJson('Here: [ { "title": "雨" } ]');
    expect(read.ok && read.value).toEqual([{ title: "雨" }]);
  });

  it("ignores braces that are inside strings", () => {
    const read = parseStoryJson('{ "content": "a } b { c", "n": 1 } trailing');
    expect(read.ok && read.value).toEqual({ content: "a } b { c", n: 1 });
  });

  it("forgives a comma at the end of a list", () => {
    const read = parseStoryJson('{ "acts": [ { "n": 1 }, { "n": 2 }, ] }');
    expect(read.ok && read.value).toEqual({ acts: [{ n: 1 }, { n: 2 }] });
  });

  it("leaves commas inside strings alone", () => {
    // The repair runs on text that failed to parse, and a description ending
    // in a comma is a description, not a fault of the answer.
    const read = parseStoryJson('{ "content": "他停下来,]" }');
    expect(read.ok && read.value).toEqual({ content: "他停下来,]" });
  });

  it("forgives the quotes a keyboard did not type", () => {
    const read = parseStoryJson("{ “title”: “雨夜” }");
    expect(read.ok && read.value).toEqual({ title: "雨夜" });
  });

  it("ignores the characters a paste carries", () => {
    const read = parseStoryJson('\uFEFF\u200B```json\n{ "n": 1 }\n```');
    expect(read.ok && read.value).toEqual({ n: 1 });
  });

  it("says what it could not read, and hands back the answer itself", () => {
    const answer = "I could not write this as json, sorry.";
    const read = parseStoryJson(answer);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toContain("json");
      expect(read.raw).toBe(answer);
    }
  });

  it("calls an empty answer empty", () => {
    const read = parseStoryJson("   \n  ");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("empty");
  });
});
