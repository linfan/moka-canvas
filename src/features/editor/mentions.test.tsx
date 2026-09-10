// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useRef, useState } from "react";
import type {
  AssetId,
  CanvasDocument,
  ResourceEntry,
  WorkflowEdge,
  WorkflowNode,
} from "../../shared/domain";
import {
  createCanvas,
  createNode,
  defaultGenerationSpec,
  mentionNodeIds,
  mentionSpans,
} from "../../shared/domain";
import {
  MENTION_SUMMARY_CHARS,
  mentionBeingTyped,
  mentionChoices,
  mentionGroups,
  mentionToken,
  narrowMentions,
} from "./canvas/mentions";
import { MentionField } from "./components/MentionField";

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

const PICTURE: ResourceEntry = {
  id: "asset-1",
  name: "lantern.png",
  path: "assets/lantern.png",
  mime: "image/png",
  bytes: 20480,
  createdAt: T,
  updatedAt: T,
  probe: {
    mime: "image/png",
    bytes: 20480,
    sha256: "aa",
    width: 512,
    height: 512,
  },
};

const RESOURCES = new Map<AssetId, ResourceEntry>([[PICTURE.id, PICTURE]]);
const ISSUES = new Map<AssetId, "missing">();

/** A text wired into the target, a picture that is not, and one holding nothing. */
const BRIEF = card("text", "n-brief", "Brief", {
  content: "A lantern floats over a quiet lake at dusk, and nobody is about.",
});
const PLATE = card("image", "n-plate", "Plate", { assetId: PICTURE.id });
const BLANK = card("text", "n-blank", "Blank", { content: "   " });
const TARGET = card("image", "n-target", "Target");
const TARGET_SPEC = defaultGenerationSpec("image");
if (!TARGET_SPEC) throw new Error("an image node has a spec");
TARGET.data = { ...TARGET.data, generation: TARGET_SPEC };

const SHEET = sheet(
  [BRIEF, PLATE, BLANK, TARGET],
  [wire("n-brief", "n-target", "e-1")],
);

function choicesOf(node: WorkflowNode = TARGET) {
  return mentionChoices(SHEET, node, RESOURCES, ISSUES);
}

const changed: string[] = [];
const dismissed = vi.fn();
const committed = vi.fn();
const asked = vi.fn();

/** The field, holding its own words the way the panel holds them. */
function Field({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <MentionField
      canvas={SHEET}
      choices={choicesOf()}
      inputRef={areaRef}
      issues={ISSUES}
      label="Prompt"
      onChange={(next) => {
        changed.push(next);
        setValue(next);
      }}
      onCommit={committed}
      onDismiss={dismissed}
      onOffer={() => {}}
      onSubmit={asked}
      placeholder="What should this node make?"
      resources={RESOURCES}
      value={value}
    />
  );
}

function field() {
  return screen.getByLabelText<HTMLTextAreaElement>("Prompt");
}

function offer() {
  return screen.getByRole("listbox", { name: "What this prompt may mention" });
}

function options() {
  return within(offer()).getAllByRole("option");
}

function chips() {
  return screen.getByRole("list", { name: "What this prompt mentions" });
}

beforeEach(() => {
  changed.length = 0;
  dismissed.mockClear();
  committed.mockClear();
  asked.mockClear();
});

afterEach(cleanup);

describe("reading a mention out of a prompt", () => {
  it("writes a mention in the one form the resolver reads", () => {
    expect(mentionToken("n-plate")).toBe("@[node:n-plate]");
  });

  it("finds every finished token with the span it occupies", () => {
    const prompt = "before @[node:a] after @[node:b]";
    const spans = mentionSpans(prompt);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ start: 7, end: 16, nodeId: "a" });
    expect(prompt.slice(spans[1].start, spans[1].end)).toBe("@[node:b]");
  });

  it("stops at a token with no closing bracket", () => {
    // What follows is prose that happens to contain the opening, not a
    // reference, and neither is the opening itself.
    expect(mentionSpans("@[node:a and then nothing")).toEqual([]);
  });

  it("keeps a token naming nothing as a token, but not as a node", () => {
    expect(mentionSpans("@[node:]")).toHaveLength(1);
    expect(mentionNodeIds("@[node:]")).toEqual([]);
  });

  it("offers candidates only for an @ that starts a word", () => {
    expect(mentionBeingTyped("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionBeingTyped("paint @her", 10)).toEqual({
      start: 6,
      query: "her",
    });
    // Part of an address somebody was writing.
    expect(mentionBeingTyped("someone@example", 15)).toBeNull();
    // Whitespace ends the offer.
    expect(mentionBeingTyped("@her there", 10)).toBeNull();
    // A finished mention leaves the caret back in the sentence.
    expect(mentionBeingTyped("@[node:a]", 9)).toBeNull();
    expect(mentionBeingTyped("", 0)).toBeNull();
  });

  it("narrows the offer by what has been typed since the @", () => {
    const groups = choicesOf();
    expect(narrowMentions(groups, "")).toBe(groups);
    const found = narrowMentions(groups, "lantern");
    expect(found.map((group) => group.label)).toEqual(["Text"]);
    expect(narrowMentions(groups, "nothing here")).toEqual([]);
  });
});

