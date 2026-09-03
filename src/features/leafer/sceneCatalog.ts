import { Arrow } from "@leafer-in/arrow";
import { Ellipse, Group, Line, Path, Polygon, Rect, Text } from "leafer-ui";
import { leaferTheme as theme } from "../../design/leaferTheme";
import type { SceneBuilder, SceneContext, StageHandle } from "./sceneTypes";

type NodeConstructor = new (data?: Record<string, unknown>) => unknown;
type SceneContainer = StageHandle | { add(node: unknown): unknown };

const create = (Constructor: unknown, data: Record<string, unknown>) =>
  new (Constructor as NodeConstructor)(data);
const add = (
  parent: SceneContainer,
  Constructor: unknown,
  data: Record<string, unknown>,
) => {
  const element = create(Constructor, data);
  parent.add(element);
  return element as { add?(node: unknown): unknown };
};

function label(
  parent: SceneContainer,
  text: string,
  x: number,
  y: number,
  size = 14,
  fill: string = theme.muted,
) {
  return add(parent, Text, {
    text,
    x,
    y,
    fontSize: size,
    fill,
    fontFamily: theme.fontFamily,
  });
}

function panel(
  parent: SceneContainer,
  x: number,
  y: number,
  width: number,
  height: number,
): SceneContainer {
  const group = add(parent, Group, {}) as SceneContainer;
  add(group, Rect, {
    x,
    y,
    width,
    height,
    cornerRadius: 20,
    fill: theme.surface,
    stroke: theme.stroke,
    strokeWidth: 1,
    shadow: { x: 0, y: 12, blur: 26, color: "#05081788" },
    opacity: 0.98,
  });
  return group;
}

function grid(stage: StageHandle, width: number, height: number) {
  add(stage, Rect, { x: 0, y: 0, width, height, fill: theme.canvas });
  for (let x = 0; x < width; x += 32)
    add(stage, Line, {
      points: [x, 0, x, height],
      stroke: "#1c2843",
      strokeWidth: 1,
      opacity: 0.48,
    });
  for (let y = 0; y < height; y += 32)
    add(stage, Line, {
      points: [0, y, width, y],
      stroke: "#1c2843",
      strokeWidth: 1,
      opacity: 0.48,
    });
}

export const createOverviewScene: SceneBuilder = ({ stage, width, height }) => {
  grid(stage, width, height);
  const hero = add(stage, Group, { x: 0, y: 0 }) as SceneContainer;
  const scale = Math.min(width / 760, height / 340, 1);
  const left = Math.max(20, (width - 720 * scale) / 2);
  const top = Math.max(24, (height - 270 * scale) / 2);

  add(hero, Rect, {
    x: left,
    y: top,
    width: 720 * scale,
    height: 270 * scale,
    cornerRadius: 30,
    fill: theme.surface,
    stroke: theme.stroke,
    strokeWidth: 1,
    shadow: { x: 0, y: 20, blur: 40, color: "#03071499" },
  });
  add(hero, Ellipse, {
    x: left + 430 * scale,
    y: top - 45 * scale,
    width: 230 * scale,
    height: 230 * scale,
    fill: theme.primary,
    opacity: 0.17,
    blur: 20,
  });
  add(hero, Ellipse, {
    x: left + 520 * scale,
    y: top + 92 * scale,
    width: 160 * scale,
    height: 160 * scale,
    fill: theme.cyan,
    opacity: 0.15,
    blur: 12,
  });
  label(
    hero,
    "MOKA CANVAS / 01",
    left + 42 * scale,
    top + 42 * scale,
    12 * scale,
    theme.cyan,
  );
  label(
    hero,
    "One scene graph.",
    left + 42 * scale,
    top + 90 * scale,
    32 * scale,
    theme.ink,
  );
  label(
    hero,
    "Two rendering environments.",
    left + 42 * scale,
    top + 130 * scale,
    32 * scale,
    theme.ink,
  );
  label(
    hero,
    "The browser and native WebView load identical assets from the same local Rust server.",
    left + 42 * scale,
    top + 184 * scale,
    14 * scale,
    theme.muted,
  );
  add(hero, Polygon, {
    x: left + 495 * scale,
    y: top + 72 * scale,
    points: [0, 58, 34, 0, 68, 58],
    fill: theme.yellow,
    opacity: 0.95,
    rotation: -12,
  });
  add(hero, Path, {
    x: left + 546 * scale,
    y: top + 110 * scale,
    path: "M 0 54 C 20 4, 64 4, 82 54 C 62 78, 20 78, 0 54 Z",
    fill: theme.coral,
    opacity: 0.9,
  });
  add(hero, Arrow, {
    points: [
      left + 488 * scale,
      top + 190 * scale,
      left + 634 * scale,
      top + 190 * scale,
    ],
    stroke: theme.cyan,
    strokeWidth: 3 * scale,
    endArrow: "arrow",
  });
};

