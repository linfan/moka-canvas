// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoryJobRecord } from "../../../api/story";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { useHistoryStore } from "../../editor/stores/historyStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  jobProgress,
  stepFailure,
  targetRunning,
  useStoryJobStore,
} from "./storyJobStore";

const ids = storyIds();

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];

/**
 * A local process that answers about batches: whatever the test handed over,
 * by url. The project itself is always answered, since reading a batch's
 * answers in begins by reading the project again.
 */
function serving(answers: Record<string, unknown>) {
  const routes: Record<string, unknown> = {
    "/api/v1/projects/current": {
      root: "/tmp/moka-story-jobs-test",
      moka: buildStoryMokaFile(),
      selfCheck: { ok: true, issues: [] },
    },
    ...answers,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      // The longest match wins: a cancel is not the list it hangs under.
      const key = Object.keys(routes)
        .filter((each) => url.startsWith(each))
        .sort((a, b) => b.length - a.length)[0];
      const payload = key === undefined ? undefined : routes[key];
      if (payload === undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: "NOT_FOUND", message: "no" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }),
  );
}

function job(overrides: Partial<StoryJobRecord> = {}): StoryJobRecord {
  return {
    id: "job-1",
    projectId: "project-1",
    storyId: ids.story,
    kind: "keyframeArt",
    status: "running",
    model: "a-painter",
    items: [
      {
        id: `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`,
        target: {
          kind: "keyframeArt",
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameSecond,
        },
        capability: "image",
        prompt: "雨中的站台",
        inputs: [],
        params: {},
        status: "running",
      },
    ],
    cancelRequested: false,
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

/** The same record with its one piece answered and filed. */
function answered(assetId = "asset-answered"): StoryJobRecord {
  const held = job({ status: "succeeded" });
  return {
    ...held,
    items: [{ ...held.items[0], status: "succeeded", assetIds: [assetId] }],
  };
}

function open(): void {
  useProjectStore.getState().hydrate({
    moka: buildStoryMokaFile(),
    root: "/tmp/moka-story-jobs-test",
    selfCheck: { ok: true, issues: [] },
  });
}

beforeEach(() => {
  calls = [];
  vi.useFakeTimers();
  localStorage.clear();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useStoryJobStore.getState().reset();
  open();
});

afterEach(() => {
  useStoryJobStore.getState().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("starting a batch", () => {
  it("puts the record at the head of the list and starts asking about it", async () => {
    serving({ "/api/v1/projects/current/story/jobs": job() });

    const started = await useStoryJobStore
      .getState()
      .start(ids.story, "keyframeArt", []);

    expect(started?.id).toBe("job-1");
    expect(useStoryJobStore.getState().jobs.map((held) => held.id)).toEqual([
      "job-1",
    ]);
    expect(useStoryJobStore.getState().storyId).toBe(ids.story);
    // It is running, so the room keeps looking.
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls.some((call) => call.method === "GET")).toBe(true);
  });

  it("keeps the reason when a batch cannot be started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "STORY_JOB_BUSY",
              message: "This story already has a job in progress",
              status: 409,
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    const started = await useStoryJobStore
      .getState()
      .start(ids.story, "keyframeArt", []);

    expect(started).toBeNull();
    expect(useStoryJobStore.getState().error).toContain("already has a job");
    expect(useStoryJobStore.getState().jobs).toEqual([]);
  });

  it("sends a reader with no model for this work to the settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: "PROVIDER_NOT_CONFIGURED",
              message: "No image model is configured",
              status: 422,
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    await useStoryJobStore.getState().start(ids.story, "keyframeArt", []);

    const toast = useAppStore.getState().toasts.at(-1);
    expect(toast?.kind).toBe("error");
    expect(toast?.choice?.label).toContain("settings");
    expect(useStoryJobStore.getState().error).toBeNull();
  });
});

describe("a batch coming back", () => {
  it("reads the project again before writing the answers in", async () => {
    const order: string[] = [];
    const project = useProjectStore.getState();
    const reload = vi
      .spyOn(useProjectStore.getState(), "reload")
      .mockImplementation(async () => {
        order.push("reload");
      });
    const apply = vi
      .spyOn(useProjectStore.getState(), "applyLocal")
      .mockImplementation(() => {
        order.push("apply");
        return [];
      });

    serving({ "/api/v1/projects/current/story/jobs": [job()] });
    await useStoryJobStore.getState().load(ids.story);

    serving({
      "/api/v1/projects/current/story/jobs/job-1": answered(),
    });
    await useStoryJobStore.getState().adopt("job-1");

    // The order matters: the assets the batch filed only exist for this client
    // after the project has been read again.
    expect(order).toEqual(["reload", "apply"]);
    expect(project.moka).not.toBeNull();
    reload.mockRestore();
    apply.mockRestore();
  });

  it("does not read an answer in twice", async () => {
    serving({ "/api/v1/projects/current/story/jobs": [answered()] });
    const reload = vi.spyOn(useProjectStore.getState(), "reload");
    const apply = vi.spyOn(useProjectStore.getState(), "applyLocal");

    await useStoryJobStore.getState().load(ids.story);
    const afterFirst = reload.mock.calls.length;
    await useStoryJobStore.getState().load(ids.story);

    expect(afterFirst).toBe(1);
    expect(reload.mock.calls.length).toBe(1);
    reload.mockRestore();
    apply.mockRestore();
  });

  it("stops asking when nothing is running any more", async () => {
    serving({ "/api/v1/projects/current/story/jobs": [job()] });
    await useStoryJobStore.getState().load(ids.story);
    await vi.advanceTimersByTimeAsync(1600);
    const polled = calls.length;
    expect(polled).toBeGreaterThan(0);

    serving({ "/api/v1/projects/current/story/jobs": [answered()] });
    await vi.advanceTimersByTimeAsync(3200);

    // The list says the batch is done, so the room stops asking about it.
    expect(useStoryJobStore.getState().jobs[0].status).toBe("succeeded");
    const after = calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(after);
  });
});

describe("cancelling a batch", () => {
  it("keeps the ending the server answered with", async () => {
    serving({
      "/api/v1/projects/current/story/jobs": [job()],
      "/api/v1/projects/current/story/jobs/job-1/cancel": job({
        status: "cancelled",
        cancelRequested: true,
      }),
    });

    await useStoryJobStore.getState().load(ids.story);
    await useStoryJobStore.getState().cancel("job-1");

    expect(useStoryJobStore.getState().jobs[0].status).toBe("cancelled");
  });
});

describe("what the room reads off a list of batches", () => {
  it("counts a batch's pieces", () => {
    const held = job();
    expect(jobProgress(held)).toEqual({ done: 0, total: 1 });
    expect(jobProgress(answered())).toEqual({ done: 1, total: 1 });
  });

  it("names the step a failure belongs to", () => {
    const failed = answered();
    const withFailure: StoryJobRecord = {
      ...failed,
      items: [{ ...failed.items[0], status: "failed", error: "no" }],
    };
    expect(stepFailure([withFailure], ids.story, "storyboard")).toEqual({
      failed: 1,
      jobId: "job-1",
    });
    // An element's drawing is the element step's work, not the board's.
    expect(stepFailure([withFailure], ids.story, "elements")).toBeNull();
  });

  it("says which places are being made just now", () => {
    const key = `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameSecond}`;
    const other = `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`;
    expect(targetRunning([job()], ids.story, key)).toBe(true);
    expect(targetRunning([job()], ids.story, other)).toBe(false);
    // A batch that has ended is not making anything.
    expect(targetRunning([answered()], ids.story, key)).toBe(false);
    // Nor is another story's batch.
    expect(targetRunning([job()], "story-elsewhere", key)).toBe(false);
  });
});
