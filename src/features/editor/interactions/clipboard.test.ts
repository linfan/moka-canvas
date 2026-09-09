import { describe, expect, it } from "vitest";
import {
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  generationNodeIds,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import {
  findNode,
  mentionNodeIds,
  type GenerationSpec,
  type MokaFile,
  type WorkflowNode,
} from "../../../shared/domain";
import { mentionToken } from "../canvas/mentions";
import { buildFragment, instantiateFragment } from "./clipboard";

const ids = generationNodeIds();

/** The ask a node carries, which every node in these fixtures has but one. */
function asked(node: WorkflowNode): GenerationSpec {
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  if (!spec) throw new Error("the node carries an ask");
  return spec;
}

function copyOf(nodes: WorkflowNode[], title: string): WorkflowNode {
  const found = nodes.find((node) => node.title === title);
  if (!found) throw new Error(`the copies include ${title}`);
  return found;
}

function instantiate(moka: MokaFile, nodeIds: string[]) {
  const canvas = moka.canvas[0];
  const fragment = buildFragment(canvas, nodeIds);
  if (!fragment) throw new Error("the nodes are on the canvas");
  return instantiateFragment(fragment, moka, { x: 0, y: 400 });
}

describe("what a copy is pointed at", () => {
  it("points a copied ask at the copies beside it", () => {
    const moka = buildGenerationMokaFile();

    const { nodes } = instantiate(moka, [ids.text, ids.image]);
    const words = copyOf(nodes, "Brief");
    const poster = copyOf(nodes, "Poster");
    expect(words.id).not.toBe(ids.text);

    // Both the words in the ask and the list written beside them follow the
    // copy, so what arrives asks about the node that arrived with it rather
    // than the one that was left on the other canvas.
    expect(asked(poster).prompt).toBe(
      `Paint ${mentionToken(words.id)} as a poster.`,
    );
    expect(asked(poster).referenceNodeIds).toEqual([words.id]);
  });

  it("leaves a mention of a node that was not copied alone", () => {
    const moka = buildGenerationMokaFile();

    const { nodes } = instantiate(moka, [ids.image]);
    const poster = copyOf(nodes, "Poster");

    // The ask still names the node it was written about. It is not this
    // canvas's business to guess at a replacement, and the panel says so when
    // the name cannot be reached from here.
    expect(mentionNodeIds(asked(poster).prompt)).toEqual([ids.text]);
    expect(asked(poster).referenceNodeIds).toEqual([ids.text]);
  });

  it("moves the mentions it carries and keeps the words around them", () => {
    const moka = buildGenerationMokaFile();
    const canvas = moka.canvas[0];
    const words = findNode(canvas, ids.text);
    if (!words) throw new Error("the fixture carries the brief");

    // A short id, so the token that replaces it is a different length: what
    // follows in the sentence has to survive being written around.
    words.id = "brief";
    for (const edge of canvas.edges) {
      if (edge.source.nodeId === ids.text) edge.source.nodeId = "brief";
    }
    asked(copyOf(canvas.nodes, "Poster")).prompt =
      "Paint @[node:brief] beside @[node:elsewhere] in ink.";

    const { nodes } = instantiate(moka, ["brief", ids.image]);
    const poster = copyOf(nodes, "Poster");
    const carried = copyOf(nodes, "Brief");

    expect(asked(poster).prompt).toBe(
      `Paint ${mentionToken(carried.id)} beside @[node:elsewhere] in ink.`,
    );
  });

  it("copies a node that was never asked anything", () => {
    const golden = goldenNodeIds();
    const moka = buildGoldenMokaFile();

    const { nodes } = instantiate(moka, [golden.text]);

    expect(copyOf(nodes, "Brief").data).toEqual(
      findNode(moka.canvas[0], golden.text)?.data,
    );
  });
});
