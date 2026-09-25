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
import { clampSeconds } from "../jobs/plan";
import { useProjectStore } from "../../editor/stores/projectStore";
import { StoryPage } from "../StoryPage";
import { useStoryJobStore } from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

/** What the room handed the server, in the order it handed it over. */
let starts: Array<{ kind: StoryJobKind; items: StoryJobItemDraft[] }> = [];
/** The batches the server is holding, newest first. */
let held: StoryJobRecord[] = [];
/** What each piece of the next batch is answered with, by the piece's id. */
let answers: Record<string, string> = {};

/** The server under the test, as the other steps' tests serve it. */
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
      if (url.includes("/assets/")) {
        return Promise.resolve(new Response(""));
      }
      if (url.includes("/api/v1/projects/current")) {
        return json({
          root: "/tmp/moka-board-test",
          moka: useProjectStore.getState().moka,
          selfCheck: { ok: true, issues: [] },
        });
      }
      return json({});
    }),
  );
}

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
    model: "a-storyteller",
    items: items.map((item) => ({
      ...item,
      inputs: item.inputs ?? [],
      params: item.params ?? {},
      status: "running",
    })),
    cancelRequested: false,
    createdAt: T0,
    updatedAt: T0,
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
      assetIds: [`asset-${item.id.replace(/[^\w-]/g, "-")}`],
      ...(answers[item.id] !== undefined ? { text: answers[item.id] } : {}),
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

/**
 * The fixture with a cast every one of which has been drawn and agreed to,
 * which is what the fourth step's door waits on.
 */
function boarded(): MokaFile {
  const moka = buildStoryMokaFile();
  const story = moka.stories![0];
  settle(story, "周", (element) => {
    element.turnaround = {
      takes: [{ assetId: "asset-partner-sheet", createdAt: T0 }],
      confirmed: true,
    };
  });
  settle(story, "旧车票", (element) => {
    element.descriptionConfirmed = true;
    element.main = {
      takes: [{ assetId: "asset-prop-main", createdAt: T0 }],
      confirmed: true,
    };
  });
  return moka;
}

/** One element of the cast, as the reader settled it. */
function settle(
  story: NonNullable<MokaFile["stories"]>[number],
  name: string,
  change: (element: (typeof story.elements)[number]) => void,
): void {
  const element = story.elements.find((held) => held.name === name);
  if (element === undefined) throw new Error(`the fixture holds ${name}`);
  change(element);
}

/** The same telling with the first act's table still open for editing. */
function withOpenTable(): MokaFile {
  const moka = boarded();
  moka.stories![0].chapters[0]!.acts[0]!.keysConfirmed = false;
  return moka;
}

/** The same telling with every frame of its first act drawn and agreed to. */
function withEveryFrame(): MokaFile {
  const moka = withOpenTable();
  const story = moka.stories![0];
  const act = story.chapters[0]!.acts[0]!;
  act.keysConfirmed = true;
  act.imagesConfirmed = false;
  for (const keyframe of act.keyframes) {
    keyframe.art = {
      takes:
        keyframe.art.takes.length === 0
          ? [{ assetId: `asset-${keyframe.id}`, createdAt: T0 }]
          : keyframe.art.takes,
      confirmed: true,
    };
  }
  return moka;
}

/** The same telling with the place it happens in not yet drawn. */
function withoutThePlace(): MokaFile {
  const moka = withOpenTable();
  settle(moka.stories![0], "末班车车厢", (element) => {
    element.main = { takes: [], confirmed: false };
  });
  return moka;
}

/** The same telling with its first act's clip not yet made. */
function withoutTheClip(): MokaFile {
  const moka = withEveryFrame();
  const act = moka.stories![0].chapters[0]!.acts[0]!;
  act.video = { takes: [], confirmed: false };
  act.videoConfirmed = false;
  return moka;
}

/**
 * The room as a reader reaches step four with this episode open.
 *
 * The step is stood on rather than clicked to: whether the door opens is the
 * shell's business, and a test about a board wants a board.
 */
function openAtBoard(moka: MokaFile, chapter = 0): void {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-board-test",
    selfCheck: { ok: true, issues: [] },
  });
  useStoryStore.getState().adopt(moka);
  const target = moka.stories![0].chapters[chapter];
  if (target !== undefined) useStoryStore.getState().openChapter(target.id);
  render(<StoryPage />);
  act(() => useStoryStore.getState().goStep("storyboard"));
}

function story() {
  const heldStory = useProjectStore.getState().moka?.stories?.[0];
  if (heldStory === undefined) throw new Error("a story is open");
  return heldStory;
}

/** The acts of the episode the room has open, which is the one under test. */
function acts() {
  const held = story();
  const open = useStoryStore.getState().openChapterId;
  const chapter = held.chapters.find((each) => each.id === open);
  return (chapter ?? held.chapters[0])?.acts ?? [];
}

function card(index: number): HTMLElement {
  return screen.getByTestId(`story-act-${index}`);
}

