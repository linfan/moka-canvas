/**
 * The batches a story room has out, and what happens when they come back.
 *
 * A batch is minutes of a provider's time, so what is held here is not only the
 * list: it is the waiting, the reading of an answer into the document, and the
 * asking again for the pieces that did not come back. The page says what step
 * it is on; this says what is being tried for it.
 *
 * Nothing is remembered between sessions, and nothing has to be. The server
 * keeps the records, so a room opened tomorrow lists the same batches — and a
 * batch that ended while nobody was looking is read into the story then, by the
 * document's own judgement of whether its answers are already there.
 */

import { create } from "zustand";

import {
  storyApi,
  type StoryJobItemDraft,
  type StoryJobKind,
  type StoryJobRecord,
} from "../../../api/story";
import { isApiError } from "../../../api/client";
import type { StoryDocument } from "../../../shared/domain/types";
import type { StoryStep } from "../../../shared/domain/story";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { applyJobResults } from "../jobs/apply";
import { itemsForTargets, jobKey } from "../jobs/plan";

/** How often a batch that is running is looked at. It runs for minutes. */
export const POLL_MS = 1500;

/** Which steps a batch of each kind is doing the work of. */
const STEP_OF_KIND: Record<StoryJobKind, StoryStep> = {
  outline: "outline",
  elements: "elements",
  storyboard: "storyboard",
  elementArt: "elements",
  keyframeArt: "storyboard",
  actVideo: "storyboard",
  keyframeVideo: "storyboard",
};

function isRunning(status: StoryJobRecord["status"]): boolean {
  return status === "queued" || status === "running";
}

function toast(
  kind: "info" | "success" | "error",
  message: string,
  choice?: { label: string; go: () => void },
): void {
  useAppStore.getState().pushToast(kind, message, choice);
}

/**
 * Saves everything the window is holding, and says whether it all went out.
 *
 * One flush takes the commands it was sent with, so anything written while it
 * was on its way waits for the next one — and a batch asked for on the tail of
 * a chapter written a moment ago is asked for against a document that does not
 * have it yet. Which is what this is for: the server reads the document, so
 * everything in the window has to be the server's before anything is asked of
 * it — or before the document is read back whole, which would drop what was
 * still waiting.
 */
export async function saveEverything(): Promise<boolean> {
  for (let turn = 0; turn < 8; turn += 1) {
    await useProjectStore.getState().flush();
    const { pending, saveStatus } = useProjectStore.getState();
    if (pending.length === 0) return true;
    // Nothing is on its way any more, and something is still waiting: the save
    // was refused or could not be made, and asking now would ask against a
    // document the server does not hold.
    if (saveStatus !== "saved") return false;
  }
  return useProjectStore.getState().pending.length === 0;
}

interface StoryJobState {
  /** The story these batches belong to, which is the one being looked at. */
  storyId: string | null;
  /** That story's batches, newest first. */
  jobs: StoryJobRecord[];
  starting: boolean;
  /** Why starting failed, shown beside the button that asked. */
  error: string | null;
  /** Batches whose answers are being written into the document just now. */
  applying: string[];
  /** Lists the story's batches and reads in whatever has come back. */
  load: (storyId: string | null) => Promise<void>;
  start: (
    storyId: string,
    kind: StoryJobKind,
    items: StoryJobItemDraft[],
  ) => Promise<StoryJobRecord | null>;
  cancel: (id: string) => Promise<void>;
  /** Fetches one batch and reads it in, which is what a poll does. */
  adopt: (id: string) => Promise<void>;
  reset: () => void;
}

/**
 * The batches this process has already read into the document.
 *
 * An optimisation, not the record: what says whether an answer has been applied
 * is the document itself, and reading an applied answer again writes nothing.
 * This is here so a room that is open all afternoon does not reload the project
 * once a second for batches that ended hours ago.
 */
let readIn = new Set<string>();

