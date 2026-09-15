import { describe, expect, it } from "vitest";
import { CLIP_FONTS, firstFamily, fontLabel, fontStack } from "./fonts";

/**
 * The font table: six stacks, and the one reading package 12's ASS export
 * needs — the first family of a stack, which is the family a reader chose.
 */
describe("fonts", () => {
  it("offers exactly the six fonts the Text page names", () => {
    expect(CLIP_FONTS.map((font) => font.label)).toEqual([
      "Inter",
      "Arial",
      "Georgia",
      "Courier New",
      "PingFang SC",
      "Songti SC",
    ]);
    for (const font of CLIP_FONTS) {
      expect(font.stack.trim().length).toBeGreaterThan(0);
      expect(firstFamily(font.stack)).toBe(font.label);
    }
  });

  it("reads the first family of a stack, quotes aside", () => {
    expect(firstFamily('"Courier New", Courier, monospace')).toBe(
      "Courier New",
    );
    expect(firstFamily("Georgia, 'Times New Roman', serif")).toBe("Georgia");
    expect(firstFamily("Inter, ui-sans-serif, system-ui, sans-serif")).toBe(
      "Inter",
    );
    expect(firstFamily("  Arial  , Helvetica")).toBe("Arial");
  });

  it("walks from a label to its stack and back", () => {
    expect(fontStack("Courier New")).toBe('"Courier New", Courier, monospace');
    expect(fontLabel('"Courier New", Courier, monospace')).toBe("Courier New");
    expect(fontStack("Comic Sans")).toBeNull();
    // A stack the picker never offered reads as its first family.
    expect(fontLabel("SomeFace, sans-serif")).toBe("SomeFace");
  });

  it("holds the style factory's own default stack", () => {
    expect(fontStack("Inter")).toBe(
      "Inter, ui-sans-serif, system-ui, sans-serif",
    );
  });
});
