import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  SPLIT_BIG_STEP,
  SPLIT_MAX,
  SPLIT_MIN,
  SPLIT_STEP,
  useStageSplit,
} from "../stores/stageSplit";

/**
 * The edge the preview and the timeline are dragged apart by.
 *
 * The same thing the column edges are, turned on its side: the pointer is
 * captured, the arrow keys step it, and a double-click puts it back. What it
 * moves is a share of the stage rather than a width in pixels, because the two
 * panes are not two columns of a fixed row — the stage is whatever height the
 * window has left, and the share is what the reader chose about it.
 */
export function StageSplit() {
  const { t } = useTranslation();
  const share = useStageSplit((state) => state.share);
  const setShare = useStageSplit((state) => state.setShare);
  const resetShare = useStageSplit((state) => state.resetShare);
  const [dragging, setDragging] = useState(false);
  const grip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    startY: number;
    startShare: number;
    height: number;
  } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; the others are asking for a menu.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    // The panes share the room of the column they sit in, so the travel of the
    // pointer is counted against that column and not against the window.
    const column = grip.current?.parentElement;
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startShare: share,
      height: column?.getBoundingClientRect().height ?? 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    document.body.classList.add("is-dragging-split");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const started = drag.current;
    if (!started || started.pointerId !== event.pointerId) return;
    if (started.height <= 0) return;
    setShare(
      started.startShare + (event.clientY - started.startY) / started.height,
    );
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const started = drag.current;
    if (!started || started.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("is-dragging-split");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The arrow that grows the preview is the one pointing into it: up.
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? SPLIT_BIG_STEP : SPLIT_STEP;
    setShare(share + (event.key === "ArrowUp" ? step : -step));
  };

  return (
    <div
      aria-label={t("clip:stage.splitLabel")}
      aria-orientation="horizontal"
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuenow={Math.round(share * 100)}
      className={dragging ? "clip-split is-dragging" : "clip-split"}
      data-testid="stage-split"
      onDoubleClick={resetShare}
      onKeyDown={onKeyDown}
      onPointerCancel={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      ref={grip}
      role="separator"
      tabIndex={0}
      title={t("clip:stage.splitHint")}
    />
  );
}
