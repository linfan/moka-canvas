import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  AssistantRole,
  CanvasDocument,
  WorkflowEdge,
  WorkflowNode,
} from "../../shared/domain";
import { createCanvas, createNode } from "../../shared/domain";
import { mentionToken } from "../editor/canvas/mentions";
import {
  ASSISTANT_CONTEXT_CHARS,
  ASSISTANT_PICTURE_LIMIT,
  askOf,
  capabilityFor,
  earlierWords,
  referenceNodes,
  referenceSummary,
  upstreamOf,
} from "./asking";

const T = "2026-01-01T00:00:00.000Z";

function card(
  kind: WorkflowNode["kind"],
  id: string,
  title: string,
  data: Record<string, unknown> = {},
): WorkflowNode {
  const made = createNode(kind, { x: 0, y: 0 });
  made.id = id;
  made.title = title;
  made.data = { ...made.data, ...data };
  return made;
}

function wire(from: string, to: string, id: string): WorkflowEdge {
  return {
    id,
    source: { nodeId: from, portId: "out" },
    target: { nodeId: to, portId: "prompt" },
    createdAt: T,
  };
}

function sheet(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
): CanvasDocument {
  const made = createCanvas("Canvas");
  made.nodes = nodes;
  made.edges = edges;
  return made;
}

const SEED = card("text", "n-seed", "Seed", { content: "A quiet lake." });
const STUDY = card("text", "n-study", "Study", {
  content: "Dusk, nobody about.",
});
const PLATE = card("image", "n-plate", "Plate", { assetId: "asset-plate" });
const SHOT = card("video", "n-shot", "Shot", { assetId: "asset-shot" });
const BLANK = card("text", "n-blank", "Blank", { content: "   " });

/** Seed → Study → Plate → Shot, with Blank wired in from nowhere. */
const CHAIN = sheet(
  [SEED, STUDY, PLATE, SHOT, BLANK],
  [
    wire("n-seed", "n-study", "e-1"),
    wire("n-study", "n-plate", "e-2"),
    wire("n-plate", "n-shot", "e-3"),
  ],
);

const ids = (nodes: readonly WorkflowNode[]) => nodes.map((node) => node.id);

const aboutIds = (ask: { references: { nodeId: string }[] }) =>
  ask.references.map((reference) => reference.nodeId);

describe("upstreamOf", () => {
  it("walks a chain all the way back rather than one wire", () => {
    expect(upstreamOf(CHAIN, ["n-shot"]).sort()).toEqual([
      "n-plate",
      "n-seed",
      "n-study",
    ]);
  });

  it("leaves out what it started from, and what nothing leads to", () => {
    expect(upstreamOf(CHAIN, ["n-seed"])).toEqual([]);
    expect(upstreamOf(CHAIN, ["n-shot"])).not.toContain("n-shot");
    expect(upstreamOf(CHAIN, ["n-shot"])).not.toContain("n-blank");
  });

  it("counts a card once however many ways it feeds in", () => {
    const twice = sheet(
      [SEED, STUDY, PLATE],
      [
        wire("n-seed", "n-plate", "e-1"),
        wire("n-study", "n-plate", "e-2"),
        wire("n-seed", "n-study", "e-3"),
      ],
    );
    expect(upstreamOf(twice, ["n-plate"]).sort()).toEqual([
      "n-seed",
      "n-study",
    ]);
  });

  it("walks a loop once rather than for ever", () => {
    const round = sheet(
      [SEED, STUDY],
      [wire("n-seed", "n-study", "e-1"), wire("n-study", "n-seed", "e-2")],
    );
    expect(upstreamOf(round, ["n-seed"])).toEqual(["n-study"]);
  });
});

describe("referenceNodes", () => {
  it("takes what was chosen, then what feeds it, then what was named", () => {
    const about = referenceNodes(CHAIN, ["n-shot"], ["n-blank"]);
    expect(ids(about)).toEqual([
      "n-shot",
      "n-plate",
      "n-study",
      "n-seed",
      "n-blank",
    ]);
  });

  it("does not offer the same card twice when it is named as well as chosen", () => {
    expect(
      ids(referenceNodes(CHAIN, ["n-shot"], ["n-seed", "n-shot"])),
    ).toEqual(["n-shot", "n-plate", "n-study", "n-seed"]);
  });

  it("leaves out an id that is not on this canvas", () => {
    expect(ids(referenceNodes(CHAIN, ["n-gone"], ["n-seed"]))).toEqual([
      "n-seed",
    ]);
  });
});

