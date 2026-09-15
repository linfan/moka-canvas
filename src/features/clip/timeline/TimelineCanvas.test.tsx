// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import type { TimelineDocument } from "../../../shared/domain";
import { buildCutMokaFile } from "../../../shared/domain/fixtures";
import { useClipStore } from "../stores/clipStore";
import { TimelineCanvas } from "./TimelineCanvas";

function cut(): TimelineDocument {
  return buildCutMokaFile().timelines![0];
}

/** The canvas with the headers column beside it, as the room lays them out. */
function Harness({ timeline }: { timeline: TimelineDocument }) {
  const headersRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div data-testid="headers" ref={headersRef} />
      <TimelineCanvas headersRef={headersRef} timeline={timeline} />
    </>
  );
}

/** A window with no raster in it still has to answer, or the canvas can never be asked to draw. */
function stubContext(): CanvasRenderingContext2D {
  const noop = () => undefined;
  return new Proxy(
    { measureText: () => ({ width: 0 }) },
    {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value : noop;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

const RECT = {
  bottom: 300,
  height: 300,
  left: 0,
  right: 800,
  top: 0,
  width: 800,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

beforeEach(() => {
  localStorage.clear();
  useClipStore.setState({
    activeTimelineId: null,
    view: { pxPerSec: 60, scrollLeftPx: 0 },
    playheadMs: 0,
    viewportPx: 0,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLCanvasElement.prototype.getContext = (() =>
    stubContext()) as unknown as HTMLCanvasElement["getContext"];
  // Capture and the element's box are the browser's; a pointer needs both.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function viewportOf(container: HTMLElement): HTMLDivElement {
  return container.querySelector(".clip-tl-viewport") as HTMLDivElement;
}

function canvasOf(container: HTMLElement): HTMLCanvasElement {
  return container.querySelector(".clip-tl-canvas") as HTMLCanvasElement;
}

describe("the timeline canvas", () => {
  it("puts the playhead under a click on the ruler and follows the drag", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const canvas = canvasOf(container);

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 300,
      clientY: 10,
      pointerId: 1,
    });
    expect(useClipStore.getState().playheadMs).toBe(5_000);

    fireEvent.pointerMove(canvas, { clientX: 600, clientY: 12, pointerId: 1 });
    expect(useClipStore.getState().playheadMs).toBe(10_000);

    fireEvent.pointerUp(canvas, { clientX: 600, clientY: 12, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 900, clientY: 12, pointerId: 1 });
    expect(useClipStore.getState().playheadMs).toBe(10_000);
  });

  it("leaves a press below the ruler to the packages that act on clips", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const canvas = canvasOf(container);

    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 300,
      clientY: 80,
      pointerId: 1,
    });
    fireEvent.pointerMove(canvas, { clientX: 600, clientY: 90, pointerId: 1 });
    expect(useClipStore.getState().playheadMs).toBe(0);
  });

  it("reads the scroll into the store and moves the headers with it", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const viewport = viewportOf(container);
    Object.defineProperty(viewport, "scrollLeft", {
      configurable: true,
      value: 250,
      writable: true,
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      value: 40,
      writable: true,
    });

    fireEvent.scroll(viewport);

    expect(useClipStore.getState().view.scrollLeftPx).toBe(250);
    const headers = container.querySelector(
      "[data-testid=headers]",
    ) as HTMLElement;
    expect(headers.style.transform).toBe("translateY(-40px)");
  });

  it("applies a zoom back onto the scroller, which only the browser has been scrolling", () => {
    const { container } = render(<Harness timeline={cut()} />);
    const viewport = viewportOf(container);
    Object.defineProperty(viewport, "scrollLeft", {
      configurable: true,
      value: 0,
      writable: true,
    });

    useClipStore.getState().setViewportPx(800);
    useClipStore.getState().setPlayhead(5_000);
    useClipStore.getState().zoomTo(90);

    expect(useClipStore.getState().view).toEqual({
      pxPerSec: 90,
      scrollLeftPx: 50,
    });
    expect(viewport.scrollLeft).toBe(50);
  });
});
