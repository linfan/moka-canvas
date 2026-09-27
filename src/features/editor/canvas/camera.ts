import {
  ZOOM_MAX,
  ZOOM_MIN,
  type Point,
  type Viewport,
} from "../../../shared/domain";

/** Camera `x/y` is the world point shown at the center of the viewport. */
export type Camera = Viewport;

export interface ViewSize {
  width: number;
  height: number;
}

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function worldToScreen(
  camera: Camera,
  size: ViewSize,
  point: Point,
): Point {
  return {
    x: (point.x - camera.x) * camera.zoom + size.width / 2,
    y: (point.y - camera.y) * camera.zoom + size.height / 2,
  };
}

export function screenToWorld(
  camera: Camera,
  size: ViewSize,
  point: Point,
): Point {
  return {
    x: (point.x - size.width / 2) / camera.zoom + camera.x,
    y: (point.y - size.height / 2) / camera.zoom + camera.y,
  };
}

/** Zoom by `factor` keeping the world point under `screenPoint` fixed. */
export function zoomAtPoint(
  camera: Camera,
  size: ViewSize,
  screenPoint: Point,
  factor: number,
): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  if (zoom === camera.zoom) return camera;
  const anchor = screenToWorld(camera, size, screenPoint);
  return {
    zoom,
    x: anchor.x - (screenPoint.x - size.width / 2) / zoom,
    y: anchor.y - (screenPoint.y - size.height / 2) / zoom,
  };
}

/** The zoom a wheel step is measured against: a one-to-one view of the art. */
const WHEEL_ZOOM_REFERENCE = 1;

/**
 * Zoom factor for one wheel event, at the zoom the camera is held at.
 *
 * One notch has to serve a canvas showing a handful of nodes and one showing a
 * city block, and a step fixed in proportion serves neither: read against the
 * whole visible field it crawls when far out and cannot be aimed at close in.
 * So the step follows what the viewport holds — the world on screen grows as
 * the zoom falls — taken as its square root, which crosses a large canvas in
 * a few rolls without the near view running away from the hand. `fine` marks
 * the held-modifier step — a quarter of the usual one — which is also what a
 * Mac trackpad pinch sends, for aiming at a detail without overshooting it.
 */
export function wheelZoomFactor(
  deltaY: number,
  fine: boolean,
  zoom: number,
): number {
  const gain = Math.sqrt(WHEEL_ZOOM_REFERENCE / zoom);
  return Math.pow(1.0015, -deltaY * (fine ? 0.25 : 1) * gain);
}

/** Pan by a screen-space pixel delta. */
export function panByPixels(camera: Camera, dx: number, dy: number): Camera {
  return {
    ...camera,
    x: camera.x - dx / camera.zoom,
    y: camera.y - dy / camera.zoom,
  };
}

/** Center the camera on a world rectangle without changing zoom. */
export function centerOn(
  camera: Camera,
  bounds: { x: number; y: number; width: number; height: number },
): Camera {
  return {
    ...camera,
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

/** Fit world bounds into the viewport with padding, clamped to zoom limits. */
export function fitBounds(
  camera: Camera,
  size: ViewSize,
  bounds: { x: number; y: number; width: number; height: number },
  padding = 120,
): Camera {
  const usableW = Math.max(1, size.width - padding * 2);
  const usableH = Math.max(1, size.height - padding * 2);
  const zoom = clampZoom(
    Math.min(
      usableW / Math.max(1, bounds.width),
      usableH / Math.max(1, bounds.height),
    ),
  );
  return centerOn({ ...camera, zoom }, bounds);
}

export function camerasEqual(a: Camera, b: Camera): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}