describe("referenceSummary", () => {
  it("counts what is being sent, in the order it reads", () => {
    const ask = askOf(
      "answer",
      referenceNodes(CHAIN, ["n-shot"], ["n-blank"]),
      "all of it",
    );
    // The empty card is pointed at and sends nothing, so it is not counted.
    expect(referenceSummary(ask.references)).toBe("2 text · 1 image · 1 video");
  });

  it("says nothing when nothing is being sent", () => {
    expect(referenceSummary([])).toBe("");
  });
});

describe("askOf", () => {
  it("writes a mention as the card's name and keeps no id", () => {
    const ask = askOf(
      "answer",
      [PLATE],
      `what is ${mentionToken("n-plate")} doing`,
    );
    expect(ask.asked).toBe("what is [Plate] doing");
    expect(ask.request.prompt).toContain("what is [Plate] doing");
    expect(ask.request.prompt).not.toContain("n-plate");
  });

  it("says so when a mention names a card that is not being sent", () => {
    const ask = askOf("answer", [], `${mentionToken("n-gone")} again`);
    expect(ask.asked).toBe("[a card that is gone] again");
  });

  it("quotes what a text card says under the card's name", () => {
    const ask = askOf("answer", [STUDY], "read it back");
    expect(ask.request.prompt).toBe(
      "[Study]\nDusk, nobody about.\n\n---\n\nread it back",
    );
  });

  it("sends a picture by the asset it already holds rather than by its bytes", () => {
    const ask = askOf("answer", [PLATE], "what is in it");
    expect(ask.request.inputs).toEqual([
      { role: "reference", assetId: "asset-plate" },
    ]);
    expect(ask.request.prompt).toBe("what is in it");
  });

  it("leaves a card holding nothing out, and does not count it as left behind", () => {
    const ask = askOf("answer", [BLANK], "anything");
    expect(ask.request.prompt).toBe("anything");
    expect(ask.references).toEqual([]);
    expect(ask.leftOut).toBe(0);
  });

  it("remembers what a turn was about as a snapshot, not as a pointer", () => {
    const ask = askOf("answer", [STUDY, PLATE], "compare these");
    expect(ask.references).toEqual([
      { nodeId: "n-study", title: "Study", kind: "text" },
      {
        nodeId: "n-plate",
        title: "Plate",
        kind: "image",
        assetId: "asset-plate",
      },
    ]);
  });

  it("asks for an answer or for a rewrite by saying which", () => {
    const asked = askOf("answer", [], "what happened").request.system;
    const rewrote = askOf("rewrite", [], "shorter").request.system;
    expect(asked).toContain("Answer from the cards");
    expect(rewrote).toContain("Return only that text");
    expect(rewrote).not.toBe(asked);
  });

  it("names the model picked for it, and none where none was picked", () => {
    expect(askOf("answer", [], "hello", "", "kept-words").request.model).toBe(
      "kept-words",
    );
    expect(
      askOf("answer", [], "hello", "", null).request.model,
    ).toBeUndefined();
    expect(askOf("answer", [], "hello").request.model).toBeUndefined();
  });

  it("leaves a card that does not fit behind and says how many", () => {
    const long = card("text", "n-long", "Long", {
      content: "x".repeat(ASSISTANT_CONTEXT_CHARS),
    });
    const ask = askOf("answer", [long, STUDY], "both");
    expect(ask.leftOut).toBe(1);
    expect(ask.request.prompt).toContain("[Study]");
    expect(ask.request.prompt).not.toContain("[Long]");
    // A card that did not fit did not spend the room the next one needed.
    expect(aboutIds(ask)).toEqual(["n-study"]);
  });

  it("sends at most so many pictures, and counts the rest", () => {
    const plates = Array.from(
      { length: ASSISTANT_PICTURE_LIMIT + 2 },
      (_, at) =>
        card("image", `n-${at}`, `Plate ${at}`, { assetId: `asset-${at}` }),
    );
    const ask = askOf("answer", plates, "all of them");
    expect(ask.request.inputs).toHaveLength(ASSISTANT_PICTURE_LIMIT);
    expect(ask.leftOut).toBe(2);
    expect(ask.references).toHaveLength(ASSISTANT_PICTURE_LIMIT);
  });

  it("carries what was said before only when it is handed over", () => {
    const earlier = "Earlier in this conversation:\nYou: what happened";
    const plain = askOf("answer", [SEED], "and the lake?");
    const withMemory = askOf("answer", [SEED], "and the lake?", earlier);
    expect(plain.request.prompt).not.toContain("Earlier in");
    expect(withMemory.request.prompt).toContain(earlier);
    // The question is still what is being asked, wherever the memory sits.
    expect(withMemory.request.prompt?.endsWith("and the lake?")).toBe(true);
    expect(withMemory.asked).toBe("and the lake?");
  });
});