export const createShowcaseScene: SceneBuilder = ({ stage, width, height }) => {
  grid(stage, width, height);
  const gap = 18;
  const cardWidth = Math.max(230, (width - gap * 3 - 44) / 2);
  const cardHeight = Math.max(210, (height - gap * 3 - 44) / 2);
  const cards = [
    { x: 18, y: 18, title: "Geometry", accent: theme.primary },
    {
      x: 18 + cardWidth + gap,
      y: 18,
      title: "Type & paths",
      accent: theme.cyan,
    },
    {
      x: 18,
      y: 18 + cardHeight + gap,
      title: "Layers & effects",
      accent: theme.coral,
    },
    {
      x: 18 + cardWidth + gap,
      y: 18 + cardHeight + gap,
      title: "Lines & arrows",
      accent: theme.yellow,
    },
  ];

  cards.forEach(({ x, y, title, accent }, index) => {
    const card = panel(stage, x, y, cardWidth, cardHeight) as SceneContainer;
    label(card, `0${index + 1}`, x + 22, y + 22, 12, accent);
    label(card, title, x + 22, y + 45, 17, theme.ink);
    if (index === 0) {
      add(card, Rect, {
        x: x + 24,
        y: y + 84,
        width: 78,
        height: 72,
        cornerRadius: 14,
        fill: theme.primary,
        rotation: -8,
      });
      add(card, Ellipse, {
        x: x + 118,
        y: y + 85,
        width: 76,
        height: 76,
        fill: theme.cyan,
        opacity: 0.9,
      });
      add(card, Polygon, {
        x: x + 212,
        y: y + 90,
        points: [0, 58, 36, 0, 72, 58],
        fill: theme.yellow,
        stroke: theme.ink,
        strokeWidth: 2,
      });
      label(card, "Rect · Ellipse · Polygon", x + 24, y + cardHeight - 32, 12);
    } else if (index === 1) {
      label(card, "LeaferJS", x + 24, y + 86, 28, theme.ink);
      label(card, "System UI", x + 26, y + 122, 15, theme.muted);
      add(card, Path, {
        x: x + 24,
        y: y + 150,
        path: "M 0 16 C 28 -8, 48 38, 76 16 S 126 40, 164 6",
        stroke: accent,
        strokeWidth: 4,
        fill: "none",
      });
      label(card, "Text · Bézier SVG path", x + 24, y + cardHeight - 32, 12);
    } else if (index === 2) {
      add(card, Rect, {
        x: x + 45,
        y: y + 100,
        width: 116,
        height: 80,
        cornerRadius: 18,
        fill: theme.primary,
        opacity: 0.35,
        rotation: -10,
        blur: 2,
      });
      add(card, Rect, {
        x: x + 73,
        y: y + 84,
        width: 116,
        height: 80,
        cornerRadius: 18,
        fill: accent,
        stroke: theme.ink,
        strokeWidth: 1,
        shadow: { x: 12, y: 12, blur: 14, color: "#050817bb" },
        rotation: 8,
      });
      label(card, "Opacity · Blur · Shadow", x + 24, y + cardHeight - 32, 12);
    } else {
      add(card, Line, {
        points: [x + 26, y + 110, x + 104, y + 110],
        stroke: theme.muted,
        strokeWidth: 3,
        dashPattern: [8, 6],
      });
      add(card, Arrow, {
        points: [x + 30, y + 154, x + 174, y + 154],
        stroke: accent,
        strokeWidth: 4,
        endArrow: "arrow",
        startArrow: "circle",
      });
      label(card, "Dashed line · Arrow caps", x + 24, y + cardHeight - 32, 12);
    }
  });
};

