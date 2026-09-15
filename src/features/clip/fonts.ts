/**
 * The six fonts a text clip may wear, as whole CSS stacks.
 *
 * A clip stores the stack rather than one family, so the preview and the burn
 * -in both fall back the way a browser would when a machine has none of the
 * named faces. A stack has to name a first family, though, for the one reader
 * that cannot take a list: the ASS export writes a single `Fontname` and takes
 * the first family of the stack (package 12's table, 11 §5), which is the one
 * the reader actually chose here.
 *
 * Pure data and one tiny reading: nothing here touches the document.
 */

/** One of the fonts the picker offers: a name, and the stack it stands for. */
export interface ClipFont {
  label: string;
  /** The whole stack a clip stores, as `defaultTextStyle()` writes one. */
  stack: string;
}

export const CLIP_FONTS: readonly ClipFont[] = [
  { label: "Inter", stack: "Inter, ui-sans-serif, system-ui, sans-serif" },
  { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  { label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
  { label: "Courier New", stack: '"Courier New", Courier, monospace' },
  {
    label: "PingFang SC",
    stack: '"PingFang SC", "Hiragino Sans GB", sans-serif',
  },
  { label: "Songti SC", stack: '"Songti SC", "SimSun", serif' },
];

/** The family a stack leads with, quotes and spaces aside. */
export function firstFamily(stack: string): string {
  const first = stack.split(",")[0] ?? "";
  return first
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

/** The stack a label stands for, or null for a label no font wears. */
export function fontStack(label: string): string | null {
  return CLIP_FONTS.find((font) => font.label === label)?.stack ?? null;
}

/**
 * What a stack is called: the label the picker offers it under, or its first
 * family for a stack the picker never offered (a document written elsewhere).
 */
export function fontLabel(stack: string): string {
  return (
    CLIP_FONTS.find((font) => font.stack === stack)?.label ?? firstFamily(stack)
  );
}