let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useStoryJobStore = create<StoryJobState>()((set, get) => {
  /**
   * Reads one batch's answers into the document, whether it just ended or
   * ended while the app was closed.
   *
   * The project is re-read first and for a reason: the assets a batch filed
   * arrived on the server's side of the document, and a command that points at
   * one of them is refused until this client has been told about it.
   */
  const readAnswers = async (record: StoryJobRecord): Promise<void> => {
    if (readIn.has(record.id)) return;
    readIn.add(record.id);
    set({ applying: [...get().applying, record.id] });
    try {
      try {
        await useProjectStore.getState().reload();
      } catch {
        // The project could not be read again, so nothing can be written into
        // it just now. The answers are on the record and are read in the next
        // time the room stands up.
        readIn.delete(record.id);
        return;
      }
      const report = applyJobResults(record);
      const failed = record.items.filter(
        (item) => item.status === "failed",
      ).length;
      if (report.applied > 0) {
        toast("success", i18n.t("story:jobs.done", { count: report.applied }));
      }
      if (failed > 0) {
        const story = useProjectStore
          .getState()
          .moka?.stories?.find((held) => held.id === record.storyId);
        toast(
          "error",
          i18n.t("story:jobs.failed", { failed, total: record.items.length }),
          story === undefined
            ? undefined
            : {
                label: i18n.t("story:jobs.retryFailed"),
                go: () => void retryFailed(story, record),
              },
        );
      }
      if (report.notes.length > 0) {
        toast("info", report.notes.join(" "));
      }
    } finally {
      set({ applying: get().applying.filter((id) => id !== record.id) });
    }
  };

  /** Puts a record where it belongs: newest first, replacing an older copy. */
  const integrate = async (record: StoryJobRecord): Promise<void> => {
    const held = get().jobs;
    const at = held.findIndex((job) => job.id === record.id);
    const jobs =
      at === -1
        ? [record, ...held]
        : held.map((job) => (job.id === record.id ? record : job));
    set({ jobs });
    if (!isRunning(record.status)) await readAnswers(record);
  };

  const pollOnce = async (): Promise<void> => {
    const { storyId, jobs } = get();
    if (storyId === null || !jobs.some((job) => isRunning(job.status))) {
      stopPolling();
      return;
    }
    try {
      const read = await storyApi.list(storyId);
      for (const record of read) await integrate(record);
    } catch {
      // A poll that failed is a poll: the next one asks again, and a room that
      // has been closed has stopped asking anyway.
    }
    if (!get().jobs.some((job) => isRunning(job.status))) stopPolling();
  };

  const startPolling = (): void => {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => void pollOnce(), POLL_MS);
  };

  const stopPolling = (): void => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  return {
    storyId: null,
    jobs: [],
    starting: false,
    error: null,
    applying: [],

    async load(storyId) {
      if (storyId === null) {
        get().reset();
        return;
      }
      // What was read in for another story says nothing about this one, and a
      // room reopened reads the whole story's batches again by design.
      if (get().storyId !== storyId) readIn = new Set<string>();
      set({ storyId });
      try {
        const read = await storyApi.list(storyId);
        set({ jobs: read, error: null });
        for (const record of read) {
          if (!isRunning(record.status)) await readAnswers(record);
        }
        if (read.some((record) => isRunning(record.status))) startPolling();
        else stopPolling();
      } catch (problem) {
        set({
          error: problem instanceof Error ? problem.message : String(problem),
        });
      }
    },

    async start(storyId, kind, items) {
      set({ starting: true, error: null });
      try {
        // The server reads the document it holds when it is asked for a batch:
        // a story that is still only in this window is a story it has never
        // heard of, and a chapter written a moment ago is not there to be
        // asked about. So what is still waiting to be saved goes first.
        if (!(await saveEverything())) {
          set({ starting: false });
          toast("error", i18n.t("story:common.stillSaving"));
          return null;
        }
        const record = await storyApi.start(storyId, kind, items);
        // A batch started for the story the room is showing: the list it is
        // put at the head of is that story's, whichever one it was.
        set({ storyId, jobs: [record, ...get().jobs], starting: false });
        startPolling();
        return record;
      } catch (problem) {
        set({ starting: false });
        if (isApiError(problem, "PROVIDER_NOT_CONFIGURED")) {
          toast("error", problem.message, {
            label: i18n.t("story:jobs.openSettings"),
            go: () => useModelStore.getState().openSettings(),
          });
        } else {
          set({
            error: problem instanceof Error ? problem.message : String(problem),
          });
        }
        return null;
      }
    },

    async cancel(id) {
      const record = await storyApi.cancel(id);
      await integrate(record);
    },

    async adopt(id) {
      const record = await storyApi.get(id);
      await integrate(record);
    },

    reset() {
      stopPolling();
      readIn = new Set<string>();
      set({
        storyId: null,
        jobs: [],
        starting: false,
        error: null,
        applying: [],
      });
    },
  };
});

/**
 * Asks again for the pieces of a batch that failed, planned from the story as
 * it stands now.
 *
 * Not the same ask twice: a description edited since the batch went out belongs
 * to the new ask, and so does a reference that has been redrawn. A manuscript's
 * part is the exception, and not really one: the part is the ask, and the file
 * it was cut from is the same file — planning it again would cut the manuscript
 * at edges the first ask did not use.
 */
export async function retryFailed(
  story: StoryDocument,
  job: StoryJobRecord,
): Promise<void> {
  const failed = job.items.filter((item) => item.status === "failed");
  if (failed.length === 0) return;
  const items = failed.flatMap((item) => againFor(story, item));
  if (items.length === 0) return;
  await useStoryJobStore.getState().start(story.id, job.kind, items);
}

/** One failed piece, as it is asked for the second time. */
function againFor(
  story: StoryDocument,
  item: StoryJobRecord["items"][number],
): StoryJobItemDraft[] {
  if (item.target.kind === "outline" && PART_ITEM.test(item.id)) {
    return [
      {
        id: item.id,
        target: item.target,
        capability: item.capability,
        prompt: item.prompt,
      },
    ];
  }
  return itemsForTargets(story, [item.target]);
}

