// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { MokaFile } from "../../../shared/domain";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useAppStore } from "../../editor/stores/appStore";
import { useClipStore } from "../../clip/stores/clipStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { undo } from "../../editor/commands/execute";
import { StoryPage } from "../StoryPage";
import { useStoryExportStore } from "../stores/storyExportStore";
import { useStoryStore } from "../stores/storyStore";

const ids = storyIds();
/** What the render the test started answers with, as it is polled. */
let renders: Array<{
  id: string;
  timelineId: string;
  status: string;
  progress01: number;
  assetId?: string;
  message?: string;
}> = [];
/** Whether this machine can render at all. */
let canRender = true;
/** Every render the room asked for, by the timeline it was for. */
let asked: string[] = [];
/** What the next ask answers with, when it is refused. */
let refusal: { status: number; code: string; message: string } | null = null;
/** What the project route hands back, for the reload after a render lands. */
let reloaded: MokaFile | null = null;

/** The server under the test: capabilities, one render, and its poll. */
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
        return json([]);
      }
      if (url.includes("/clip/capabilities")) {
        return json(
          canRender
            ? { available: true, version: "9.0", transitions: [], ass: true }
            : {
                available: false,
                transitions: [],
                ass: false,
                reason: "no ffmpeg",
              },
        );
      }
      if (url.includes("/clip/export")) {
        const one = /\/clip\/export\/([^/?]+)/.exec(url);
        if (one !== null) {
          const found = renders.find((task) => task.id === one[1]);
          if (found === undefined) return json({ code: "NOT_FOUND" }, 404);
          if (method === "DELETE") {
            found.status = "cancelled";
          }
          return json(found);
        }
        if (method === "POST") {
          if (refusal !== null) {
            return json(
              { code: refusal.code, message: refusal.message },
              refusal.status,
            );
          }
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            timelineId: string;
          };
          asked.push(body.timelineId);
          const task = {
            id: `render-${asked.length}`,
            timelineId: body.timelineId,
            status: "queued",
            progress01: 0,
          };
          renders = [task, ...renders];
          return json(task);
        }
      }
      if (url.includes("/api/v1/projects/current")) {
        return json({
          root: "/tmp/moka-edit-test",
          moka: reloaded ?? useProjectStore.getState().moka,
          selfCheck: { ok: true, issues: [] },
        });
      }
      return json({});
    }),
  );
}

/** The fixture's telling, which has one filmed act and one empty episode. */
function filmed(): MokaFile {
  return buildStoryMokaFile();
}

/**
 * The room as a reader reaches step five: the telling is open, the step is
 * stood on, and the project's own route answers with what it holds.
 */
function openAtEdit(moka: MokaFile): void {
  reloaded = moka;
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-edit-test",
    selfCheck: { ok: true, issues: [] },
  });
  useStoryStore.getState().adopt(moka);
  render(<StoryPage />);
  act(() => useStoryStore.getState().goStep("edit"));
}

function story() {
  const held = useProjectStore.getState().moka?.stories?.[0];
  if (held === undefined) throw new Error("a story is open");
  return held;
}

function timelines() {
  return useProjectStore.getState().moka?.timelines ?? [];
}