describe("earlierWords", () => {
  let made = 0;
  function said(role: AssistantRole, words: string): AssistantMessage {
    made += 1;
    return { id: `m-${made}`, role, text: words, createdAt: T };
  }

  it("says nothing before it has been asked for", () => {
    expect(
      earlierWords(
        [said("user", "what happened"), said("assistant", "dusk")],
        null,
      ),
    ).toBe("");
  });

  it("takes the last few, oldest first, and says who said each", () => {
    const lines = [
      said("user", "first?"),
      said("assistant", "first."),
      said("user", "second?"),
      said("assistant", "second."),
    ];
    expect(earlierWords(lines, 2)).toBe(
      "Earlier in this conversation:\nYou: second?\nAssistant: second.",
    );
  });

  it("leaves a line with nothing in it out of the count", () => {
    const lines = [
      said("user", "first?"),
      said("assistant", "   "),
      said("user", "second?"),
    ];
    expect(earlierWords(lines, 2)).toBe(
      "Earlier in this conversation:\nYou: first?\nYou: second?",
    );
  });

  it("sends as much as the conversation holds when less was asked for", () => {
    const lines = [said("user", "only one")];
    expect(earlierWords(lines, 8)).toBe(
      "Earlier in this conversation:\nYou: only one",
    );
  });

  it("sends nothing that would not fit beside the question", () => {
    const lines = [
      said("user", "x".repeat(ASSISTANT_CONTEXT_CHARS + 1)),
      said("assistant", "y".repeat(ASSISTANT_CONTEXT_CHARS + 1)),
    ];
    expect(earlierWords(lines, 2)).toBe("");
  });
});

describe("askOf, asked for a card", () => {
  it("sends no message of its own and says which card it wants", () => {
    const ask = askOf("image", [STUDY, PLATE], "a wider shot");
    expect(ask.kind).toBe("image");
    // What a generation takes is what is wired into it, so there is no request
    // to speak of — the cards reach the model over the graph instead.
    expect(ask.request).toBeNull();
    expect(aboutIds(ask)).toEqual(["n-study", "n-plate"]);
  });

  it("keeps the cards it is about rather than leaving a long one behind", () => {
    // Nothing is quoted into a prompt that this never sends, so the ceiling on
    // quoted text does not apply: the card reads what it is wired to itself.
    const long = card("text", "n-long", "Long", {
      content: "x".repeat(ASSISTANT_CONTEXT_CHARS + 1_000),
    });
    const ask = askOf("image", [long], "wider");
    expect(ask.leftOut).toBe(0);
    expect(aboutIds(ask)).toEqual(["n-long"]);
  });

  it("still caps the pictures, which are paid for either way", () => {
    const plates = Array.from(
      { length: ASSISTANT_PICTURE_LIMIT + 3 },
      (_, at) =>
        card("image", `n-${at}`, `Plate ${at}`, { assetId: `asset-${at}` }),
    );
    const ask = askOf("video", plates, "moving");
    expect(ask.references).toHaveLength(ASSISTANT_PICTURE_LIMIT);
    expect(ask.leftOut).toBe(3);
  });

  it("writes the question out the same way, mentions and all", () => {
    const ask = askOf("audio", [PLATE], `make ${mentionToken("n-plate")} hum`);
    expect(ask.asked).toBe("make [Plate] hum");
  });
});

describe("capabilityFor", () => {
  it("names the model each intent would have to have one of", () => {
    expect(capabilityFor("answer")).toBe("text");
    expect(capabilityFor("rewrite")).toBe("text");
    expect(capabilityFor("image")).toBe("image");
    expect(capabilityFor("video")).toBe("video");
    // A sound card starts as a voice, which is where a run made from it asks.
    expect(capabilityFor("audio")).toBe("speech");
  });
});
