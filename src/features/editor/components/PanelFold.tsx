import { usePanelFolds } from "../stores/panelFolds";
import type { PanelSide } from "../stores/panelWidths";

/** What each column is called to a reader who cannot see it. */
const NAMES: Record<PanelSide, string> = {
  left: "the project column",
  right: "the column beside the canvas",
};

/** Which way the mark on the triangle points: a column folds away from the canvas. */
const FOLD_MARK: Record<PanelSide, string> = { left: "‹", right: "›" };
const UNFOLD_MARK: Record<PanelSide, string> = { left: "›", right: "‹" };

interface FoldProps {
  side: PanelSide;
}

/**
 * The half triangle in a column's own corner, which folds the column away.
 *
 * A corner cut rather than a button hung on the head: the column's head is
 * already given over to the choice of what it shows, and a fold is about the
 * column as a whole rather than about the face it is showing. The mark on it
 * points the way the column would go, which is away from the canvas.
 */
export function PanelFold({ side }: FoldProps) {
  const toggle = usePanelFolds((state) => state.toggle);
  return (
    <button
      aria-controls={`panel-${side}`}
      aria-expanded
      aria-label={`Fold ${NAMES[side]}`}
      className={`panel-fold panel-fold-${side}`}
      data-testid={`panel-fold-${side}`}
      onClick={() => toggle(side)}
      title={`Fold ${NAMES[side]} away`}
      type="button"
    >
      <span aria-hidden="true">{FOLD_MARK[side]}</span>
    </button>
  );
}

/**
 * The half triangle left in the corner of the page once a column is away.
 *
 * The same corner the column stood in, with the triangle turned the other way
 * round and its mark pointing back into the window: what was folded away is
 * one click from standing here again, and the click is offered where the
 * column was rather than somewhere to be looked for.
 */
export function PanelUnfold({ side }: FoldProps) {
  const toggle = usePanelFolds((state) => state.toggle);
  return (
    <button
      aria-controls={`panel-${side}`}
      aria-expanded={false}
      aria-label={`Open ${NAMES[side]}`}
      className={`panel-unfold panel-unfold-${side}`}
      data-testid={`panel-unfold-${side}`}
      onClick={() => toggle(side)}
      title={`Open ${NAMES[side]}`}
      type="button"
    >
      <span aria-hidden="true">{UNFOLD_MARK[side]}</span>
    </button>
  );
}
