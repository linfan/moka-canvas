import { create } from "zustand";
import { isApiError, runsApi } from "../../../api";
import type {
  CanvasId,
  NodeId,
  RunId,
  RunRecord,
  RunStatus,
  ValidationIssue,
} from "../../../shared/domain";
import { useAppStore } from "./appStore";
import { useProjectStore } from "./projectStore";

const POLL_INTERVAL_MS = 800;

function isActive(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

function hasActiveRuns(runs: RunRecord[]): boolean {
  return runs.some((run) => isActive(run.status));
}

interface RunState {
  runs: RunRecord[];
  selectedRunId: RunId | null;
  loading: boolean;
  starting: boolean;
  error: string | null;
  /** Issues from the last rejected run start, for the inspector to show. */
  lastIssues: ValidationIssue[];
  /**
   * What each node of a run has said so far, by run and then by node.
   *
   * Kept apart by node because a run may ask several, and words typed into
   * one place would read as an answer none of them gave. Display only, and
   * only while the run is going: the record replaces it the moment the run
   * ends, which is why nothing decides from here.
   */
  streamText: Record<RunId, Record<NodeId, string>>;
  load: () => Promise<void>;
  start: (canvasId: CanvasId, nodeIds: NodeId[]) => Promise<RunRecord>;
  cancel: (runId: RunId) => Promise<void>;
  retry: (runId: RunId) => Promise<RunRecord>;
  select: (runId: RunId | null) => void;
  /** Starts listening to what a run says, if nothing already is. */
  openStream: (runId: RunId) => void;
  reset: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let resyncNeeded = false;

/** The runs being listened to, and the way to stop listening to each. */
const listening = new Map<RunId, () => void>();

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function stopListening() {
  for (const stop of listening.values()) stop();
  listening.clear();
}

/** The server wrote run results into canvas.moka; adopt them when idle. */
function adoptServerState() {
  const project = useProjectStore.getState();
  if (!project.moka) return;
  if (project.pending.length > 0 || project.saveStatus === "conflicted") {
    resyncNeeded = true;
    return;
  }
  resyncNeeded = false;
  void project.reload();
}

export const useRunStore = create<RunState>()((set, get) => {
  const foldIn = (record: RunRecord) => {
    set((state) => {
      const index = state.runs.findIndex((run) => run.id === record.id);
      const runs =
        index === -1
          ? [record, ...state.runs]
          : state.runs.map((run) => (run.id === record.id ? record : run));
      return { runs, selectedRunId: record.id };
    });
  };

  /** Swap in a fresh list, noticing runs that just reached a terminal state. */
  const integrate = (fresh: RunRecord[]) => {
    const previous = new Map(get().runs.map((run) => [run.id, run.status]));
    set((state) => ({
      runs: fresh,
      selectedRunId:
        state.selectedRunId &&
        fresh.some((run) => run.id === state.selectedRunId)
          ? state.selectedRunId
          : (fresh[0]?.id ?? null),
    }));
    let completed = 0;
    let failed = 0;
    for (const run of fresh) {
      const before = previous.get(run.id);
      if (before && isActive(before) && !isActive(run.status)) {
        if (run.status === "succeeded") completed += 1;
        else failed += 1;
        adoptServerState();
      }
    }
    if (completed > 0 || failed > 0) {
      const app = useAppStore.getState();
      if (completed > 0)
        app.pushToast(
          "success",
          completed === 1 ? "Run finished" : `${completed} runs finished`,
        );
      if (failed > 0)
        app.pushToast(
          "error",
          failed === 1 ? "Run did not finish" : `${failed} runs did not finish`,
        );
    }
    for (const run of fresh) {
      // Idempotent, so the poll that keeps arriving does not keep opening one.
      if (isActive(run.status)) get().openStream(run.id);
    }
    if (!hasActiveRuns(fresh)) stopPolling();
  };

  const pollOnce = async () => {
    try {
      integrate(await runsApi.list());
    } catch (error) {
      stopPolling();
      set({
        error:
          error instanceof Error ? error.message : "Failed to load run history",
      });
    }
  };

  /**
   * Reads the record of a run a listener was told about.
   *
   * Always asked, whatever the stream said: a stream only ever hurries a
   * display along, and the record is what the canvas and the history believe.
   */
  const adopt = async (runId: RunId) => {
    set((state) => {
      if (!(runId in state.streamText)) return state;
      const streamText = { ...state.streamText };
      delete streamText[runId];
      return { streamText };
    });
    try {
      const record = await runsApi.get(runId);
      integrate([record, ...get().runs.filter((run) => run.id !== runId)]);
    } catch {
      // Unreadable for now. The list poll asks again on its own schedule, so
      // what is missing here is a moment of the display and nothing else.
      ensurePolling();
    }
  };

  const ensurePolling = () => {
    if (pollTimer || !hasActiveRuns(get().runs)) return;
    pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  };

  return {
    runs: [],
    selectedRunId: null,
    loading: false,
    starting: false,
    error: null,
    lastIssues: [],
    streamText: {},

    async load() {
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        integrate(await runsApi.list());
        set({ loading: false });
        ensurePolling();
      } catch (error) {
        set({
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to load run history",
        });
      }
    },

    async start(canvasId, nodeIds) {
      set({ starting: true, error: null, lastIssues: [] });
      try {
        const record = await runsApi.start(canvasId, nodeIds);
        foldIn(record);
        get().openStream(record.id);
        ensurePolling();
        return record;
      } catch (error) {
        if (isApiError(error, "RUN_VALIDATION_FAILED")) {
          const issues = (error.details?.issues ?? []) as ValidationIssue[];
          set({ lastIssues: issues });
        }
        throw error;
      } finally {
        set({ starting: false });
      }
    },

    async cancel(runId) {
      try {
        foldIn(await runsApi.cancel(runId));
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : "Cancel failed",
        });
      }
    },

    async retry(runId) {
      const record = await runsApi.retry(runId);
      foldIn(record);
      get().openStream(record.id);
      ensurePolling();
      return record;
    },

    openStream(runId) {
      // One listener per run: a second would show the same words twice over.
      if (listening.has(runId)) return;
      const stop = runsApi.follow(runId, {
        onWords: ({ nodeId, text }) =>
          set((state) => {
            const said = state.streamText[runId] ?? {};
            return {
              streamText: {
                ...state.streamText,
                [runId]: { ...said, [nodeId]: (said[nodeId] ?? "") + text },
              },
            };
          }),
        onEnded: () => {
          listening.delete(runId);
          void adopt(runId);
        },
        onBroken: () => {
          listening.delete(runId);
          // The shortcut is gone rather than the run: keep asking for the
          // record on a schedule, the way it was asked before there was a
          // stream to hurry it along.
          ensurePolling();
          void adopt(runId);
        },
      });
      listening.set(runId, stop);
    },

    select(runId) {
      set({ selectedRunId: runId });
    },

    reset() {
      stopPolling();
      stopListening();
      resyncNeeded = false;
      set({
        runs: [],
        selectedRunId: null,
        loading: false,
        starting: false,
        error: null,
        lastIssues: [],
        streamText: {},
      });
    },
  };
});

// A run that finished while local edits were in flight resyncs as soon as
// the pending queue drains, so the reload never discards optimistic state.
useProjectStore.subscribe((state) => {
  if (!resyncNeeded || !state.moka) return;
  if (state.pending.length > 0 || state.saveStatus === "conflicted") return;
  resyncNeeded = false;
  void state.reload();
});

export function useSelectedRun(): RunRecord | null {
  return useRunStore(
    (state) => state.runs.find((run) => run.id === state.selectedRunId) ?? null,
  );
}

/** Latest run step status for a node, preferring runs that are still active. */
export function useNodeRunStatus(nodeId: NodeId): RunStatus | null {
  return useRunStore((state) => {
    let fallback: RunStatus | null = null;
    for (const run of state.runs) {
      const step = run.steps.find((entry) => entry.nodeId === nodeId);
      if (!step) continue;
      if (isActive(run.status)) return step.status;
      fallback ??= step.status;
    }
    return fallback;
  });
}

/** The most recent run that included this node, if any. */
export function useLatestRunForNode(nodeId: NodeId): RunRecord | null {
  return useRunStore(
    (state) =>
      state.runs.find((run) =>
        run.steps.some((step) => step.nodeId === nodeId),
      ) ?? null,
  );
}
