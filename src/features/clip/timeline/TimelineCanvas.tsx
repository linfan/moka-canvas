import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { TimelineDocument } from "../../../shared/domain";
import { ASSET_DRAG_MIME } from "../../editor/interactions/actions";
import { clickSelection, dropAssetOnTrack } from "../interactions/clipActions";
import { useClipStore } from "../stores/clipStore";
import {
  RULER_H,
  contentHeight,
  contentMs,
  contentWidth,
  hitTest,
  msAt,
  type TimelineHit,
} from "./geometry";
import { renderTimeline } from "./render";
import { frameAligned } from "./timecode";
import { useTimelineDecor } from "./decor";

interface TimelineCanvasProps {
  timeline: TimelineDocument;
  /** The headers column, moved by the same vertical scroll that moves the rows. */
  headersRef: RefObject<HTMLDivElement | null>;
}

interface Press {
  x: number;
  y: number;
  hit: TimelineHit;
}

/** How far a pointer may wander between down and up and still be a click. */
const CLICK_SLOP_PX = 4;

/**
 * The screen the cut is drawn on.
 *
 * One screenful is all the canvas holds, whatever the cut's length: the spacer
 * beside it carries the scrollbars, the canvas stays pinned to the viewport's
 * corner, and every scroll schedules a redraw with the new offset. Nothing is
 * drawn twice into the same frame, so a scroll is a frame's work and not a
 * scroll's.
 */
