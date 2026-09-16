import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  PANEL_BIG_STEP,
  PANEL_MIN,
  PANEL_START,
  PANEL_STEP,
  panelCeiling,
  usePanelWidths,
  type PanelSide,
} from "../stores/panelWidths";

/** What each edge is called to a reader who cannot see it. */
const LABELS: Record<PanelSide, string> = {
  left: "editor:stores.resizeProjectColumn",
  right: "editor:stores.resizeRightColumn",
};

const HINT = "editor:stores.resizeHint";

interface PanelResizerProps {
  side: PanelSide;
}

/**
 * The edge a column is dragged by.
 *
 * One component for both columns rather than two, since what differs between
 * them is only which way a movement of the pointer widens the column: the left
 * one grows to the right and the right one grows to the left. The width arrived
 * at is kept beside the other choices about how this machine is used, and the
 * canvas beside the column hears about it from the layout rather than from
 * anything asked of it — the canvas has been measuring its own box all along.
 */
export function PanelResizer({ side }: PanelResizerProps) {
  const { t } = useTranslation();
  const width = usePanelWidths((state) => state[side]);
  const setWidth = usePanelWidths((state) => state.setWidth);
  const resetWidth = usePanelWidths((state) => state.resetWidth);
  const [dragging, setDragging] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);
  const grip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  // The column as it stands is read off the column itself, so one nobody has
  // dragged starts from the width its stylesheet gave it rather than from a
  // number guessed here. Read again on the way in, since which face the column
  // is showing may have changed since the last look.
  const column = useCallback(() => {
    const edge = grip.current;
    if (!edge) return null;
    const panel =
      side === "left" ? edge.previousElementSibling : edge.nextElementSibling;
    const across = panel?.getBoundingClientRect().width ?? 0;
    return across > 0 ? across : null;
  }, [side]);

  const refresh = useCallback(() => {
    const across = column();
    if (across !== null) setMeasured(across);
  }, [column]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A window narrowed under a column that was dragged wide would leave the
  // canvas nothing to be, so the column is asked back inside the room there is.
  useEffect(() => {
    const narrow = () => {
      const across = usePanelWidths.getState()[side];
      if (across !== null) setWidth(side, across);
    };
    window.addEventListener("resize", narrow);
    return () => window.removeEventListener("resize", narrow);
  }, [side, setWidth]);

  /** The width the column has now, dragged or not. */
  const widthNow = () => width ?? measured ?? PANEL_START[side];

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; the others are asking for a menu.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthNow(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    // The pointer crosses the canvas and the column while it is held, and what
    // it crosses should not read the crossing as a choice of its own.
    document.body.classList.add("is-dragging-panel");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const started = drag.current;
    if (!started || started.pointerId !== event.pointerId) return;
    // How far the pointer travelled, counted in the direction that widens this
    // column: to the right for the left one and to the left for the right one.
    const travelled =
      side === "left"
        ? event.clientX - started.startX
        : started.startX - event.clientX;
    setWidth(side, started.startWidth + travelled);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const started = drag.current;
    if (!started || started.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove("is-dragging-panel");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The arrow that widens is the one pointing into the canvas: right for the
    // left column, left for the right one.
    const grows = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrinks = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (event.key !== grows && event.key !== shrinks) return;
    event.preventDefault();
    const step = event.shiftKey ? PANEL_BIG_STEP : PANEL_STEP;
    setWidth(side, widthNow() + (event.key === grows ? step : -step));
  };

  return (
    <div
      aria-label={t(LABELS[side])}
      aria-orientation="vertical"
      aria-valuemax={Math.round(panelCeiling())}
      aria-valuemin={PANEL_MIN}
      aria-valuenow={Math.round(widthNow())}
      className={dragging ? "panel-resizer is-dragging" : "panel-resizer"}
      data-testid={`panel-resizer-${side}`}
      onDoubleClick={() => resetWidth(side)}
      onFocus={refresh}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerEnter={refresh}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      ref={grip}
      role="separator"
      tabIndex={0}
      title={t(HINT)}
    />
  );
}
