import { describe, expect, it } from "vitest";

import { splitSource } from "./storySource";

describe("cutting a manuscript into parts", () => {
  it("cuts where the manuscript says 第…章", () => {
    const manuscript = [
      "第一章 站台",
      "他在站台上等一班已经停运的列车。",
      "",
      "第二章 车厢",
      "车厢比站台更暗。",
      "",
      "第三章 雨",
      "雨一直下到天亮。",
    ].join("\n");

    const parts = splitSource(manuscript, {
      targetChapters: 3,
      maxChars: 1000,
    });

    expect(parts.map((part) => part.title)).toEqual([
      "第一章 站台",
      "第二章 车厢",
      "第三章 雨",
    ]);
    expect(parts[0].text).toBe("他在站台上等一班已经停运的列车。");
    expect(parts[2].text).toBe("雨一直下到天亮。");
  });

  it("cuts where the manuscript says Chapter", () => {
    const manuscript = "Chapter 1\nA\nChapter 2\nB\nChapter 3\nC";
    const parts = splitSource(manuscript, {
      targetChapters: 3,
      maxChars: 1000,
    });
    expect(parts.map((part) => part.title)).toEqual([
      "Chapter 1",
      "Chapter 2",
      "Chapter 3",
    ]);
  });

  it("does not read a manuscript's headings as chapters when there are far too many", () => {
    // A novel with a hundred headings is not a telling with four chapters, and
    // cutting at all of them would ask for a hundred asks.
    const manuscript = Array.from(
      { length: 20 },
      (_, index) => `第${index + 1}章\n正文。`,
    ).join("\n");

    const parts = splitSource(manuscript, {
      targetChapters: 3,
      maxChars: 1000,
    });

    expect(parts).toHaveLength(3);
    expect(parts.every((part) => part.title === undefined)).toBe(true);
  });

  it("cuts at the marks a manuscript breaks its scenes with", () => {
    const manuscript = [
      "雨落在站台上。",
      "",
      "***",
      "",
      "灯一盏一盏亮起来。",
      "",
      "---",
      "",
      "车没有来。",
    ].join("\n");

    const parts = splitSource(manuscript, {
      targetChapters: 3,
      maxChars: 1000,
    });

    expect(parts.map((part) => part.text)).toEqual([
      "雨落在站台上。",
      "灯一盏一盏亮起来。",
      "车没有来。",
    ]);
    // The marks themselves are seams, not text.
    expect(parts.map((part) => part.text).join()).not.toContain("***");
  });

  it("packs a manuscript with no marks into the number of parts asked for", () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) =>
        `第 ${index + 1} 段的正文，写得长一些，好让装箱有东西可称。`,
    );
    const parts = splitSource(paragraphs.join("\n\n"), {
      targetChapters: 4,
      maxChars: 10_000,
    });

    expect(parts).toHaveLength(4);
    // Packed by weight, so no part is a tenth of the manuscript and no part is
    // half of it.
    const lengths = parts.map((part) => part.text.length);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    expect(Math.max(...lengths) / total).toBeLessThan(0.4);
  });

  it("cuts a manuscript with no seams at all into equal shares", () => {
    const manuscript = "字".repeat(1000);
    const parts = splitSource(manuscript, {
      targetChapters: 4,
      maxChars: 10_000,
    });

    expect(parts).toHaveLength(4);
    expect(
      parts.map((part) => part.text.length).reduce((a, b) => a + b, 0),
    ).toBe(1000);
    expect(
      Math.max(...parts.map((part) => part.text.length)),
    ).toBeLessThanOrEqual(260);
  });

  it("breaks at a sentence end rather than a character short of one", () => {
    const sentence = "他说了一句话。";
    const manuscript = sentence.repeat(10);
    const parts = splitSource(manuscript, {
      targetChapters: 5,
      maxChars: 10_000,
    });

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) {
      expect(part.text.endsWith("。")).toBe(true);
    }
  });

  it("keeps a part inside the length it was given", () => {
    const manuscript = "字".repeat(600);
    const parts = splitSource(manuscript, { targetChapters: 2, maxChars: 100 });

    expect(parts.every((part) => Array.from(part.text).length <= 100)).toBe(
      true,
    );
  });

  it("never cuts a character in half", () => {
    // The string is cut by code point, so an emoji stays one emoji and does
    // not come back as the two halves of a surrogate pair.
    const manuscript = "😀".repeat(50);
    const parts = splitSource(manuscript, { targetChapters: 3, maxChars: 20 });

    for (const part of parts) {
      expect(/^[\u{1F600}]*$/u.test(part.text)).toBe(true);
    }
  });

  it("cuts a heading's chapter that is longer than a part may be", () => {
    const manuscript = ["第一章", "字".repeat(300), "第二章", "短。"].join(
      "\n",
    );

    const parts = splitSource(manuscript, { targetChapters: 2, maxChars: 100 });

    expect(parts[0].title).toBe("第一章");
    expect(Array.from(parts[0].text).length).toBeLessThanOrEqual(100);
  });

  it("answers with one part for a manuscript with nothing in it", () => {
    const parts = splitSource("   \n ", { targetChapters: 3, maxChars: 100 });
    expect(parts).toEqual([{ text: "" }]);
  });
});
