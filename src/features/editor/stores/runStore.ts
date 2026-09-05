import { create } from "zustand";
import { runsApi } from "../../../api";
import type { RunId, RunRecord } from "../../../shared/domain";

interface RunState {
  runs: RunRecord[];
  selectedRunId: RunId | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  select: (runId: RunId | null) => void;
  reset: () => void;
}

export const useRunStore = create<RunState>()((set, get) => ({
  runs: [],
  selectedRunId: null,
  loading: false,
  error: null,

  async load() {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const runs = await runsApi.list();
      set((state) => ({
        runs,
        loading: false,
        selectedRunId:
          state.selectedRunId &&
          runs.some((run) => run.id === state.selectedRunId)
            ? state.selectedRunId
            : (runs[0]?.id ?? null),
      }));
    } catch (error) {
      set({
        loading: false,
        error:
          error instanceof Error ? error.message : "Failed to load run history",
      });
    }
  },

  select(runId) {
    set({ selectedRunId: runId });
  },

  reset() {
    set({ runs: [], selectedRunId: null, loading: false, error: null });
  },
}));

export function useSelectedRun(): RunRecord | null {
  return useRunStore(
    (state) => state.runs.find((run) => run.id === state.selectedRunId) ?? null,
  );
}