describe("what may be mentioned", () => {
  it("groups what is there by the kind of thing it is", () => {
    expect(choicesOf().map((group) => group.label)).toEqual(["Text", "Image"]);
  });

  it("offers what is wired in first, and says why each one is offered", () => {
    const [words, pictures] = choicesOf();
    expect(words.choices[0].node.id).toBe("n-brief");
    expect(words.choices[0].origin).toBe("upstream");
    expect(pictures.choices[0].node.id).toBe("n-plate");
    expect(pictures.choices[0].origin).toBe("canvas");
  });

  it("leaves out the node itself and the ones holding nothing", () => {
    const offered = choicesOf().flatMap((group) =>
      group.choices.map((choice) => choice.node.id),
    );
    expect(offered).not.toContain("n-target");
    expect(offered).not.toContain("n-blank");
  });

  it("carries a picture's thumbnail and what was measured about it", () => {
    const [, pictures] = choicesOf();
    const plate = pictures.choices[0];
    expect(plate.media?.url).toContain(PICTURE.id);
    expect(plate.summary).toBe("512×512");
  });

  it("shows the start of a text rather than the whole of it", () => {
    const [words] = choicesOf();
    const summary = words.choices[0].summary;
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).toHaveLength(MENTION_SUMMARY_CHARS + 1);
  });

  it("offers a node pointed at by hand as one of those, and only once", () => {
    const spec = defaultGenerationSpec("image");
    if (!spec) throw new Error("an image node has a spec");
    spec.referenceNodeIds = ["n-plate", "n-brief"];
    const pointed = card("image", "n-hand", "Hand");
    pointed.data = { ...pointed.data, generation: spec };
    const groups = mentionChoices(
      sheet(
        [...SHEET.nodes, pointed],
        [...SHEET.edges, wire("n-brief", "n-hand", "e-hand")],
      ),
      pointed,
      RESOURCES,
      ISSUES,
    );
    const offered = groups.flatMap((group) =>
      group.choices.map((choice) => ({
        id: choice.node.id,
        origin: choice.origin,
      })),
    );
    // Wired in as well as named: the nearer of the two reasons wins, and the
    // card is not offered twice for being both.
    expect(offered).toEqual([
      { id: "n-brief", origin: "upstream" },
      { id: "n-plate", origin: "reference" },
    ]);
  });

  it("groups a list named by hand the same way, for a caller that is not a node", () => {
    const groups = mentionGroups(
      SHEET,
      [
        { id: "n-plate", origin: "reference" },
        { id: "n-brief", origin: "upstream" },
      ],
      RESOURCES,
      ISSUES,
    );
    expect(groups.map((group) => group.label)).toEqual(["Text", "Image"]);
    expect(groups[0].choices[0].node.id).toBe("n-brief");
    expect(groups[1].choices[0].origin).toBe("reference");
  });

  it("leaves out of a list by hand what is not there, and what holds nothing", () => {
    const groups = mentionGroups(
      SHEET,
      [
        { id: "n-gone", origin: "canvas" },
        { id: "n-blank", origin: "canvas" },
        { id: "n-brief", origin: "canvas" },
        { id: "n-brief", origin: "upstream" },
      ],
      RESOURCES,
      ISSUES,
    );
    expect(
      groups.flatMap((group) => group.choices.map((choice) => choice.node.id)),
    ).toEqual(["n-brief"]);
  });
});

