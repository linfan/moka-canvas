import { Canvas } from "leafer-ui";
import { GRID_BASE_SPACING, GRID_FADE_ZOOM } from "../../../shared/domain";
import type { Camera, ViewSize } from "./camera";
import { canvasTheme } from "./theme";

export type GridMode = "dots" | "lines" | "blank";

/**
 * Screen-space grid drawn on one Canvas element. The grid follows the
 * camera: world spacing scaled by zoom, offset by pan, fading at far
 * zoom-out.
 */
export class GridBackground {
  readonly canvas: Canvas;
  private size: ViewSize = { width: 0, height: 0 };

  constructor() {
    this.canvas = new Canvas({
      x: 0,
      y: 0,
      hittable: false,
      data: { role: "background" },
    });
  }

  resize(size: ViewSize) {
    this.size = size;
    this.canvas.set({ width: size.width, height: size.height });
  }

  draw(camera: Camera, mode: GridMode) {
    const { width, height } = this.size;
    if (!width || !height || !this.canvas.ready) return;
    const ctx = this.canvas.context;
    ctx.clearRect(0, 0, width, height);
    if (mode === "blank") {
      this.canvas.paint();
      return;
    }

    let spacing = GRID_BASE_SPACING * camera.zoom;
    while (spacing < 16) spacing *= 4;
    const alpha =
      camera.zoom < GRID_FADE_ZOOM
        ? Math.max(0.15, camera.zoom / GRID_FADE_ZOOM)
        : 1;
    const offsetX = ((width / 2 - camera.x * camera.zoom) % spacing) + spacing;
    const offsetY = ((height / 2 - camera.y * camera.zoom) % spacing) + spacing;

    ctx.strokeStyle = canvasTheme.grid;
    ctx.fillStyle = canvasTheme.grid;
    ctx.globalAlpha = 0.55 * alpha;

    if (mode === "lines") {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = offsetX % spacing; x <= width; x += spacing) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = offsetY % spacing; y <= height; y += spacing) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    } else {
      const radius = camera.zoom < GRID_FADE_ZOOM ? 1 : 1.4;
      for (let x = offsetX % spacing; x <= width; x += spacing) {
        for (let y = offsetY % spacing; y <= height; y += spacing) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    this.canvas.paint();
  }
}
