// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type {
  StoryJobItemDraft,
  StoryJobKind,
  StoryJobRecord,
} from "../../../api/story";
import type { MokaFile } from "../../../shared/domain";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { actCast } from "../../../shared/domain/story";
import { undo } from "../../editor/commands/execute";
import { SHELF_PAGE } from "../../editor/panels/shelfFilter";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { StoryPage } from "../StoryPage";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";

const ids = storyIds();

/** What the room handed the server, in the order it handed it over. */
let starts: Array<{ kind: StoryJobKind; items: StoryJobItemDraft[] }> = [];
/** The batches the server is holding, newest first. */
let held: StoryJobRecord[] = [];
/** What each piece of the next batch is answered with, by the piece's id. */
let answers: Record<string, string> = {};
/** The files a picture ask comes home with, by the piece's id. */
let pictures: Record<string, string[]> = {};

/**
 * The server under the test: the project as it stands, the batches the room
 * starts, and the answers they come home with.
 *
 * A batch is answered when it is asked about on its own, which is what a poll
 * and a room coming back to a batch both do — a picture piece comes home with
 * the file it drew, a written one with the text it wrote.
 */
function serving(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (payload: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(payload), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (url.includes("/story/jobs")) {
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            kind: StoryJobKind;
            items: StoryJobItemDraft[];
          };
          starts.push({ kind: body.kind, items: body.items });
          const record = batchOf(starts.length, body.kind, body.items);
          held = [record, ...held];
          return json(record);
        }
        const one = /\/story\/jobs\/([^/?]+)/.exec(url);
        if (one !== null) {
          const found = held.find((job) => job.id === one[1]);
          if (found === undefined) {
            return json({ code: "NOT_FOUND", message: "no" }, 404);
          }
          const home = answered(found);
          held = [home, ...held.filter((job) => job.id !== found.id)];
          return json(home);
        }
        return json(held);
      }
      if (url.includes("/api/v1/projects/current")) {
        return json({
          root: "/tmp/moka-elements-test",
          moka: useProjectStore.getState().moka,
          selfCheck: { ok: true, issues: [] },
        });
      }
      return json({});
    }),
  );
}

/** A batch as it is handed over: every piece still going. */
function batchOf(
  number: number,
  kind: StoryJobKind,
  items: StoryJobItemDraft[],
): StoryJobRecord {
  return {
    id: `job-${number}`,
    projectId: "project-1",
    storyId: useProjectStore.getState().moka?.stories?.[0]?.id ?? ids.story,
    kind,
    status: "running",
    model: kind === "elements" ? "a-storyteller" : "a-painter",
    items: items.map((item) => ({
      ...item,
      inputs: item.inputs ?? [],
      params: item.params ?? {},
      status: "running",
    })),
    cancelRequested: false,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  };
}

/** The same batch as it comes home, every piece answered as the test said. */
function answered(record: StoryJobRecord): StoryJobRecord {
  return {
    ...record,
    status: "succeeded",
    items: record.items.map((item) => ({
      ...item,
      status: "succeeded" as const,
      ...(answers[item.id] !== undefined ? { text: answers[item.id] } : {}),
      ...(pictures[item.id] !== undefined
        ? { assetIds: pictures[item.id] }
        : {}),
    })),
  };
}

/** The batch the room started last, coming home with its answers. */
async function comesBack(): Promise<void> {
  const found = held.find((job) => job.id === `job-${starts.length}`);
  if (found === undefined) throw new Error("a batch was started first");
  await act(async () => {
    await useStoryJobStore.getState().adopt(found.id);
  });
}

function openRoom(moka: MokaFile): void {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-elements-test",
    selfCheck: { ok: true, issues: [] },
  });
  useStoryStore.getState().adopt(moka);
  render(<StoryPage />);
}

/** One element's card, which is where its own slots live. */
function card(name: string, kind: string): HTMLElement {
  return screen.getByTestId(`story-element-${kind}-${name}`);
}

/** The room as a reader reaches step three: the page, standing on elements. */
function openAtElements(moka: MokaFile): void {
  openRoom(moka);
  fireEvent.click(screen.getByTestId("story-step-elements"));
}

function story() {
  const held = useProjectStore.getState().moka?.stories?.[0];
  if (held === undefined) throw new Error("a story is open");
  return held;
}

function element(name: string) {
  return story().elements.find((held) => held.name === name);
}