describe("the prompt field", () => {
  it("offers what may be mentioned from an @", async () => {
    render(<Field />);
    expect(screen.queryByRole("listbox")).toBeNull();

    await act(async () => {
      fireEvent.change(field(), { target: { value: "@" } });
    });
    expect(field()).toHaveProperty("ariaExpanded", "true");
    expect(within(offer()).getByText("Text")).toBeTruthy();
    expect(options().map((option) => option.textContent)).toEqual([
      expect.stringContaining("Brief"),
      expect.stringContaining("Plate"),
    ]);
    // A picture is offered as the picture it is. Its thumbnail says nothing to
    // a screen reader, since the name beside it already does.
    expect(options()[1].querySelector("img")).toHaveProperty(
      "src",
      expect.stringContaining(PICTURE.id),
    );
  });

  it("says when nothing on the canvas answers to what was typed", async () => {
    render(<Field />);
    await act(async () => {
      fireEvent.change(field(), { target: { value: "@zzz" } });
    });
    expect(offer().textContent).toContain(
      "Nothing on this canvas answers to that.",
    );
  });

  it("writes the token, not the title, when a candidate is taken", async () => {
    render(<Field initial="paint " />);
    await act(async () => {
      fireEvent.change(field(), { target: { value: "paint @pla" } });
    });
    const [plate] = options();
    await act(async () => {
      fireEvent.click(plate);
    });
    expect(changed.at(-1)).toBe(`paint ${mentionToken("n-plate")} `);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("walks the offer with the arrow keys and takes one with Enter", async () => {
    render(<Field />);
    await act(async () => {
      fireEvent.change(field(), { target: { value: "@" } });
    });
    expect(options()[0]).toHaveProperty("ariaSelected", "true");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "ArrowDown" });
    });
    expect(options()[1]).toHaveProperty("ariaSelected", "true");
    // And the field says which one the keyboard is holding.
    expect(field().getAttribute("aria-activedescendant")).toBe(options()[1].id);

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });
    expect(changed.at(-1)).toBe(`${mentionToken("n-plate")} `);
  });

  it("closes the offer on Escape before it closes the panel", async () => {
    render(<Field />);
    await act(async () => {
      fireEvent.change(field(), { target: { value: "@" } });
    });
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Escape" });
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(dismissed).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Escape" });
    });
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  it("draws what the prompt points at as a chip carrying the picture", () => {
    render(<Field initial={`over ${mentionToken("n-plate")} again`} />);
    const chip = within(chips()).getByText("Plate").parentElement;
    if (!chip) throw new Error("a chip is an element");
    expect(chip.querySelector("img")).toHaveProperty(
      "src",
      expect.stringContaining(PICTURE.id),
    );
  });

  it("reads as broken when the prompt points at a card that is gone", () => {
    render(<Field initial={mentionToken("n-deleted")} />);
    expect(chips().textContent).toContain("a node that is gone");
    expect(chips().querySelector(".is-gone")).toBeTruthy();
  });

  it("takes a mention out whole from its chip", async () => {
    const token = mentionToken("n-plate");
    render(<Field initial={`over ${token} again`} />);
    await act(async () => {
      fireEvent.click(
        within(chips()).getByRole("button", {
          name: "Take Plate out of the prompt",
        }),
      );
    });
    expect(changed.at(-1)).toBe("over  again");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("takes a mention out whole with the keyboard too", async () => {
    const token = mentionToken("n-plate");
    render(<Field initial={`over ${token}`} />);
    const area = field();
    await act(async () => {
      area.setSelectionRange(area.value.length, area.value.length);
      fireEvent.keyDown(area, { key: "Backspace" });
    });
    // One character at a time would leave a bracket and half an id among the
    // words, which reads as prose and resolves as nothing.
    expect(changed.at(-1)).toBe("over ");
  });

  it("summons what a chip points at when it is hovered", async () => {
    render(<Field initial={mentionToken("n-brief")} />);
    expect(screen.queryByTestId("mention-look")).toBeNull();
    await act(async () => {
      fireEvent.mouseEnter(chips().querySelector(".mention-chip")!);
    });
    const look = screen.getByTestId("mention-look");
    expect(look.textContent).toContain("A lantern floats");
  });

  it("commits on losing focus and asks on a command Enter", async () => {
    render(<Field />);
    await act(async () => {
      fireEvent.blur(field());
    });
    expect(committed).toHaveBeenCalledTimes(1);
    expect(asked).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    });
    // The ask saves the words itself, so the field does not commit on the way
    // and write the same thing twice.
    expect(asked).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
  });
});
