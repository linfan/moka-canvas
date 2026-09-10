import { describe, expect, it } from "vitest";
import type {
  CanvasDocument,
  GenerationSpec,
  WorkflowEdge,
  WorkflowNode,
} from "../../shared/domain";
import {
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  createCanvas,
  createNode,
} from "../../shared/domain";
import { madeWords, planCard, type CardPlan } from "./cards";

/**
 * Cards parked far from the middle of the view.
 *
 * A card that has nothing to do with where the new one lands would otherwise
 * move it along by itself, and the tests about where it lands would be reading
 * that instead.
 */
const PARKED = { x: -4000, y: -4000 };

function card(
  kind: WorkflowNode["kind"],
  id: string,
  title: string,
  data: Record<string, unknown> = {},
  at: { x: number; y: number } = PARKED,
): WorkflowNode {
  const made = createNode(kind, at);
  made.id = id;
  made.title = title;
  made.data = { ...made.data, ...data };
  return made;
}

function sheet(nodes: WorkflowNode[]): CanvasDocument {
  const made = createCanvas("Canvas");
  made.nodes = nodes;
  made.edges = [];
  return made;
}

const BRIEF = card("text", "n-brief", "Brief", { content: "A lantern." });
const PLATE = card("image", "n-plate", "Plate", { assetId: "asset-plate" });
const OTHER = card("image", "n-other", "Other", { assetId: "asset-other" });
const SHOT = card("video", "n-shot", "Shot", { assetId: "asset-shot" });

const cardsOf = (plan: CardPlan): WorkflowNode[] =>
  plan.commands.flatMap((command) =>
    command.type === "addNode" ? [command.node] : [],
  );

const wiresOf = (plan: CardPlan): WorkflowEdge[] =>
  plan.commands.flatMap((command) =>
    command.type === "addEdge" ? [command.edge] : [],
  );

/** Which canvas each command names — null for one that carries no canvas at all. */
const canvasOfEach = (plan: CardPlan) =>
  plan.commands.map((command) =>
    command.type === "addNode" || command.type === "addEdge"
      ? command.canvasId
      : null,
  );

function wireOf(plan: CardPlan, from: string): WorkflowEdge {
  const found = wiresOf(plan).find((edge) => edge.source.nodeId === from);
  if (!found) throw new Error(`Nothing was wired from ${from}`);
  return found;
}

function specOf(node: WorkflowNode): GenerationSpec {
  return (node.data as { generation: GenerationSpec }).generation;
}

describe("planCard", () => {
  it("brings the card first and its wires after, as one thing to undo", () => {
    const canvas = sheet([BRIEF, PLATE]);
    const plan = planCard({
      canvas,
      kind: "image",
      title: "Wider",
      asked: "a wider shot",
      sources: [BRIEF, PLATE],
    });
    // A wire cannot land on a card that has not landed, so the order matters.
    expect(plan.commands.map((command) => command.type)).toEqual([
      "addNode",
      "addEdge",
      "addEdge",
    ]);
    expect(cardsOf(plan)[0].title).toBe("Wider");
    expect(canvasOfEach(plan)).toEqual(plan.commands.map(() => canvas.id));
    expect(
      wiresOf(plan).every((edge) => edge.target.nodeId === plan.nodeId),
    ).toBe(true);
  });

  it("puts the card where the reader is looking", () => {
    // With no view attached, the middle of the board is the best answer there is.
    const plan = planCard({
      canvas: sheet([BRIEF]),
      kind: "image",
      title: "Wider",
      asked: "a wider shot",
      sources: [],
    });
    expect(cardsOf(plan)[0].bounds).toEqual({
      x: -DEFAULT_NODE_WIDTH / 2,
      y: -40,
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    });
  });

  it("steps clear of a card already sitting where it would land", () => {
    const inTheWay = card(
      "text",
      "n-way",
      "In the way",
      { content: "x" },
      { x: -DEFAULT_NODE_WIDTH / 2, y: -40 },
    );
    const plan = planCard({
      canvas: sheet([inTheWay]),
      kind: "image",
      title: "Wider",
      asked: "a wider shot",
      sources: [],
    });
    const { x, y } = cardsOf(plan)[0].bounds;
    expect({ x, y }).not.toEqual({ x: -DEFAULT_NODE_WIDTH / 2, y: -40 });
    // Stepped until it was clear of the card that was there, rather than
    // dropping on top of it or refusing the ask.
    const clear =
      x >= -DEFAULT_NODE_WIDTH / 2 + DEFAULT_NODE_WIDTH ||
      y >= -40 + DEFAULT_NODE_HEIGHT;
    expect(clear).toBe(true);
  });

  it("writes the ask onto the card as its own prompt", () => {
    const plan = planCard({
      canvas: sheet([]),
      kind: "image",
      title: "Wider",
      asked: "a wider shot of the lake",
      sources: [],
    });
    const spec = specOf(cardsOf(plan)[0]);
    expect(spec.prompt).toBe("a wider shot of the lake");
    // Everything else is left to come from upstream, which is what lets a reader
    // edit the ask afterwards the way they would edit any other card.
    expect(spec.inputMode).toBe("upstream");
    expect(spec.model).toBe("");
    expect(spec.capability).toBe("image");
  });

  it("plugs each kind of card into the input that takes it", () => {
    const plan = planCard({
      canvas: sheet([BRIEF, PLATE]),
      kind: "image",
      title: "Wider",
      asked: "a wider shot",
      sources: [BRIEF, PLATE],
    });
    expect(wireOf(plan, "n-brief").target.portId).toBe("prompt");
    // A picture goes to the input that takes several, not into the mask somebody
    // was saving for later.
    expect(wireOf(plan, "n-plate").target.portId).toBe("images");
    expect(plan.wired).toEqual(["n-brief", "n-plate"]);
  });

  it("sends several pictures to the input that takes many", () => {
    const plan = planCard({
      canvas: sheet([PLATE, OTHER]),
      kind: "video",
      title: "Move",
      asked: "let it move",
      sources: [PLATE, OTHER],
    });
    expect(wiresOf(plan).map((edge) => edge.target.portId)).toEqual([
      "images",
      "images",
    ]);
    expect(plan.wired).toEqual(["n-plate", "n-other"]);
  });

  it("leaves out a source the card has no input for, and says so", () => {
    const plan = planCard({
      canvas: sheet([BRIEF, SHOT]),
      kind: "image",
      title: "Wider",
      asked: "a wider shot",
      sources: [BRIEF, SHOT],
    });
    // A picture card takes words and pictures; a moving one is neither.
    expect(wiresOf(plan)).toHaveLength(1);
    expect(plan.wired).toEqual(["n-brief"]);
  });

  it("takes a source along once, where several of its outputs would fit", () => {
    const composed = card("operation", "n-op", "Composed", {
      assetId: "asset-op",
    });
    const plan = planCard({
      canvas: sheet([composed]),
      kind: "image",
      title: "Wider",
      asked: "a wider shot",
      sources: [composed],
    });
    expect(wiresOf(plan)).toHaveLength(1);
    expect(plan.wired).toEqual(["n-op"]);
  });
});

describe("madeWords", () => {
  it("counts what came back, in the words the card was asked in", () => {
    expect(madeWords("image", 1)).toBe("Made 1 image");
    expect(madeWords("image", 3)).toBe("Made 3 images");
    expect(madeWords("video", 2)).toBe("Made 2 videos");
    expect(madeWords("audio", 1)).toBe("Made 1 sound");
  });

  it("says that nothing came, since the card is still on the canvas", () => {
    expect(madeWords("image", 0)).toBe("Made nothing");
  });
});
