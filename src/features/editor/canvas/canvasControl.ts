import type { Point, Rect } from "../../../shared/domain";
import type { LeaferEditorController } from "./controller";

/**
 * Registry for the mounted canvas controller. DOM-side code (keyboard
 * shortcuts, menus, toolstrip) reaches imperative canvas operations through
 * here instead of importing the controller class (which pulls in Leafer and
 * breaks canvas-less environments like jsdom).
 */
let active: LeaferEditorController | null = null;

export function registerController(controller: LeaferEditorController | null) {
  active = controller;
}

export function hasCanvasController(): boolean {
  return active !== null;
}

export function worldToClient(point: Point): Point | null {
  return active?.worldToClient(point) ?? null;
}

export function clientToWorld(point: Point): Point | null {
  return active?.clientToWorld(point) ?? null;
}

/** World point at the current view center. */
export function viewCenterWorld(): Point | null {
  return active?.viewCenterWorld() ?? null;
}

export function cancelGesture() {
  active?.cancelGesture();
}

export function zoomBy(factor: number) {
  active?.zoomByAtCenter(factor);
}

export function zoomReset() {
  active?.zoomToAtCenter(1);
}

export function zoomTo(zoom: number) {
  active?.zoomToAtCenter(zoom);
}

/** Animated camera move framing the bounds; no-op without a controller. */
export function fitBounds(bounds: Rect) {
  active?.fitBoundsAnimated(bounds);
}

export function focusNode(nodeId: string) {
  active?.focusNode(nodeId);
}
