import { Group, Rect } from "leafer-ui";
import type { Point, WorkflowNode } from "../../../shared/domain";
import type { Camera, ViewSize } from "./camera";
import { canvasTheme } from "./theme";

const MAP_WIDTH = 176;
const MAP_HEIGHT = 116;
const MAP_MARGIN = 14;
const MAP_PADDING = 8;

/** Bottom-left screen-space minimap: node blocks plus the camera window. */
export class MinimapView {
  readonly group: Group;
  private frame: Rect;
  private blocks: Rect[] = [];
  private viewport: Rect;
  private worldBounds = { x: 0, y: 0, width: 1, height: 1 };

  constructor() {
    this.group = new Group({ data: { role: "minimap" } });
    this.frame = new Rect({
      x: 0,
      y: 0,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      cornerRadius: 10,
      fill: "#17181cd9",
      stroke: canvasTheme.nodeStroke,
      strokeWidth: 1,
      data: { role: "minimap" },
    });
    this.viewport = new Rect({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      cornerRadius: 3,
      fill: "#ffffff1f",
      stroke: canvasTheme.selection,
      strokeWidth: 1,
      hittable: false,
    });
    this.group.add(this.frame);
    this.group.add(this.viewport);
  }

  /** Map a screen point inside the map to the corresponding world point. */
  toWorld(screen: Point): Point {
    const scale = this.scale();
    const localX = screen.x - this.group.x! - MAP_PADDING;
    const localY = screen.y - this.group.y! - MAP_PADDING;
    return {
      x: this.worldBounds.x + localX / scale,
      y: this.worldBounds.y + localY / scale,
    };
  }

  contains(screen: Point): boolean {
    return (
      screen.x >= this.group.x! &&
      screen.x <= this.group.x! + MAP_WIDTH &&
      screen.y >= this.group.y! &&
      screen.y <= this.group.y! + MAP_HEIGHT
    );
  }

  private scale(): number {
    const usableW = MAP_WIDTH - MAP_PADDING * 2;
    const usableH = MAP_HEIGHT - MAP_PADDING * 2;
    return Math.min(
      usableW / Math.max(1, this.worldBounds.width),
      usableH / Math.max(1, this.worldBounds.height),
    );
  }

  update(
    nodes: WorkflowNode[],
    camera: Camera,
    size: ViewSize,
    accentOf: (node: WorkflowNode) => string,
  ) {
    this.group.set({
      x: MAP_MARGIN,
      y: size.height - MAP_HEIGHT - MAP_MARGIN,
    });

    if (nodes.length === 0) {
      this.worldBounds = {
        x: camera.x - 500,
        y: camera.y - 300,
        width: 1000,
        height: 600,
      };
    } else {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        minX = Math.min(minX, node.bounds.x);
        minY = Math.min(minY, node.bounds.y);
        maxX = Math.max(maxX, node.bounds.x + node.bounds.width);
        maxY = Math.max(maxY, node.bounds.y + node.bounds.height);
      }
      const pad = 80;
      this.worldBounds = {
        x: minX - pad,
        y: minY - pad,
        width: maxX - minX + pad * 2,
        height: maxY - minY + pad * 2,
      };
    }

    const scale = this.scale();
    while (this.blocks.length > nodes.length) {
      this.blocks.pop()!.remove();
    }
    nodes.forEach((node, index) => {
      let block = this.blocks[index];
      if (!block) {
        block = new Rect({ cornerRadius: 2, hittable: false });
        this.blocks.push(block);
        this.group.add(block);
        // Keep the camera window above the blocks.
        this.viewport.remove();
        this.group.add(this.viewport);
      }
      block.set({
        x: MAP_PADDING + (node.bounds.x - this.worldBounds.x) * scale,
        y: MAP_PADDING + (node.bounds.y - this.worldBounds.y) * scale,
        width: Math.max(2, node.bounds.width * scale),
        height: Math.max(2, node.bounds.height * scale),
        fill: accentOf(node),
      });
    });

    const viewW = size.width / camera.zoom;
    const viewH = size.height / camera.zoom;
    this.viewport.set({
      x: MAP_PADDING + (camera.x - viewW / 2 - this.worldBounds.x) * scale,
      y: MAP_PADDING + (camera.y - viewH / 2 - this.worldBounds.y) * scale,
      width: Math.max(6, viewW * scale),
      height: Math.max(6, viewH * scale),
    });
  }
}