beforeEach(() => {
  renders = [];
  asked = [];
  refusal = null;
  reloaded = null;
  canRender = true;
  serving();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useStoryStore.getState().forget();
  useStoryExportStore.getState().reset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("assembling a telling", () => {
  it("lays its clips on the timeline it was given, and steps back in one undo", async () => {
    openAtEdit(filmed());
    const before = timelines()[timelines().length - 1]!;
    const clipsBefore = before.clips.length;
    expect(screen.getByTestId("story-assembly-summary").textContent).toContain(
      "1",
    );

    fireEvent.click(screen.getByTestId("story-assemble"));
    await waitFor(() =>
      expect(timelines()[timelines().length - 1]!.clips.length).toBeGreaterThan(
        clipsBefore,
      ),
    );
    const after = timelines()[timelines().length - 1]!;
    // The telling's own clip was taken back; the reader's other clips stay.
    expect(after.clips.map((clip) => clip.id)).not.toContain(
      before.clips[0]!.id,
    );
    expect(after.clips.some((clip) => clip.kind === "video")).toBe(true);
    expect(after.clips.some((clip) => clip.kind === "text")).toBe(true);
    expect(story().edit.timelineId).toBe(after.id);
    expect(after.settings).toMatchObject({ width: 1920, height: 1080 });
    expect(after.clips.filter((clip) => clip.kind === "video")).toHaveLength(1);

    // One undo takes back the clips and the story's memory of them at once.
    act(() => {
      undo();
    });
    await waitFor(() =>
      expect(timelines()[timelines().length - 1]!.clips).toHaveLength(
        clipsBefore,
      ),
    );
    expect(story().edit.clipByAct?.[0]?.clipId).toBe(before.clips[0]!.id);
  });

  it("says which act is missing a clip, and walks to it", async () => {
    const moka = filmed();
    const second = moka.stories![0].chapters[1]!;
    moka.stories![0].chapters[1] = {
      ...second,
      acts: [{ ...moka.stories![0].chapters[0]!.acts[0]!, id: "act-2" }],
    };
    const held = moka.stories![0].chapters[1]!.acts[0]!;
    held.video = { takes: [], confirmed: false };
    held.videoConfirmed = false;
    openAtEdit(moka);

    const warnings = screen.getByTestId("story-assembly-warnings");
    expect(warnings.textContent).toContain("Episode 2");
    fireEvent.click(screen.getByTestId("story-warning-go-0"));
    expect(useStoryStore.getState().step).toBe("storyboard");
    expect(useStoryStore.getState().openChapterId).toBe(second.id);
  });

  it("keeps its clips off a timeline of the reader's, and says so first", async () => {
    openAtEdit(filmed());
    fireEvent.click(screen.getByTestId("story-assemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());
    const timeline = timelines()[timelines().length - 1]!;
    // The reader adds a clip of their own to the same timeline.
    act(() => {
      useProjectStore.getState().applyLocal([
        {
          type: "addClips",
          timelineId: timeline.id,
          clips: [
            { ...timeline.clips[0]!, id: "clip-by-hand", startMs: 60_000 },
          ],
        },
      ]);
    });

    fireEvent.click(screen.getByTestId("story-assemble"));
    const question = screen.getByTestId("rebuild-timeline");
    expect(question.textContent).toContain("1");
    fireEvent.click(screen.getByTestId("rebuild-timeline-cancel"));
    await waitFor(() =>
      expect(
        timelines()[timelines().length - 1]!.clips.some(
          (clip) => clip.id === "clip-by-hand",
        ),
      ).toBe(true),
    );
  });

  it("writes the lines of the telling as captions when asked to", async () => {
    openAtEdit(filmed());
    expect(
      (screen.getByTestId("story-assembly-subtitles") as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("story-assemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());
    const timeline = timelines()[timelines().length - 1]!;
    const captions = timeline.clips.filter((clip) => clip.kind === "text");
    expect(captions).toHaveLength(1);
    expect(captions[0]?.text?.content).toContain("车已经停运了。");
  });
});

describe("the film of a telling", () => {
  it("renders the timeline, files the answer, and plays it back", async () => {
    openAtEdit(filmed());
    fireEvent.click(screen.getByTestId("story-assemble"));
    await waitFor(() => expect(story().edit.timelineId).toBeDefined());

    fireEvent.click(screen.getByTestId("story-film-export"));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toBe(story().edit.timelineId);

    // The render comes home: the room reads the project again and writes the
    // film down as the story's own.
    renders = [
      {
        ...renders[0]!,
        status: "done",
        progress01: 1,
        assetId: "asset-film",
      },
    ];
    reloaded = withTheFilm(filmed());
    await act(async () => {
      await useStoryExportStore.getState().setTask(renders[0]! as never);
    });
    await waitFor(() => expect(story().edit.film?.assetId).toBe("asset-film"));
    await waitFor(() =>
      expect(screen.getByTestId("story-film-video")).toBeDefined(),
    );
  });

  it("says a machine without a renderer cannot render, rather than failing", async () => {
    canRender = false;
    openAtEdit(filmed());
    const button = screen.getByTestId("story-film-export") as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(true));
    expect(button.getAttribute("title")).toContain("ffmpeg");
  });

  it("plays the film on the step and opens its timeline in the cutting room", async () => {
    const moka = withTheFilm(filmed());
    openAtEdit(moka);
    expect(screen.getByTestId("story-film-video")).toBeDefined();

    fireEvent.click(screen.getByTestId("story-film-open"));
    await waitFor(() => expect(useAppStore.getState().phase).toBe("clip"));
    expect(useClipStore.getState().activeTimelineId).toBe(
      story().edit.timelineId,
    );
  });
});

/** The fixture with a rendered film on the shelf. */
function withTheFilm(base: MokaFile): MokaFile {
  const moka = base;
  const film = {
    id: "asset-film",
    name: "the film.mp4",
    path: "assets/videos/the-film.mp4",
    mime: "video/mp4",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    probe: {
      mime: "video/mp4",
      bytes: 2048,
      sha256: "0".repeat(64),
      width: 1920,
      height: 1080,
      durationMs: 5_000,
    },
  };
  return {
    ...moka,
    resources: { ...moka.resources, videos: [...moka.resources.videos, film] },
    stories: (moka.stories ?? []).map((held) =>
      held.id === ids.story
        ? {
            ...held,
            edit: {
              ...held.edit,
              film: {
                assetId: "asset-film",
                jobId: "render-1",
                itemId: "export",
                note: "the film.mp4",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          }
        : held,
    ),
  };
}
