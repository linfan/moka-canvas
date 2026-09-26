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
import { useModelStore } from "../../settings/modelStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { StoryPage } from "../StoryPage";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryModels } from "../stores/storyModels";
import { useStoryStore } from "../stores/storyStore";

const ids = storyIds();

/** What the room handed the server, in the order it handed it over. */
let starts: Array<{
  kind: StoryJobKind;
  items: StoryJobItemDraft[];
  /** The model the batch named, which is none until the room is set to one. */
  model: string | null;
}> = [];
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
        // A batch's answer being written down as read: the record as it stands
        // with the room's note on it, which is what the server answers with.
        const readIn = /\/story\/jobs\/([^/?]+)\/read$/.exec(url);
        if (readIn !== null) {
          const found = held.find((job) => job.id === readIn[1]);
          const marked =
            found === undefined
              ? undefined
              : { ...found, readAt: "2026-01-02T00:00:00Z" };
          if (marked !== undefined) {
            held = held.map((job) => (job.id === marked.id ? marked : job));
          }
          return marked === undefined
            ? json({ code: "NOT_FOUND", message: "no" }, 404)
            : json(marked);
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            kind: StoryJobKind;
            items: StoryJobItemDraft[];
            model?: string | null;
          };
          starts.push({
            kind: body.kind,
            items: body.items,
            model: body.model ?? null,
          });
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

/**
 * The room opened again over the document as it stands, which is a refresh in
 * so many words: the window forgets the batches it has watched, and what they
 * answered is the document's — the one the reader has been working in.
 *
 * Answered once the room has listed its batches and read in whatever it had
 * to, so that what the assertions see is a room that has stood up rather than
 * one still standing up.
 */
async function openedAgain(): Promise<void> {
  cleanup();
  useStoryJobStore.getState().reset();
  const moka = useProjectStore.getState().moka;
  if (moka === null) throw new Error("a project is open");
  openAtElements(moka);
  // Listing the room's batches and reading in whatever has to be read in is a
  // queue of answered promises: one turn of the loop is the room stood up.
  await act(async () => {
    await new Promise((settle) => setTimeout(settle, 0));
  });
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
  characters: Array<{
    name: string;
    description: string;
    chapters?: number[];
  }>,
  scenes: Array<{
    name: string;
    description: string;
    chapters?: number[];
  }> = [],
  props: Array<{
    name: string;
    description: string;
    chapters?: number[];
  }> = [],
): string {
  return JSON.stringify({ characters, scenes, props });
}