export function createTokenScene(selected: string): SceneBuilder {
  return ({ stage, width, height }) => {
    grid(stage, width, height);
    const colors = [
      ["Canvas", theme.canvas],
      ["Surface", theme.surface],
      ["Primary", theme.primary],
      ["Cyan", theme.cyan],
      ["Coral", theme.coral],
      ["Yellow", theme.yellow],
    ];
    const itemWidth = Math.max(118, (width - 54) / 3);
    colors.forEach(([name, color], index) => {
      const x = 18 + (index % 3) * (itemWidth + 9);
      const y = 22 + Math.floor(index / 3) * 126;
      const active = name === selected;
      add(stage, Rect, {
        x,
        y,
        width: itemWidth,
        height: 104,
        cornerRadius: 18,
        fill: active ? theme.surfaceRaised : theme.surface,
        stroke: active ? color : theme.stroke,
        strokeWidth: active ? 3 : 1,
      });
      add(stage, Rect, {
        x: x + 16,
        y: y + 16,
        width: 48,
        height: 48,
        cornerRadius: 12,
        fill: color,
      });
      label(stage, name, x + 76, y + 24, 14, theme.ink);
      label(stage, color, x + 76, y + 48, 11, theme.muted);
    });
    label(
      stage,
      "Shared system font · 8px spacing scale · 18px canvas radius",
      20,
      Math.min(height - 30, 290),
      13,
      theme.muted,
    );
  };
}

export function createPlaygroundScene(selected: number): SceneBuilder {
  return ({ stage, width, height }: SceneContext) => {
    grid(stage, width, height);
    const nodes = [
      {
        x: 52,
        y: 72,
        title: "React",
        color: theme.primary,
        detail: "DOM shell",
      },
      {
        x: Math.max(260, width / 2 - 80),
        y: 164,
        title: "Leafer",
        color: theme.cyan,
        detail: "Scene graph",
      },
      {
        x: Math.max(460, width - 212),
        y: 72,
        title: "Tauri",
        color: theme.coral,
        detail: "Native WebView",
      },
    ];
    add(stage, Arrow, {
      points: [nodes[0].x + 150, nodes[0].y + 52, nodes[1].x, nodes[1].y + 52],
      stroke: theme.muted,
      strokeWidth: 3,
      endArrow: "arrow",
    });
    add(stage, Arrow, {
      points: [nodes[1].x + 150, nodes[1].y + 52, nodes[2].x, nodes[2].y + 52],
      stroke: theme.muted,
      strokeWidth: 3,
      endArrow: "arrow",
    });
    nodes.forEach((node, index) => {
      const active = index === selected;
      add(stage, Rect, {
        x: node.x,
        y: node.y,
        width: 150,
        height: 104,
        cornerRadius: 18,
        fill: active ? theme.surfaceRaised : theme.surface,
        stroke: active ? node.color : theme.stroke,
        strokeWidth: active ? 3 : 1,
        shadow: active
          ? { x: 0, y: 12, blur: 24, color: `${node.color}55` }
          : undefined,
      });
      add(stage, Ellipse, {
        x: node.x + 18,
        y: node.y + 20,
        width: 28,
        height: 28,
        fill: node.color,
      });
      label(stage, node.title, node.x + 58, node.y + 20, 17, theme.ink);
      label(stage, node.detail, node.x + 58, node.y + 48, 12, theme.muted);
    });
    label(
      stage,
      "Use the DOM controls to compare selection, focus, and scale behavior.",
      32,
      Math.min(height - 38, 320),
      13,
      theme.muted,
    );
  };
}
