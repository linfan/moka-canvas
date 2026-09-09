import { useMemo } from "react";
import { create } from "zustand";
import { isApiError, runsApi } from "../../../api";
import type {
  AssetCategory,
  CanvasId,
  NodeId,
  ResourceEntry,
  RunId,
  RunRecord,
  RunStatus,
  RunStepRecord,
  ValidationIssue,
} from "../../../shared/domain";
import { ASSET_CATEGORY_LABELS } from "../../../shared/domain";
import { useAppStore } from "./appStore";
import { useEditorStore } from "./editorStore";
import { useProjectStore } from "./projectStore";

const POLL_INTERVAL_MS = 800;

function isActive(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

function hasActiveRuns(runs: RunRecord[]): boolean {
  return runs.some((run) => isActive(run.status));
}

/** One node's part in one run. */
interface NodeRun {
  run: RunRecord;
  step: RunStepRecord;
}

/**
 * The runs each node was asked in, newest first.
 *
 * Built when the list of runs changes rather than when a node is read. Every
 * node on a canvas asks what it is doing whenever anything in this store moves,
 * and words arriving from a run move it too, so reading from the list instead
 * walks every step of every run once per node per word.
 */
type RunsByNode = Map<NodeId, NodeRun[]>;

function indexRuns(runs: RunRecord[]): RunsByNode {
  const byNode: RunsByNode = new Map();
  for (const run of runs) {
    for (const step of run.steps) {
      const asked = byNode.get(step.nodeId);
      if (asked) asked.push({ run, step });
      else byNode.set(step.nodeId, [{ run, step }]);
    }
  }
  return byNode;
}

interface RunState {
  runs: RunRecord[];
  /** Derived from `runs`, and rebuilt only when that list changes. */
  byNode: RunsByNode;
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

/**
 * The server wrote run results into the document; adopt them when idle, and hand
 * back the reading so that whatever waits on the new assets can wait for it.
 */
function adoptServerState(): Promise<void> | null {
  const project = useProjectStore.getState();
  if (!project.moka) return null;
  if (project.pending.length > 0 || project.saveStatus === "conflicted") {
    resyncNeeded = true;
    return null;
  }
  resyncNeeded = false;
  return project.reload();
}

/**
 * Where a run that just finished put what it made.
 *
 * Asked once the document has been read back, because the run counts its results
 * but does not say which shelf they were filed on and only the registry does. A
 * run that filed nothing is said to have finished and nothing more: a written
 * answer lands in its node rather than among the assets, and naming a shelf it
 * was not put on would send a reader looking.
 */
async function announceFiling(run: RunRecord, adopted: Promise<void> | null) {
  if (adopted) await adopted;
  const registry = useProjectStore.getState().moka?.resources;
  const filed = registry
    ? (Object.entries(registry) as [AssetCategory, ResourceEntry[]][])
        .map(([shelf, entries]) => ({
          shelf,
          count: entries.filter((entry) => entry.provenance?.runId === run.id)
            .length,
        }))
        .filter((entry) => entry.count > 0)
    : [];
  const app = useAppStore.getState();
  if (filed.length === 0) {
    app.pushToast("success", "Run finished");
    return;
  }
  const named = filed
    .map(({ shelf, count }) => `${ASSET_CATEGORY_LABELS[shelf]} (${count})`)
    .join(", ");
  app.pushToast("success", `Filed under ${named}`, {
    label: "Show assets",
    go: () => useEditorStore.getState().openResourcesPanel(),
  });
}

export const useRunStore = create<RunState>()((set, get) => {
  const foldIn = (record: RunRecord) => {
    set((state) => {
      const at = state.runs.findIndex((run) => run.id === record.id);
      const runs =
        at === -1
          ? [record, ...state.runs]
          : state.runs.map((run) => (run.id === record.id ? record : run));
      return { runs, byNode: indexRuns(runs), selectedRunId: record.id };
    });
  };

  /**
   * The reasons a run was refused for what it asked for.
   *
   * Kept for the inspector rather than only said in a toast: the refusal is
   * about the document, so it belongs where the document is read, and a toast is
   * gone in a few seconds while the node is still sitting there unrun.
   */
  const noteRefusal = (error: unknown) => {
    if (!isApiError(error, "RUN_VALIDATION_FAILED")) return;
    set({ lastIssues: (error.details?.issues ?? []) as ValidationIssue[] });
  };

  /** Swap in a fresh list, noticing runs that just reached a terminal state. */
  const integrate = (fresh: RunRecord[]) => {
    const previous = new Map(get().runs.map((run) => [run.id, run.status]));
    set((state) => ({
      runs: fresh,
      byNode: indexRuns(fresh),
      selectedRunId:
        state.selectedRunId &&
        fresh.some((run) => run.id === state.selectedRunId)
          ? state.selectedRunId
          : (fresh[0]?.id ?? null),
    }));
    const succeeded: RunRecord[] = [];
    let failed = 0;
    let adopted: Promise<void> | null = null;
    for (const run of fresh) {
      const before = previous.get(run.id);
      if (!before || !isActive(before) || isActive(run.status)) continue;
      if (run.status === "succeeded") succeeded.push(run);
      else failed += 1;
      adopted = adoptServerState() ?? adopted;
    }
    if (failed > 0) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          failed === 1 ? "Run did not finish" : `${failed} runs did not finish`,
        );
    }
    for (const run of succeeded) void announceFiling(run, adopted);
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
    byNode: new Map(),
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
        noteRefusal(error);
        throw error;
      } finally {
        set({ starting: false });
      }
    },

    async cancel(runId) {
      // Said at once rather than when the server answers: a run takes a moment
      // to notice, and until it does the control would still read as one that
      // can be asked to stop, so the same hand would ask it again.
      set((state) => {
        const runs = state.runs.map((run) =>
          run.id === runId ? { ...run, cancelRequested: true } : run,
        );
        return { runs, byNode: indexRuns(runs) };
      });
      try {
        foldIn(await runsApi.cancel(runId));
      } catch (error) {
        // The record still coming in from the poll says which of the two it was.
        set({
          error: error instanceof Error ? error.message : "Cancel failed",
        });
      }
    },

    async retry(runId) {
      set({ starting: true, error: null, lastIssues: [] });
      try {
        const record = await runsApi.retry(runId);
        foldIn(record);
        get().openStream(record.id);
        ensurePolling();
        return record;
      } catch (error) {
        noteRefusal(error);
        throw error;
      } finally {
        set({ starting: false });
      }
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
        byNode: new Map(),
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

/**
 * The run a node is read through, and its step in it: one still going if there
 * is one, otherwise the newest that mentioned the node.
 *
 * Going wins over newest because a reader is asking what the node is doing, and
 * since two runs may drive at once the newest record for a node is not always
 * the one that has anything left to say about it.
 */
function runFor(byNode: RunsByNode, nodeId: NodeId): NodeRun | null {
  const asked = byNode.get(nodeId);
  return asked ? current(asked) : null;
}

function current(asked: NodeRun[]): NodeRun | null {
  return asked.find((entry) => isActive(entry.run.status)) ?? asked[0] ?? null;
}

/** What one node's own run has to say about it, as a card draws it. */
export interface NodeRunView {
  status: RunStatus;
  /** How far the step got, where anybody measured one; null where nobody has. */
  progress: number | null;
  /** What the step last said went wrong. */
  error: string | null;
  /** The words the run is still typing for this node, and nothing once it ends. */
  said: string;
}

/**
 * What every node's own run says about it, for a reader asking about all of them
 * at once rather than one of them.
 *
 * Answered from the index rather than from the list of runs: the canvas asks
 * whenever anything moves, and moving includes every word a run says. One walk
 * answers the whole canvas, so a card draws from this rather than reaching back
 * into the runs for each of the four things it shows.
 */
export function nodeRunViews(): ReadonlyMap<NodeId, NodeRunView> {
  const state = useRunStore.getState();
  const views = new Map<NodeId, NodeRunView>();
  for (const [nodeId, asked] of state.byNode) {
    const found = current(asked);
    if (!found) continue;
    views.set(nodeId, {
      status: found.step.status,
      progress: found.step.progress ?? null,
      error: found.step.error ?? null,
      said: isActive(found.run.status)
        ? (state.streamText[found.run.id]?.[nodeId] ?? "")
        : "",
    });
  }
  return views;
}

function stepOf(byNode: RunsByNode, nodeId: NodeId): RunStepRecord | null {
  return runFor(byNode, nodeId)?.step ?? null;
}

/**
 * The most recent run that included this node, if any.
 *
 * Asked of no node it answers nothing, so a reader holding a selection that may
 * be empty can ask without branching first: a hook has to be called the same way
 * every time round, whichever node — or none — is in hand.
 */
export function useLatestRunForNode(nodeId: NodeId | null): RunRecord | null {
  return useRunStore((state) =>
    nodeId === null ? null : (runFor(state.byNode, nodeId)?.run ?? null),
  );
}

/** Latest run step status for a node, preferring runs that are still active. */
export function useNodeRunStatus(nodeId: NodeId): RunStatus | null {
  return useRunStore((state) => stepOf(state.byNode, nodeId)?.status ?? null);
}

/**
 * How far along a node's step says it is, from 0 to 1.
 *
 * Null rather than 0 when nobody reported one: a step that has not been
 * measured yet has not made no progress, it has made an unknown amount, and a
 * bar drawn at empty would say the first of those.
 */
export function useNodeRunProgress(nodeId: NodeId): number | null {
  return useRunStore((state) => stepOf(state.byNode, nodeId)?.progress ?? null);
}

/** What a node's step last said went wrong, if anything. */
export function useNodeRunError(nodeId: NodeId | null): string | null {
  return useRunStore((state) =>
    nodeId === null ? null : (stepOf(state.byNode, nodeId)?.error ?? null),
  );
}

/**
 * What the run a node is in has said for that node so far.
 *
 * Empty once the run is over: the record replaces the words, and a run holding
 * several nodes keeps each one's apart so what is typed here reads as an answer
 * this node gave rather than one any of them did.
 */
export function useNodeStreamText(nodeId: NodeId): string {
  return useRunStore((state) => {
    const found = runFor(state.byNode, nodeId);
    if (!found || !isActive(found.run.status)) return "";
    return state.streamText[found.run.id]?.[nodeId] ?? "";
  });
}

const NO_ASSETS: ResourceEntry[] = [];

/**
 * The assets a node's generation produced.
 *
 * Read off the assets' own provenance rather than off the node's result slots:
 * provenance travels with the file into an exported package, where the run that
 * made it does not, and it names the node that made it rather than only what
 * the node ended up pointing at.
 */
export function useNodeGenerationAssets(nodeId: NodeId): ResourceEntry[] {
  const moka = useProjectStore((state) => state.moka);
  return useMemo(() => {
    if (!moka) return NO_ASSETS;
    const made = Object.values(moka.resources)
      .flat()
      .filter((entry) => entry.provenance?.operationNodeId === nodeId);
    return made.length === 0 ? NO_ASSETS : made;
  }, [moka, nodeId]);
}