beforeEach(() => {
  starts = [];
  held = [];
  answers = {};
  pictures = {};
  useModelStore.setState({ view: null });
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
  useStoryModels.setState({ choices: {} });
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

  it("says what of an answer it could not read, beside the list", async () => {
    openAtElements(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    // A model answering in the words the ask describes the groups with rather
    // than the ones its shape names: the near-miss groups are read all the
    // same, and the group nothing was read from is said out loud.
    answers.elements = JSON.stringify({
      characters: [{ name: "林", description: "灰呢大衣。", chapters: [1] }],
      places: [{ name: "站外雨棚", description: "雨水顺着铁架走。" }],
      moods: [{ name: "湿冷", description: "雨水的气味。" }],
    });
    await comesBack();

    await waitFor(() => {
      expect(story().elements.map((each) => each.name)).toEqual([
        "林",
        "站外雨棚",
      ]);
    });
    expect(card("站外雨棚", "scene")).toBeTruthy();
    expect(screen.getByTestId("story-elements-warnings").textContent).toContain(
      "moods",
    );
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

describe("a room opened again over what it has already read", () => {
  it("keeps the newest reading, the reader's own changes, and the pictures", async () => {
    openAtElements(buildStoryMokaFile());

    // A first reading of the chapters, which finds the cast it finds.
    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    answers.elements = castAnswer([
      { name: "林", description: "灰呢大衣，说话很慢。", chapters: [1] },
    ]);
    await comesBack();
    await waitFor(() => {
      expect(element("林")).toBeTruthy();
    });

    // Reading again, because the room is not happy with what came back: the
    // second reading is the newer word on the same cast.
    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(2);
    });
    answers.elements = castAnswer([
      { name: "恋人甲", description: "短碎黑发。", chapters: [1] },
      { name: "恋人乙", description: "齐肩黑发。", chapters: [1] },
    ]);
    await comesBack();
    await waitFor(() => {
      expect(story().elements.map((each) => each.name)).toEqual([
        "恋人甲",
        "恋人乙",
      ]);
    });

    // One of them is drawn, and the picture is the reader's from then on.
    const drawnId = element("恋人甲")?.id ?? "";
    fireEvent.click(
      within(card("恋人甲", "character")).getByTestId(
        "story-slot-main-generate",
      ),
    );
    await waitFor(() => {
      expect(starts).toHaveLength(3);
    });
    pictures[`element:main:${drawnId}`] = ["asset-lover-main"];
    await comesBack();
    await waitFor(() => {
      expect(slotOf("恋人甲", "main")?.takes).toHaveLength(1);
    });

    // What the reader says to the cast by hand: one added, one taken out, and
    // a description of their own over the words the reading brought.
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
    fireEvent.click(screen.getByTestId("story-element-remove-恋人乙"));
    fireEvent.click(screen.getByTestId("remove-element-confirm"));
    fireEvent.change(screen.getByTestId("story-element-description-恋人甲"), {
      target: { value: "短碎黑发，秋夜外套。" },
    });
    fireEvent.blur(screen.getByTestId("story-element-description-恋人甲"));
    await waitFor(() => {
      expect(element("恋人甲")?.description).toBe("短碎黑发，秋夜外套。");
    });

    // The room opened again reads the batches it already read a second time
    // over — and every one of them says its answer is in, so none of it is
    // written into the story again over what the reader has said since.
    const toasts = useAppStore.getState().toasts.length;
    await openedAgain();

    expect(
      story()
        .elements.map((each) => each.name)
        .sort(),
    ).toEqual(["候车厅", "恋人甲"]);
    expect(element("恋人甲")?.description).toBe("短碎黑发，秋夜外套。");
    expect(slotOf("恋人甲", "main")?.takes.map((take) => take.assetId)).toEqual(
      ["asset-lover-main"],
    );
    expect(
      within(card("恋人甲", "character"))
        .getByTestId("story-slot-main")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("/api/v1/projects/current/assets/asset-lover-main");
    // Nothing was asked for a second time, and nothing was said again.
    expect(starts).toHaveLength(3);
    expect(useAppStore.getState().toasts).toHaveLength(toasts);
  });
});

describe("a telling read in parts", () => {
  /**
   * A deployment whose story room is set to carry little at a time.
   *
   * How much of a telling one reading may hold is the reader's, since it is the
   * model answering that decides it: what a test sets here is what the room
   * reads when it plans the parts.
   */
  function readingInParts(readChars: number): void {
    useModelStore.setState({
      view: {
        version: 1,
        revision: 1,
        models: [],
        defaults: {
          text: null,
          image: null,
          audio: null,
          music: null,
          video: null,
          asr: null,
        },
        preferences: {
          systemPrompt: "",
          reasoningEffort: "auto",
          image: { size: "1:1", quality: "auto", background: "", count: 1 },
          video: {
            seconds: 6,
            resolution: "720",
            generateAudio: true,
            watermark: false,
            mode: "auto",
            ratio: "",
          },
          audio: {
            voice: "",
            format: "mp3",
            speed: 1,
            instructions: "",
            sampleRate: 22050,
            volume: 50,
            rate: 1,
            pitch: 1,
          },
          story: { splitChars: 12_000, readChars },
        },
        secretStorage: "unset",
      },
    });
  }

  it("reads the telling a part at a time, and adds what each part found", async () => {
    // Both chapters together weigh more than one ask may carry, so each is
    // read on its own.
    readingInParts(30);
    openAtElements(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]?.items[0]?.id).toBe("elements:1");
    expect(starts[0]?.items[0]?.prompt).toContain("1. 第一章 站台");
    expect(starts[0]?.items[0]?.prompt).not.toContain("第二章 车厢");
    expect(screen.getByTestId("story-elements-wave").textContent).toBe(
      "Batch 1 of 2",
    );
    // The second part waits for the first to come home rather than being
    // started over the top of it: two batches out at once are both written into
    // the same cast, and the last one home is the only one left standing.
    answers["elements:1"] = castAnswer([
      { name: "林", description: "灰呢大衣，说话很慢。", chapters: [1] },
    ]);
    await comesBack();

    await waitFor(() => {
      expect(starts).toHaveLength(2);
    });
    // The second part is the telling's own second chapter, under the number
    // the telling gives it, so what it finds is filed against the right one.
    expect(starts[1]?.items[0]?.id).toBe("elements:2");
    expect(starts[1]?.items[0]?.prompt).toContain("2. 第二章 车厢");
    expect(screen.getByTestId("story-elements-wave").textContent).toBe(
      "Batch 2 of 2",
    );
    answers["elements:2"] = castAnswer(
      [{ name: "林", description: "四十岁上下，穿深色大衣。", chapters: [2] }],
      [{ name: "末班车车厢", description: "空车厢。", chapters: [2] }],
    );
    await comesBack();

    // What the second part found was added to the cast rather than standing in
    // its place: the character both parts saw is one element, holding the
    // chapters both of them read it in.
    await waitFor(() => {
      expect(element("林")?.description).toBe("四十岁上下，穿深色大衣。");
    });
    expect(story().elements.filter((each) => each.name === "林")).toHaveLength(
      1,
    );
    expect(element("林")?.chapterIds).toEqual([
      ids.chapterFirst,
      ids.chapterSecond,
    ]);
    expect(element("末班车车厢")?.chapterIds).toEqual([
      ids.chapterFirst,
      ids.chapterSecond,
    ]);
    // What neither part named stays: a part read its own chapters and nothing
    // else, and a part never seeing the keeper of the tale is not the telling
    // saying they are gone.
    expect(
      story()
        .elements.map((each) => each.name)
        .sort(),
    ).toEqual(["林", "末班车车厢", "周", "旧车票"].sort());
  });
});

describe("the model a reading is asked of", () => {
  /** The two storytellers a deployment that keeps a spare looks like. */
  const storyteller = (id: string, displayName: string) => ({
    id,
    category: "text" as const,
    protocol: "openaiChat",
    url: "https://api.example.com/v1/chat/completions",
    model: `${id}-1`,
    displayName,
    enabled: true,
    apiKey: { set: true, masked: "sk-…abcd" },
  });

  beforeEach(() => {
    useModelStore.setState({
      view: {
        version: 1,
        revision: 3,
        models: [
          storyteller("scribe-1", "Scribe One"),
          storyteller("scribe-2", "Scribe Two"),
        ],
        defaults: {
          text: "scribe-1",
          image: null,
          audio: null,
          music: null,
          video: null,
          asr: null,
        },
        preferences: {
          systemPrompt: "",
          reasoningEffort: "auto",
          image: { size: "1:1", quality: "auto", background: "auto", count: 1 },
          video: {
            seconds: 6,
            resolution: "720",
            generateAudio: true,
            watermark: false,
            mode: "auto",
            ratio: "",
          },
          audio: {
            voice: "",
            format: "mp3",
            speed: 1,
            instructions: "",
            sampleRate: 22050,
            volume: 50,
            rate: 1,
            pitch: 1,
          },
          story: { splitChars: 12_000, readChars: 8_000 },
        },
        secretStorage: "unset",
      },
    });
  });

  it("asks the model the room is set to rather than the deployment's default", async () => {
    openAtElements(buildStoryMokaFile());

    const picker = within(screen.getByTestId("story-model-text")).getByRole(
      "combobox",
    );
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Settings default", "Scribe One", "Scribe Two"]);
    fireEvent.change(picker, { target: { value: "scribe-2" } });

    fireEvent.click(screen.getByTestId("story-elements-recognise"));
    fireEvent.click(screen.getByTestId("recognise-elements-confirm"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]?.model).toBe("scribe-2");
    // The choice is the machine's, so the next reading is asked of it too.
    expect(localStorage.getItem("moka-canvas:story-models")).toBe(
      JSON.stringify({ text: "scribe-2" }),
    );
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

  it("unsays the words for a change, and agrees to them again when it is made", async () => {
    openAtElements(buildStoryMokaFile());
    const before = useHistoryStore.getState().undoStack.length;
    const box = () =>
      screen.getByTestId("story-element-description-林") as HTMLTextAreaElement;
    // Agreed to already, so the words are the document's and the box is shut:
    // there is no rewriting them in passing.
    expect(box().readOnly).toBe(true);

    fireEvent.click(screen.getByTestId("story-element-unconfirm-林"));
    expect(element("林")?.descriptionConfirmed).toBe(false);
    expect(box().readOnly).toBe(false);

    fireEvent.change(box(), { target: { value: "灰呢大衣，说话很慢。" } });
    fireEvent.blur(box());
    await waitFor(() => {
      expect(element("林")?.description).toBe("灰呢大衣，说话很慢。");
    });

    // Made, so it is agreed to again — and shut until it is unsaid once more.
    fireEvent.click(screen.getByTestId("story-element-confirm-林"));
    expect(element("林")?.descriptionConfirmed).toBe(true);
    expect(box().readOnly).toBe(true);

    // Unsaid, rewritten, agreed to: three steps of the history, each one the
    // reader's to take back on its own.
    expect(useHistoryStore.getState().undoStack).toHaveLength(before + 3);
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

  it("waits on the card being drawn while the rest of the cast stays askable", async () => {
    openAtElements(buildStoryMokaFile());

    // The one element with no picture is asked for, which leaves a batch out.
    fireEvent.click(screen.getByTestId("story-elements-draw-all"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });

    // Its own card says a picture is being made and offers no second ask of the
    // same place; the bulk button, which would ask for that place again, is
    // gone rather than counting work already handed over.
    const prop = card("旧车票", "prop");
    expect(within(prop).getByTestId("story-slot-main").textContent).toContain(
      "Drawing…",
    );
    expect(within(prop).queryByTestId("story-slot-main-generate")).toBeNull();
    expect(screen.queryByTestId("story-elements-draw-all")).toBeNull();

    // Another card's own ask is still one a reader can make: one place waiting
    // on its painter is not the whole cast waiting.
    const views = within(card("周", "character")).getByTestId(
      "story-slot-turnaround-generate",
    ) as HTMLButtonElement;
    expect(views.disabled).toBe(false);
    fireEvent.click(views);
    await waitFor(() => {
      expect(starts).toHaveLength(2);
    });
    expect(starts[1]?.items[0]?.target).toEqual({
      kind: "elementArt",
      elementId: ids.partner,
      view: "turnaround",
    });
  });

  it("shows a picture being drawn again over the one it replaces, and only there", async () => {
    openAtElements(buildStoryMokaFile());
    const hero = card("林", "character");

    fireEvent.click(within(hero).getByTestId("story-slot-main-again"));
    await waitFor(() => {
      expect(starts).toHaveLength(1);
    });

    // The place being drawn again says so over its own picture...
    const main = within(hero).getByTestId("story-slot-main");
    expect(main.querySelector(".story-slot-veil")?.textContent).toContain(
      "Drawing…",
    );
    expect(
      (within(hero).getByTestId("story-slot-main-again") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    // ...and the same character's four views, which nobody is making, do not.
    const turnaround = within(hero).getByTestId("story-slot-turnaround");
    expect(turnaround.querySelector(".story-slot-veil")).toBeNull();
    expect(
      (
        within(hero).getByTestId(
          "story-slot-turnaround-again",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
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
