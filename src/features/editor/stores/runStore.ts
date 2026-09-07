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
  load: () => Promise<void>;
  start: (canvasId: CanvasId, nodeIds: NodeId[]) => Promise<RunRecord>;
  cancel: (runId: RunId) => Promise<void>;
  retry: (runId: RunId) => Promise<RunRecord>;
  select: (runId: RunId | null) => void;
  reset: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let resyncNeeded = false;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
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
      ensurePolling();
      return record;
    },

    select(runId) {
      set({ selectedRunId: runId });
    },

    reset() {
      stopPolling();
      resyncNeeded = false;
      set({
        runs: [],
        selectedRunId: null,
        loading: false,
        starting: false,
        error: null,
        lastIssues: [],
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