function slotOf(name: string, view: "main" | "turnaround") {
  const held = element(name);
  if (held === undefined) throw new Error(`no element named ${name}`);
  return view === "main" ? held.main : held.turnaround;
}

/** The cast an ask is answered with, in the shape a model answers in. */
function castAnswer(
  characters: Array<{ name: string; description: string; chapters?: number[] }>,
  scenes: Array<{ name: string; description: string }> = [],
  props: Array<{ name: string; description: string }> = [],
): string {
  return JSON.stringify({ characters, scenes, props });
}

beforeEach(() => {
  starts = [];
  held = [];
  answers = {};
  pictures = {};
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("finding the cast in the chapters", () => {
  it("reads the chapters once and writes what they hold into the story", async () => {
    openAtElements(buildStoryMokaFile());
    expect(screen.getByTestId("story-elements-counts").textContent).toContain(
      "2 characters",
    );

    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    // The story already holds a cast, so reading again is asked about first.
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    answers.elements = castAnswer(
      [{ name: "林", description: "灰呢大衣，说话很慢。", chapters: [1] }],
      [{ name: "末班车车厢", description: "空车厢。" }],
    );
    await comesBack();

    await waitFor(() => {
      expect(element("林")?.description).toBe("灰呢大衣，说话很慢。");
    });
    // The characters the reading did not name are gone, and so is the prop it
    // never saw; the drawings of the one it kept are the reader's still.
    expect(story().elements.map((each) => each.name)).toEqual([
      "林",
      "末班车车厢",
    ]);
    expect(slotOf("林", "main")?.takes[0]?.assetId).toBe(ids.heroMain);
    expect(element("林")?.descriptionConfirmed).toBe(true);
    expect(starts[0]?.kind).toBe("elements");
    expect(starts[0]?.items[0]?.capability).toBe("text");
  });

  it("says on the button that asked while the reading is under way", async () => {
    openAtElements(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });

    // A chapter's worth of words takes a while, and the reader is told so
    // where they pressed rather than only in the tally beneath the list.
    const button = screen.getByTestId("story-elements-recognise");
    expect(button.textContent).toContain("Reading the chapters…");
    expect(button.querySelector(".story-spin")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);

    answers.elements = castAnswer(
      [{ name: "林", description: "灰呢大衣，说话很慢。", chapters: [1] }],
      [],
    );
    await comesBack();
    await waitFor(() => {
      const done = screen.getByTestId("story-elements-recognise");
      expect(done.textContent).toContain("Read the chapters again");
      expect(done.querySelector(".story-spin")).toBeNull();
    });
  });

  it("says what reading again costs before it reads again", async () => {
    openAtElements(buildStoryMokaFile());

    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    const asked = screen.getByTestId("recognise-elements");
    expect(asked.textContent).toContain("4 elements");
    expect(asked.textContent).toContain("No picture is ever deleted");
    fireEvent.click(screen.getByTestId("recognise-elements-cancel"));
    expect(screen.queryByTestId("recognise-elements")).toBeNull();
    expect(starts).toHaveLength(0);

    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]?.kind).toBe("elements");
  });
});