/** An outline piece that answers for one part of a manuscript, not for all. */
const PART_ITEM = /^outline:\d+$/;

/**
 * Asks again for one episode that was written from a manuscript's part.
 *
 * The part is not planned again for the same reason a failed one is not: the
 * ask for a part is the part itself. What the record kept is sent again, so an
 * episode the reader did not like comes back from the same words it came from
 * the first time.
 */
export async function redoChapterPart(
  story: StoryDocument,
  chapterIndex: number,
): Promise<void> {
  const id = `outline:${chapterIndex + 1}`;
  const recorded = useStoryJobStore
    .getState()
    .jobs.filter((job) => job.storyId === story.id && job.kind === "outline")
    .flatMap((job) => job.items)
    .find((item) => item.id === id);
  if (recorded === undefined) {
    toast("info", i18n.t("story:outline.partGone"));
    return;
  }
  await useStoryJobStore.getState().start(story.id, "outline", [
    {
      id,
      target: { kind: "outline" },
      capability: recorded.capability,
      prompt: recorded.prompt,
    },
  ]);
}

/** Makes one place again, from the story as it stands now. */
export async function redoTarget(
  story: StoryDocument,
  target: StoryJobRecord["items"][number]["target"],
): Promise<void> {
  const items = itemsForTargets(story, [target]);
  if (items.length === 0) return;
  await useStoryJobStore
    .getState()
    .start(story.id, target.kind as StoryJobKind, items);
}

// -----------------------------------------------------------------------------
// What the room reads off the batches
// -----------------------------------------------------------------------------

/** How far along a batch is, counted in pieces. */
export function jobProgress(job: StoryJobRecord): {
  done: number;
  total: number;
} {
  const done = job.items.filter((item) => !isRunning(item.status)).length;
  return { done, total: job.items.length };
}

/** Given a story's batches, only the ones working on this step. */
function forStep(
  jobs: StoryJobRecord[],
  storyId: string | null,
  step: StoryStep,
): StoryJobRecord[] {
  if (storyId === null) return [];
  return jobs.filter(
    (job) => job.storyId === storyId && STEP_OF_KIND[job.kind] === step,
  );
}

/** The pieces of a step that failed, which is what its red badge counts. */
export function stepFailure(
  jobs: StoryJobRecord[],
  storyId: string | null,
  step: StoryStep,
): { failed: number; jobId: string } | null {
  for (const job of forStep(jobs, storyId, step)) {
    const failed = job.items.filter((item) => item.status === "failed").length;
    if (failed > 0) return { failed, jobId: job.id };
  }
  return null;
}

/** Whether a place is being made just now, by whichever batch is making it. */
export function targetRunning(
  jobs: StoryJobRecord[],
  storyId: string | null,
  key: string,
): boolean {
  if (storyId === null) return false;
  return jobs.some(
    (job) =>
      job.storyId === storyId &&
      isRunning(job.status) &&
      job.items.some(
        (item) => jobKey(item.target) === key && isRunning(item.status),
      ),
  );
}

/** A story's batches, newest first, as the room shows them. */
export function useStoryJobs(storyId: string | null): StoryJobRecord[] {
  const jobs = useStoryJobStore((state) => state.jobs);
  const held = useStoryJobStore((state) => state.storyId);
  if (storyId === null || held !== storyId) return [];
  return jobs.filter((job) => job.storyId === storyId);
}

/** The failures standing on one step, for the badge and the retry wording. */
export function useStoryStepFailure(
  storyId: string | null,
  step: StoryStep,
): { failed: number; jobId: string } | null {
  const jobs = useStoryJobs(storyId);
  return stepFailure(jobs, storyId, step);
}

/** Whether the place this key names is being made just now. */
export function useTargetRunning(storyId: string | null, key: string): boolean {
  const jobs = useStoryJobs(storyId);
  return targetRunning(jobs, storyId, key);
}

/** The batch a story is running just now, if it is running one. */
export function useRunningJob(storyId: string | null): StoryJobRecord | null {
  const jobs = useStoryJobs(storyId);
  return jobs.find((job) => isRunning(job.status)) ?? null;
}

/**
 * The one way a step's button asks for work.
 *
 * A step plans its pieces ({@link planOutline} and its sisters) and hands them
 * over; what happens next — the wait, the reading in, the toast when it cannot
 * start — is not the step's to tell. A button with nothing to ask for says so
 * rather than starting a batch that would come back empty.
 */
export function useStoryRun(): (
  storyId: string,
  kind: StoryJobKind,
  items: StoryJobItemDraft[],
) => Promise<void> {
  const start = useStoryJobStore((state) => state.start);
  return async (storyId, kind, items) => {
    if (items.length === 0) {
      toast("info", i18n.t("story:jobs.nothingToAsk"));
      return;
    }
    await start(storyId, kind, items);
  };
}
