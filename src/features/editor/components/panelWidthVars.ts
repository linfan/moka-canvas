import type { CSSProperties } from "react";

/**
 * The custom properties the two columns read their width from.
 *
 * A column nobody has dragged leaves its property unset, so it keeps the width
 * its own stylesheet gives it: the conversation column reads wider than an
 * inspector, and that difference is the stylesheet's business rather than a
 * number repeated here.
 */
export function panelWidthStyle(
  left: number | null,
  right: number | null,
): CSSProperties | undefined {
  if (left === null && right === null) return undefined;
  const style: Record<string, string> = {};
  if (left !== null) style["--panel-left-width"] = `${left}px`;
  if (right !== null) style["--panel-right-width"] = `${right}px`;
  return style as CSSProperties;
}