describe("agreeing to a description", () => {
  it("locks the words once they are agreed to, and takes it back on undo", () => {
    openAtElements(buildStoryMokaFile());
    const box = screen.getByTestId(
      "story-element-description-旧车票",
    ) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(false);

    fireEvent.click(screen.getByTestId("story-element-confirm-旧车票"));

    expect(element("旧车票")?.descriptionConfirmed).toBe(true);
    expect(
      (
        screen.getByTestId(
          "story-element-description-旧车票",
        ) as HTMLTextAreaElement
      ).readOnly,
    ).toBe(true);
    expect(screen.getByTestId("story-element-state-旧车票").textContent).toBe(
      "Description agreed to",
    );

    act(() => {
      undo();
    });
    expect(element("旧车票")?.descriptionConfirmed).toBe(false);
  });

  it("unlocks for a change, and writes the new words when the reader looks away", async () => {
    openAtElements(buildStoryMokaFile());
    const before = useHistoryStore.getState().undoStack.length;
    expect(
      (
        screen.getByTestId(
          "story-element-description-林",
        ) as HTMLTextAreaElement
      ).readOnly,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("story-element-unlock-林"));
    const box = screen.getByTestId(
      "story-element-description-林",
    ) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(false);

    fireEvent.change(box, { target: { value: "灰呢大衣，说话很慢。" } });
    fireEvent.blur(box);

    await waitFor(() => {
      expect(element("林")?.description).toBe("灰呢大衣，说话很慢。");
    });
    // The unlock itself is not a step of the history; the words are.
    expect(useHistoryStore.getState().undoStack).toHaveLength(before + 1);
  });

  it("names the chapters an element stands in", () => {
    openAtElements(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-element-chapters-旧车票"));
    const menu = screen.getByTestId("story-element-chapters-menu");
    // The story's own chapters, counted in the menu the way the cards are.
    fireEvent.click(menu.querySelectorAll("button")[0]!);

    expect(element("旧车票")?.chapterIds).toEqual([ids.chapterFirst]);
  });
});

describe("the pictures of an element", () => {
  it("asks for a main picture from the description, at the story's own frame", async () => {
    openAtElements(buildStoryMokaFile());

    fireEvent.click(
      within(card("旧车票", "prop")).getByTestId("story-slot-main-generate"),
    );
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    const item = starts[0]?.items[0];
    expect(starts[0]?.kind).toBe("elementArt");
    expect(item?.capability).toBe("image");
    expect(item?.target).toEqual({
      kind: "elementArt",
      elementId: ids.prop,
      view: "main",
    });
    expect(item?.inputs).toEqual([]);
    expect(item?.params).toEqual({ size: "1536x1024" });

    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    pictures[`element:main:${ids.prop}`] = ["asset-ticket-main"];
    await comesBack();

    await waitFor(() => {
      expect(slotOf("旧车票", "main")?.takes).toHaveLength(1);
    });
    const shown = within(card("旧车票", "prop"))
      .getByTestId("story-slot-main")
      .querySelector("img");
    expect(shown?.getAttribute("src")).toBe(
      "/api/v1/projects/current/assets/asset-ticket-main",
    );
  });

  it("draws the four views from the main picture, and only once there is one", async () => {
    // Both characters are here to be asked: 周 has a picture and no views yet,
    // and the thing that was a prop has been made a character with four views
    // of its own and nothing drawn at all.
    const moka = buildStoryMokaFile();
    const last = moka.stories![0].elements[3]!;
    last.kind = "character";
    last.turnaround = { takes: [], confirmed: false };
    openAtElements(moka);

    const waiting = within(
      screen.getByTestId("story-element-character-旧车票"),
    ).getByTestId("story-slot-turnaround-generate") as HTMLButtonElement;
    // The element with no main picture is the one that waits for it.
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute("title")).toBe(
      "Draw the main picture first — the four views are made from it",
    );

    fireEvent.click(
      within(card("周", "character")).getByTestId(
        "story-slot-turnaround-generate",
      ),
    );
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    const item = starts[0]?.items[0];
    expect(item?.target).toEqual({
      kind: "elementArt",
      elementId: ids.partner,
      view: "turnaround",
    });
    expect(item?.inputs).toEqual([
      { role: "reference", assetId: ids.partnerMain },
    ]);
  });

  it("keeps the take a reader picks, and the rest in the order they were", async () => {
    const moka = buildStoryMokaFile();
    const hero = moka.stories![0].elements[0]!;
    hero.main.takes = [
      { assetId: ids.heroMain, createdAt: "2026-01-02T00:00:00Z" },
      { assetId: "asset-hero-b", createdAt: "2026-01-03T00:00:00Z" },
      { assetId: "asset-hero-c", createdAt: "2026-01-04T00:00:00Z" },
    ];
    openAtElements(moka);

    fireEvent.click(
      within(card("林", "character")).getByTestId("story-slot-main-pick"),
    );
    // The take being kept is the newest of the list, and it is marked as such.
    expect(screen.getByTestId("story-pick-asset-hero-c").className).toContain(
      "is-current",
    );
    fireEvent.click(screen.getByTestId("story-pick-asset-hero-b"));

    expect(slotOf("林", "main")?.takes.map((take) => take.assetId)).toEqual([
      ids.heroMain,
      "asset-hero-c",
      "asset-hero-b",
    ]);
    expect(screen.queryByTestId("story-picks")).toBeNull();
  });

  it("adds a redrawn picture to the place rather than replacing what is there", async () => {
    openAtElements(buildStoryMokaFile());
    const before = slotOf("林", "main")?.takes.length ?? 0;

    fireEvent.click(
      within(card("林", "character")).getByTestId("story-slot-main-again"),
    );
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    pictures[`element:main:${ids.hero}`] = ["asset-hero-again"];
    await comesBack();

    await waitFor(() => {
      expect(slotOf("林", "main")?.takes).toHaveLength(before + 1);
    });
    expect(slotOf("林", "main")?.takes.map((take) => take.assetId)).toContain(
      ids.heroMain,
    );
  });

  it("asks for every missing picture at once, and says how many that is", async () => {
    openAtElements(buildStoryMokaFile());
    const button = screen.getByTestId("story-elements-draw-all");
    expect(button.textContent).toBe("Draw every missing picture (1)");

    fireEvent.click(button);
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]?.items).toHaveLength(1);
  });

  it("agrees to everything only once every element has a picture", async () => {
    openAtElements(buildStoryMokaFile());
    const all = screen.getByTestId("story-elements-confirm-all");
    expect((all as HTMLButtonElement).disabled).toBe(true);
    expect(all.getAttribute("title")).toBe("1 elements have no picture yet");

    fireEvent.click(screen.getByTestId("story-elements-draw-all"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    pictures[`element:main:${ids.prop}`] = ["asset-ticket-main"];
    await comesBack();

    await waitFor(() => {
      expect(
        (screen.getByTestId("story-elements-confirm-all") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("story-elements-confirm-all"));

    await waitFor(() => {
      expect(story().elements.every((each) => each.descriptionConfirmed)).toBe(
        true,
      );
    });
    expect(slotOf("旧车票", "main")?.confirmed).toBe(true);
    expect(useHistoryStore.getState().undoStack.length).toBeGreaterThan(0);
  });
});

describe("taking an element out", () => {
  it("asks first, then leaves the boards that named it with a gap", () => {
    openAtElements(buildStoryMokaFile());
    const act = story().chapters[0].acts[0];

    fireEvent.click(screen.getByTestId("story-element-remove-周"));
    const asked = screen.getByTestId("remove-element");
    expect(asked.textContent).toContain("周");
    fireEvent.click(screen.getByTestId("remove-element-confirm"));

    expect(element("周")).toBeUndefined();
    expect(story().elements.map((each) => each.name)).toEqual([
      "林",
      "末班车车厢",
      "旧车票",
    ]);
    // The board still names the character; what is left is a gap and a word
    // about it rather than a prompt with a picture that is not there.
    expect(actCast(story(), act).missing).toEqual([ids.partner]);
  });
});

describe("an element the reader types in", () => {
  it("is added to the cast with no pictures of its own", () => {
    openAtElements(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-elements-add"));

    fireEvent.change(screen.getByTestId("add-element-kind"), {
      target: { value: "scene" },
    });
    fireEvent.change(screen.getByTestId("add-element-name"), {
      target: { value: "候车厅" },
    });
    fireEvent.change(screen.getByTestId("add-element-description"), {
      target: { value: "长椅上空无一人。" },
    });
    fireEvent.click(screen.getByTestId("add-element-confirm"));

    const added = element("候车厅");
    expect(added?.kind).toBe("scene");
    expect(added?.description).toBe("长椅上空无一人。");
    expect(added?.main.takes).toEqual([]);
    expect(screen.queryByTestId("add-element")).toBeNull();
  });
});

describe("a cast too long to show at once", () => {
  it("shows a shelf's worth of cards and offers the rest", () => {
    const moka = buildStoryMokaFile();
    const story = moka.stories![0];
    story.elements = Array.from({ length: SHELF_PAGE + 5 }, (_, at) => ({
      id: `extra-${at}`,
      kind: "prop" as const,
      name: `道具 ${at + 1}`,
      description: "一件东西。",
      descriptionConfirmed: true,
      chapterIds: [],
      main: { takes: [], confirmed: false },
    }));
    openAtElements(moka);

    expect(screen.getAllByTestId(/^story-element-prop-/)).toHaveLength(
      SHELF_PAGE,
    );
    const paging = screen.getByTestId("story-elements-shown");
    expect(paging.textContent).toBe(`${SHELF_PAGE} of ${SHELF_PAGE + 5} shown`);

    fireEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(screen.getAllByTestId(/^story-element-prop-/)).toHaveLength(
      SHELF_PAGE + 5,
    );
    expect(screen.queryByTestId("story-elements-shown")).toBeNull();
  });
});
