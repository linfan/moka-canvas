// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createStory, STORY_STEPS, type MokaFile } from "../../shared/domain";
import {
  buildEmptyStory,
  buildGoldenMokaFile,
  buildStoryMokaFile,
  storyIds,
} from "../../shared/domain/fixtures";
import { undo } from "../editor/commands/execute";
import { useAppStore } from "../editor/stores/appStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { StoryPage } from "./StoryPage";
import { useStoryJobStore } from "./stores/storyJobStore";
import { useStoryStore } from "./stores/storyStore";

const fetchMock = vi.fn<typeof fetch>();

/** The room as a reader reaches it: the project open and the page standing. */
function openRoom(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-story-test",
    selfCheck: { ok: true, issues: [] },
  });
  render(<StoryPage />);
}

/** Whatever the room is asked to do outside a press, which React has to see. */
function quietly<T>(work: () => T): T {
  let done: T;
  act(() => {
    done = work();
  });
  return done!;
}

/** The same project with one more telling at the end of its list. */
function withStory(
  moka: MokaFile,
  name: string,
): { moka: MokaFile; id: string } {
  const added = createStory(name);
  return {
    moka: { ...moka, stories: [...(moka.stories ?? []), added] },
    id: added.id,
  };
}

/** The name a row stands under, by the row that is standing. */
function rowNames(): string[] {
  return [...document.querySelectorAll(".story-row-name")].map(
    (row) => row.textContent ?? "",
  );
}

function activeRow(): string | null {
  const row = document.querySelector(".story-row.is-active .story-row-name");
  return row?.textContent ?? null;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    // Entering the room asks what batches are out for its story; the tests
    // that care about one answer it themselves.
    const payload = String(input).includes("/story/jobs")
      ? []
      : { revision: 2, updatedAt: "2026-01-02T00:00:00.000Z" };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
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
});

describe("a project that tells no story yet", () => {
  it("says so, and offers the one thing there is to do", () => {
    openRoom(buildGoldenMokaFile());
    expect(screen.getByTestId("story-empty")).toBeTruthy();
    expect(screen.getByTestId("story-side-empty")).toBeTruthy();
    expect(screen.getByTestId("story-empty-new")).toBeTruthy();
  });

  it("opens a story under the name it is given, and stands on its first step", () => {
    openRoom(buildGoldenMokaFile());
    fireEvent.click(screen.getByTestId("story-empty-new"));

    const dialog = screen.getByRole("dialog", { name: "New story" });
    expect(dialog).toBeTruthy();
    const name = screen.getByTestId("story-name") as HTMLInputElement;
    expect(name.value.length).toBeGreaterThan(0);
    fireEvent.change(name, { target: { value: "雨夜列车" } });
    fireEvent.click(screen.getByTestId("story-create"));

    expect(screen.queryByRole("dialog", { name: "New story" })).toBeNull();
    expect(screen.queryByTestId("story-empty")).toBeNull();
    expect(
      screen.getByTestId("story-step-idea").getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("story-step-body-idea")).toBeTruthy();
    expect(rowNames()).toEqual(["雨夜列车"]);
    expect(useProjectStore.getState().moka?.stories?.length).toBe(1);
    // The question is asked once: the name is the only thing a new story is
    // asked for, and the premise is set in the step that is standing.
    expect(useStoryStore.getState().storyId).not.toBeNull();
  });
});