/** An answer as a model writes one: acts of shots in the shape asked for. */
function boardAnswer(...shotSizes: string[]): string {
  return JSON.stringify({
    acts: [
      {
        title: "上车",
        summary: "他在最后一秒钟挤上车门。",
        characters: ["林", "周"],
        scene: "末班车车厢",
        props: [],
        sound: { music: "低沉的弦乐", sfx: "车门蜂鸣", ambience: "车厢底噪" },
        keyframes: shotSizes.map((shotSize, index) => ({
          shotSize,
          cameraMove: "pushIn",
          angle: "eyeLevel",
          content: `第 ${index + 1} 格的画面。`,
          durationMs: 2_000,
          dialogue: [],
        })),
      },
    ],
  });
}

beforeEach(() => {
  starts = [];
  held = [];
  answers = {};
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useStoryStore.getState().forget();
  useStoryJobStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writing an episode's board", () => {
  it("asks for the board as a table of chapters, and writes it into the story", async () => {
    openAtBoard(boarded(), 1);
    answers[`storyboard:${story().chapters[1]!.id}`] = boardAnswer(
      "close",
      "medium",
    );

    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("storyboard");
    expect(item?.capability).toBe("text");
    expect(item?.prompt).toContain("林");
    expect(item?.prompt).toContain("末班车车厢");

    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-act-0")).toBeDefined(),
    );
    expect(within(card(0)).getByTestId("story-table")).toBeDefined();
    expect(acts()).toHaveLength(1);
    expect(acts()[0]?.keyframes).toHaveLength(2);
  });

  it("draws no frame until the table is agreed to, then draws its cast in order", async () => {
    openAtBoard(withOpenTable());
    expect(
      (screen.getByTestId("story-act-draw-0") as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByTestId("story-act-keys-0"));
    await waitFor(() => expect(acts()[0]?.keysConfirmed).toBe(true));

    // The gap between the table and its pictures is the reader's answer, so it
    // is the last shot that is waiting: reading the button again draws the rest.
    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("keyframeArt");
    // Characters first, then the place, then the things — the order the prompt
    // numbers its references in, and the order the pictures travel in.
    expect(item?.inputs?.map((input) => input.assetId)).toEqual([
      ids.heroMain,
      ids.partnerMain,
      ids.sceneMain,
      "asset-prop-main",
    ]);
    expect(item?.prompt).toContain("1. 林");
    expect(item?.prompt).toContain("2. 周");
    expect(item?.prompt).toContain("3. 末班车车厢");
    expect(item?.prompt).toContain("4. 旧车票");
  });

  it("says which references are missing rather than refusing to draw", async () => {
    openAtBoard(withoutThePlace());
    fireEvent.click(screen.getByTestId("story-act-keys-0"));
    await waitFor(() => expect(acts()[0]?.keysConfirmed).toBe(true));
    expect(screen.getByTestId("story-act-missing-ref-0").textContent).toContain(
      "末班车车厢",
    );

    fireEvent.click(screen.getByTestId("story-act-draw-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(
      starts[0]!.items[0]?.inputs?.map((input) => input.assetId),
    ).not.toContain(ids.sceneMain);
  });

  it("films an act only once its frames are agreed to, for as long as it plans", async () => {
    openAtBoard(withoutTheClip());
    expect(
      (screen.getByTestId("story-act-video-go-0") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("story-act-images-confirm-0"));
    await waitFor(() => expect(acts()[0]?.imagesConfirmed).toBe(true));

    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    const [item] = starts[0]!.items;
    expect(starts[0]!.kind).toBe("actVideo");
    expect(item?.capability).toBe("video");
    expect(item?.params?.seconds).toBe(clampSeconds(5_000));
    expect(item?.params?.ratio).toBe(story().brief.aspect);
    // First frame, last frame, and nothing in between: two shots, two pictures.
    expect(item?.inputs?.map((input) => input.role)).toEqual([
      "firstFrame",
      "lastFrame",
    ]);
  });

  it("says out loud when the clip will be cut to the ceiling", async () => {
    const moka = withoutTheClip();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    for (const keyframe of act.keyframes) keyframe.durationMs = 400_000;
    openAtBoard(moka);
    fireEvent.click(screen.getByTestId("story-act-images-confirm-0"));
    await waitFor(() => expect(acts()[0]?.imagesConfirmed).toBe(true));

    expect(screen.getByTestId("story-act-clamp-0").textContent).toContain(
      "600",
    );
    fireEvent.click(screen.getByTestId("story-act-video-go-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items[0]?.params?.seconds).toBe(600);
  });

  it("films shot by shot, each from its own frame to the next", async () => {
    const moka = withEveryFrame();
    const act = moka.stories![0].chapters[0]!.acts[0]!;
    act.imagesConfirmed = true;
    act.keyframes[1]!.art = {
      takes: [{ assetId: "asset-second-frame", createdAt: T0 }],
      confirmed: true,
    };
    openAtBoard(moka);

    // The act already holds a clip, so changing how clips are made is a
    // question rather than a switch — and the clips already made stay put.
    fireEvent.click(screen.getByTestId("story-granularity-keyframe"));
    expect(screen.getByTestId("change-granularity")).toBeDefined();
    fireEvent.click(screen.getByTestId("change-granularity-confirm"));
    await waitFor(() => expect(story().shotGranularity).toBe("keyframe"));
    expect(acts()[0]?.video.takes).toHaveLength(1);

    fireEvent.click(screen.getByTestId("story-kf-video-0"));
    await waitFor(() => expect(starts).toHaveLength(1));
    let item = starts[0]!.items[0];
    expect(starts[0]!.kind).toBe("keyframeVideo");
    expect(item?.inputs?.map((input) => [input.role, input.assetId])).toEqual([
      ["firstFrame", ids.frameArt],
      ["lastFrame", "asset-second-frame"],
    ]);
    expect(item?.params?.seconds).toBe(clampSeconds(2_000));

    // One shot is filmed at a time: the act's other shots wait for this one to
    // come home before they are asked for.
    await comesBack();

    // The last shot has nothing after it to end on, so it is filmed from its
    // own frame alone.
    fireEvent.click(screen.getByTestId("story-kf-video-1"));
    await waitFor(() => expect(starts).toHaveLength(2));
    item = starts[1]!.items[0];
    expect(item?.inputs?.map((input) => input.role)).toEqual(["firstFrame"]);
  });

  it("asks before writing an episode's board again, and lists what it costs", async () => {
    openAtBoard(boarded());
    fireEvent.click(screen.getByTestId("story-board-regenerate"));
    const dialog = screen.getByTestId("regenerate-board");
    expect(dialog.textContent).toContain("1 act");
    expect(dialog.textContent).toContain("episode 1");

    fireEvent.click(screen.getByTestId("regenerate-board-cancel"));
    expect(starts).toHaveLength(0);

    fireEvent.click(screen.getByTestId("story-board-regenerate"));
    fireEvent.click(screen.getByTestId("regenerate-board-confirm"));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]!.items[0]?.id).toBe(
      `storyboard:${story().chapters[0]!.id}`,
    );
  });

  it("marks the cells whose framing the answer never really gave", async () => {
    openAtBoard(boarded(), 1);
    answers[`storyboard:${story().chapters[1]!.id}`] = boardAnswer("遥遥远景");

    fireEvent.click(screen.getByTestId("story-board-generate"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await comesBack();
    await waitFor(() =>
      expect(screen.getByTestId("story-act-0")).toBeDefined(),
    );
    const mark = within(card(0)).getByTestId("story-guessed-size-0");
    expect(mark.getAttribute("title")).toContain("遥遥远景");
    expect(acts()[0]?.keyframes[0]?.shotSize).toBe("medium");
  });

  it("writes the lines of a shot as one step, off screen ones included", async () => {
    openAtBoard(withOpenTable());
    fireEvent.click(screen.getByTestId("story-kf-dialogue-0"));
    expect(screen.getByTestId("story-dialogue")).toBeDefined();

    fireEvent.click(screen.getByTestId("story-line-add"));
    fireEvent.change(screen.getByTestId("story-line-speaker-1"), {
      target: { value: "画外音" },
    });
    fireEvent.change(screen.getByTestId("story-line-text-1"), {
      target: { value: "末班车，不停了。" },
    });
    fireEvent.change(screen.getByTestId("story-line-text-0"), {
      target: { value: "车已经停运了。" },
    });
    fireEvent.click(screen.getByTestId("story-line-done"));

    await waitFor(() =>
      expect(acts()[0]?.keyframes[0]?.dialogue).toHaveLength(2),
    );
    const lines = acts()[0]?.keyframes[0]?.dialogue ?? [];
    expect(lines[0]?.speaker).toBe("林");
    expect(lines[0]?.text).toBe("车已经停运了。");
    expect(lines[1]).toEqual({ speaker: "画外音", text: "末班车，不停了。" });
  });

  it("names every control by the shot and the column it belongs to", () => {
    openAtBoard(withOpenTable());
    expect(screen.getByLabelText("shot 1 · Movement")).toBeDefined();
    expect(screen.getByLabelText("shot 2 · Framing")).toBeDefined();
    expect(screen.getByLabelText("shot 1 · Length")).toBeDefined();
    expect(screen.getByTestId("story-kf-add").tagName).toBe("BUTTON");
  });

  it("adds and takes away shots by writing the act's table whole", async () => {
    openAtBoard(withOpenTable());
    fireEvent.click(screen.getByTestId("story-kf-add"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(3));

    fireEvent.click(screen.getByTestId("story-kf-remove-1"));
    await waitFor(() => expect(acts()[0]?.keyframes).toHaveLength(2));
    expect(acts()[0]?.keyframes[0]?.id).toBe(ids.frameFirst);
  });
});