export function TimelineCanvas({ timeline, headersRef }: TimelineCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const pressRef = useRef<Press | null>(null);
  // The clip a Shift click reaches from, which is the last clip picked alone.
  const anchorRef = useRef<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const pxPerSec = useClipStore((state) => state.view.pxPerSec);
  const playheadMs = useClipStore((state) => state.playheadMs);
  const decor = useTimelineDecor();
  const spacerWidth = contentWidth(timeline, playheadMs, pxPerSec);
  const spacerHeight = contentHeight(timeline);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const cssW = viewport.clientWidth;
    const cssH = viewport.clientHeight;
    // Before anything is asked of the context: a window with no room in it
    // (a test without a layout, a hidden panel) has nothing to draw into.
    if (cssW <= 0 || cssH <= 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    sizeCanvas(canvas, cssW, cssH);
    // The backing store is the device's; the drawing stays in CSS pixels, so
    // what the renderer measures lands where a pointer does. Set per frame,
    // since resizing the canvas starts the context over.
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const state = useClipStore.getState();
    renderTimeline(ctx, {
      timeline,
      view: {
        pxPerSec: state.view.pxPerSec,
        scrollLeftPx: viewport.scrollLeft,
      },
      viewport: { width: cssW, height: cssH, scrollTopPx: viewport.scrollTop },
      playheadMs: state.playheadMs,
      selection: state.selection,
      decor,
    });
    // What is drawn is pixels, which nothing can read back: what changed is
    // written onto the room instead, a moment behind the frame that drew it.
    // These attributes are the only observation point a test has on the cut,
    // and packages 08/10 keep them true rather than growing their own.
    const room = canvas.closest(".clip-timeline");
    if (room) {
      room.setAttribute("data-clip-count", String(timeline.clips.length));
      room.setAttribute(
        "data-selected-clip-ids",
        state.selection.clipIds.join(","),
      );
      room.setAttribute(
        "data-selected-transition-id",
        state.selection.transitionId ?? "",
      );
    }
  }, [timeline, decor]);

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  // Every draw answers to the same two things: the store, which holds what to
  // draw, and the scroller, whose position is read at draw time. A zoom that
  // moves the view is applied back onto the scroller here, since the browser
  // only knows about scrolling the reader did.
  useEffect(
    () =>
      useClipStore.subscribe((state, previous) => {
        const viewport = viewportRef.current;
        if (
          viewport &&
          state.view.scrollLeftPx !== previous.view.scrollLeftPx &&
          viewport.scrollLeft !== state.view.scrollLeftPx
        ) {
          viewport.scrollLeft = state.view.scrollLeftPx;
        }
        schedule();
      }),
    [schedule],
  );

  useEffect(() => {
    schedule();
  }, [schedule, timeline]);

  /** Take the viewport's size: the backing store, the store's idea of a screen, and a draw. */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const cssW = viewport.clientWidth;
    const cssH = viewport.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    sizeCanvas(canvas, cssW, cssH);
    useClipStore.getState().setViewportPx(cssW);
    schedule();
  }, [schedule]);

  // Sized in the layout pass rather than on the first frame: the element is a
  // screen from the moment it is in the DOM, so a pointer never lands beside
  // a canvas that is still wearing the browser's default 300×150.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    resize();
    return () => observer.disconnect();
  }, [resize]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const store = useClipStore.getState();
      if (store.view.scrollLeftPx !== viewport.scrollLeft) {
        store.setView({ scrollLeftPx: viewport.scrollLeft });
      }
      if (headersRef.current) {
        headersRef.current.style.transform = `translateY(${-viewport.scrollTop}px)`;
      }
      schedule();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [headersRef, schedule]);

  // A wheel with Ctrl or the command key zooms around the pointer; a plain
  // wheel is the reader moving the view and stays the browser's own scroll.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const state = useClipStore.getState();
      const anchorMs = msAt(event.clientX - rect.left, {
        pxPerSec: state.view.pxPerSec,
        scrollLeftPx: viewport.scrollLeft,
      });
      state.zoomBy(Math.exp(-event.deltaY * 0.0015), anchorMs);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  /** Where a pointer sits on the drawn screen, in canvas pixels. */
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const seek = (localX: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const store = useClipStore.getState();
    const ms = msAt(localX, {
      pxPerSec: store.view.pxPerSec,
      scrollLeftPx: viewport.scrollLeft,
    });
    // The playhead can stand anywhere the cut reaches, and nowhere past it.
    store.setPlayhead(
      Math.min(Math.max(0, ms), contentMs(timeline, store.playheadMs)),
    );
  };

  const inRuler = (localY: number, scrollTop: number) =>
    localY + scrollTop < RULER_H;

  /** What a point on the drawn screen is over, with the point moved into content space. */
  const hitAt = (x: number, y: number): TimelineHit | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    return hitTest(
      timeline,
      {
        pxPerSec: useClipStore.getState().view.pxPerSec,
        scrollLeftPx: viewport.scrollLeft,
      },
      { x, y: y + viewport.scrollTop },
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const viewport = viewportRef.current;
    const local = localPoint(event);
    if (!viewport || !local || event.button !== 0) return;
    if (inRuler(local.y, viewport.scrollTop)) {
      // The ruler is 04's own hand-hold; choosing clips happens below it.
      // The seek lands first: a capture that a browser refuses is a drag that
      // stops at the edge, not a click that never happened.
      draggingRef.current = true;
      seek(local.x);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const hit = hitAt(local.x, local.y);
    if (hit) pressRef.current = { x: local.x, y: local.y, hit };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const local = localPoint(event);
    if (local) seek(local.x);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (draggingRef.current) {
      draggingRef.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
    const press = pressRef.current;
    pressRef.current = null;
    const local = localPoint(event);
    if (!press || !local) return;
    // A pointer that wandered is a drag, and a drag belongs to 08: only a
    // press that held still is a click, whichever row it landed on.
    if (
      Math.abs(local.x - press.x) >= CLICK_SLOP_PX ||
      Math.abs(local.y - press.y) >= CLICK_SLOP_PX
    ) {
      return;
    }
    const store = useClipStore.getState();
    const mode = event.shiftKey
      ? "add"
      : event.ctrlKey || event.metaKey
        ? "toggle"
        : "replace";
    const selection = clickSelection(
      timeline,
      store.selection,
      press.hit,
      mode,
      anchorRef.current,
    );
    store.select(selection);
    if (mode === "replace" && press.hit.kind === "clip") {
      anchorRef.current = press.hit.clip.id;
    } else if (press.hit.kind !== "clip") {
      anchorRef.current = null;
    }
  };

  /** Whether a drag carries a file from the shelf, which is the only drag the rows take. */
  const carriedAssetId = (event: ReactDragEvent<HTMLCanvasElement>) =>
    event.dataTransfer.types.includes(ASSET_DRAG_MIME)
      ? event.dataTransfer.getData(ASSET_DRAG_MIME)
      : "";

  const onDragOver = (event: ReactDragEvent<HTMLCanvasElement>) => {
    if (!event.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    // Saying the canvas can take the drop is what makes the drop arrive; the
    // copy is the shelf's own promise, not the room moving anything.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };

  const onDragLeave = () => setDropping(false);

  const onDrop = (event: ReactDragEvent<HTMLCanvasElement>) => {
    if (!event.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    event.preventDefault();
    setDropping(false);
    const assetId = carriedAssetId(event);
    const viewport = viewportRef.current;
    const local = localPoint(event);
    if (!assetId || !viewport || !local) return;
    const view = {
      pxPerSec: useClipStore.getState().view.pxPerSec,
      scrollLeftPx: viewport.scrollLeft,
    };
    const hit = hitTest(timeline, view, {
      x: local.x,
      y: local.y + viewport.scrollTop,
    });
    const trackId =
      hit.kind === "clip"
        ? hit.clip.trackId
        : hit.kind === "transition"
          ? (timeline.clips.find(
              (clip) => clip.id === hit.transition.afterClipId,
            )?.trackId ?? null)
          : hit.kind === "empty"
            ? hit.trackId
            : null;
    if (trackId === null) return;
    // The file lands on the frame the pointer's moment falls on: where a
    // piece sits is decided when it is laid down and nowhere else.
    const startMs = Math.max(
      0,
      frameAligned(msAt(local.x, view), timeline.settings.fps),
    );
    dropAssetOnTrack(timeline, assetId, trackId, startMs);
  };

  return (
    <div className="clip-tl-viewport" ref={viewportRef}>
      <div
        className="clip-tl-spacer"
        style={{ height: spacerHeight, width: spacerWidth }}
      />
      <canvas
        className={
          dropping ? "clip-tl-canvas is-drop-target" : "clip-tl-canvas"
        }
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onPointerCancel={onPointerUp}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={canvasRef}
      />
    </div>
  );
}

/** The backing store follows the device's pixel ratio; the drawing works in CSS pixels. */
function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(cssW * dpr));
  const height = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}
