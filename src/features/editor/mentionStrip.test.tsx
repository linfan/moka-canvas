// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  createCanvas,
  createNode,
  type AssetId,
  type ResourceEntry,
  type WorkflowNode,
} from "../../shared/domain";
import { MentionStrip } from "./components/MentionStrip";

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

function entry(id: string, name: string, mime: string): ResourceEntry {
  return {
    id,
    name,
    path: `assets/${name}`,
    mime,
    bytes: 20480,
    createdAt: T,
    updatedAt: T,
    probe: { mime, bytes: 20480, sha256: "aa" },
  };
}

const PICTURE = entry("asset-1", "lantern.png", "image/png");
const SONG = entry("asset-2", "theme.mp3", "audio/mpeg");
const SHOT = entry("asset-3", "opening.mp4", "video/mp4");

const RESOURCES = new Map<AssetId, ResourceEntry>([
  [PICTURE.id, PICTURE],
  [SONG.id, SONG],
  [SHOT.id, SHOT],
]);

const LONG = "A lantern floats over a quiet lake at dusk, and nobody is about.";

const BRIEF = card("text", "n-brief", "Brief", { content: LONG });
const PLATE = card("image", "n-plate", "Plate", { assetId: PICTURE.id });
const VOICE = card("audio", "n-voice", "Voice", { assetId: SONG.id });
const SHOT_NODE = card("video", "n-shot", "Shot", { assetId: SHOT.id });

function sheet(nodes: WorkflowNode[]) {
  const made = createCanvas("Canvas");
  made.nodes = nodes;
  return made;
}

const SHEET = sheet([BRIEF, PLATE, VOICE, SHOT_NODE]);

function stripOf(prompt: string) {
  render(
    <MentionStrip
      canvas={SHEET}
      issues={new Map()}
      prompt={prompt}
      resources={RESOURCES}
    />,
  );
  return screen.getByRole("list", { name: "What this prompt refers to" });
}

afterEach(cleanup);

describe("what a prompt refers to", () => {
  it("holds nothing for words that name no card", () => {
    render(
      <MentionStrip
        canvas={SHEET}
        issues={new Map()}
        prompt="A lantern over a lake, painted"
        resources={RESOURCES}
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("lifts every named card into the list, in the order it is named", () => {
    const strip = stripOf(
      "Paint @[node:n-plate] in the style of @[node:n-brief]",
    );
    const items = [...strip.querySelectorAll(".mention-strip-item")];
    expect(items.map((item) => item.getAttribute("data-node-id"))).toEqual([
      "n-plate",
      "n-brief",
    ]);
    // A picture is shown as the picture it is...
    expect(items[0].querySelector("img")?.getAttribute("src")).toContain(
      "/api/v1/projects/current/assets/asset-1",
    );
    // ...and a text as its own mark, having no picture to be shown as.
    expect(items[1].querySelector("img")).toBeNull();
    expect(items[1].textContent).toBe("¶");
  });

  it("names a card once however many times the words name it", () => {
    const strip = stripOf("@[node:n-plate] and again @[node:n-plate]");
    expect(strip.querySelectorAll(".mention-strip-item")).toHaveLength(1);
  });

  it("plays an audio and reads out a text when the pointer rests on it", async () => {
    const strip = stripOf("From @[node:n-brief] and @[node:n-voice]");
    const [, voice] = strip.querySelectorAll(".mention-strip-item");

    await act(async () => {
      fireEvent.mouseOver(strip.querySelectorAll(".mention-strip-item")[0]);
    });
    let look = screen.getByTestId("mention-strip-look");
    // The whole of it: a hover that stops mid-sentence has not answered the
    // question the hover was asking.
    expect(look.textContent).toContain(LONG);
    expect(look.textContent).toContain("Brief");
    expect(look.querySelector("audio")).toBeNull();

    await act(async () => {
      fireEvent.mouseOver(voice);
    });
    look = screen.getByTestId("mention-strip-look");
    const player = look.querySelector("audio");
    expect(player?.getAttribute("src")).toContain(
      "/api/v1/projects/current/assets/asset-2",
    );
    expect(player?.hasAttribute("autoplay")).toBe(true);
  });

  it("shows a shot's own file where no poster stands in for it", () => {
    const strip = stripOf("Cut to @[node:n-shot]");
    const shot = strip.querySelector(".mention-strip-item");
    expect(shot?.querySelector("img")).toBeNull();
    expect(shot?.querySelector("video")?.getAttribute("src")).toContain(
      "/api/v1/projects/current/assets/asset-3",
    );
  });

  it("marks a reference to a card that is gone, and says so", async () => {
    const strip = stripOf("Paint @[node:n-deleted]");
    const item = strip.querySelector(".mention-strip-item");
    expect(item).toBeTruthy();
    expect(item?.className).toContain("is-gone");
    expect(item?.textContent).toBe("?");

    await act(async () => {
      fireEvent.mouseOver(item!);
    });
    expect(screen.getByTestId("mention-strip-look").textContent).toContain(
      "A node that is gone",
    );
  });
});