describe("the five steps", () => {
  it("shows all five, with the ones not yet earned saying what comes first", () => {
    openRoom(buildEmptyStory("空故事"));
    for (const step of STORY_STEPS) {
      expect(screen.getByTestId(`story-step-${step}`)).toBeTruthy();
    }
    // A story with only a name has earned nothing past the premise, so every
    // later step waits on the one before it.
    const outline = screen.getByTestId(
      "story-step-outline",
    ) as HTMLButtonElement;
    expect(outline.disabled).toBe(true);
    expect(outline.title).toBe("Premise comes first.");
    for (const step of ["elements", "storyboard", "edit"]) {
      expect(
        (screen.getByTestId(`story-step-${step}`) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
    expect(screen.getByTestId("story-step-body-idea")).toBeTruthy();
    expect(screen.queryByTestId("story-step-body-outline")).toBeNull();
  });

  it("marks the step whose pieces did not come back", async () => {
    // A batch that ran, answered nothing, and ended: what the step shows is a
    // count of the pieces that failed, which the document cannot know.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("/story/jobs")
        ? [
            {
              id: "job-1",
              projectId: "project-1",
              storyId: storyIds().story,
              kind: "storyboard",
              status: "failed",
              model: "a-writer",
              items: [
                {
                  id: `storyboard:${storyIds().chapterFirst}`,
                  target: {
                    kind: "storyboard",
                    chapterId: storyIds().chapterFirst,
                  },
                  capability: "text",
                  prompt: "board this",
                  inputs: [],
                  params: {},
                  status: "failed",
                  error: "the provider refused",
                },
              ],
              cancelRequested: false,
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
            },
          ]
        : {
            root: "/tmp/moka-story-test",
            moka: buildStoryMokaFile(),
            selfCheck: { ok: true, issues: [] },
          };
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    openRoom(buildStoryMokaFile());

    const badge = await screen.findByTestId("story-step-failed-storyboard");
    expect(badge.textContent).toBe("1");
    const button = screen.getByTestId("story-step-storyboard");
    expect(button.className).toContain("is-failed");
    // The step is still behind the elements, and a step that cannot be walked
    // to says that first: the failure is on the badge beside it.
    expect(button.getAttribute("title")).toBe("Elements comes first.");
    // The step with nothing wrong with it carries no mark.
    expect(screen.queryByTestId("story-step-failed-outline")).toBeNull();
  });

  it("walks to a step that has been earned, and stops at the ones that have not", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-step-idea"));
    const outline = screen.getByTestId(
      "story-step-outline",
    ) as HTMLButtonElement;
    expect(outline.disabled).toBe(false);
    fireEvent.click(outline);
    expect(useStoryStore.getState().step).toBe("outline");
    expect(screen.getByTestId("story-step-body-outline")).toBeTruthy();

    // The remaining steps are behind the elements, which the fixture has
    // described but not finished drawing.
    const storyboard = screen.getByTestId(
      "story-step-storyboard",
    ) as HTMLButtonElement;
    expect(storyboard.disabled).toBe(true);
    expect(storyboard.title).toBe("Elements comes first.");
  });
});

describe("naming a story", () => {
  it("renames it in the column, and gives the old name back on undo", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Rename 雨夜列车" }));

    const input = screen.getByRole("textbox", { name: "Rename 雨夜列车" });
    fireEvent.change(input, { target: { value: "白昼列车" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rowNames()).toEqual(["白昼列车"]);

    expect(quietly(() => undo())).toBe(true);
    expect(rowNames()).toEqual(["雨夜列车"]);
  });

  it("keeps the input standing when the name cannot be taken", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByRole("button", { name: "Rename 雨夜列车" }));

    const input = screen.getByRole("textbox", { name: "Rename 雨夜列车" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("A story needs a name.");
    expect(
      screen.getByRole("textbox", { name: "Rename 雨夜列车" }),
    ).toBeTruthy();
    expect(useProjectStore.getState().moka?.stories?.[0].name).toBe("雨夜列车");
  });
});

describe("taking a story away", () => {
  it("asks first, says what it costs, and stands beside the one that is left", () => {
    const { moka, id } = withStory(buildStoryMokaFile(), "第二个故事");
    openRoom(moka);
    quietly(() => useStoryStore.getState().select(id));
    expect(activeRow()).toBe("第二个故事");

    fireEvent.click(screen.getByTestId("story-delete-第二个故事"));
    const dialog = screen.getByTestId("remove-story");
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    // Nothing is deleted: the drawings and the timeline stay where they are,
    // and the dialog says so before the reader answers.
    expect(dialog.textContent).toContain("will no longer be referred to");

    fireEvent.click(screen.getByTestId("remove-story-confirm"));
    expect(screen.queryByTestId("remove-story")).toBeNull();
    expect(rowNames()).toEqual(["雨夜列车"]);
    expect(activeRow()).toBe("雨夜列车");
    expect(useProjectStore.getState().moka?.stories?.length).toBe(1);
  });

  it("leaves the story, and everything it holds, where it was when undone", () => {
    const { moka, id } = withStory(buildStoryMokaFile(), "第二个故事");
    openRoom(moka);
    quietly(() => useStoryStore.getState().select(id));
    fireEvent.click(screen.getByTestId("story-delete-第二个故事"));
    fireEvent.click(screen.getByTestId("remove-story-confirm"));

    expect(quietly(() => undo())).toBe(true);
    expect(rowNames()).toEqual(["雨夜列车", "第二个故事"]);
    const back = useProjectStore
      .getState()
      .moka?.stories?.find((story) => story.id === id);
    expect(back?.chapters.length).toBe(0);
    // The telling that stayed is untouched, bindings and all.
    const kept = useProjectStore
      .getState()
      .moka?.stories?.find((story) => story.id === storyIds().story);
    expect(kept?.chapters[0].acts.length).toBe(1);
    expect(kept?.edit.timelineId).toBeTruthy();
  });

  it("puts the question down without deleting when it is cancelled", () => {
    openRoom(buildStoryMokaFile());
    fireEvent.click(screen.getByTestId("story-delete-雨夜列车"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("remove-story")).toBeNull();
    expect(useProjectStore.getState().moka?.stories?.length).toBe(1);
  });
});
