import { useMemo, useState } from "react";
import type { MokaFile, NodeId, RunRecord } from "../../../shared/domain";
import { useAppStore } from "../stores/appStore";
import { useProjectStore } from "../stores/projectStore";
import { RUN_STATUS_LABEL, retryRun, useRunStore } from "../stores/runStore";

/** The filter's value for the runs of every node. No node id can be this. */
const EVERY_NODE = "every-node";

type HistoryFilter = NodeId | typeof EVERY_NODE;

/** Where each node of the project sits, so a step reads as a name. */
function nodeTitles(moka: MokaFile | null): Map<NodeId, string> {
  const titles = new Map<NodeId, string>();
  for (const canvas of moka?.canvas ?? []) {
    for (const node of canvas.nodes) titles.set(node.id, node.title);
  }
  return titles;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/**
 * What one node of a run was asked with, as the run recorded it.
 *
 * Read from the record rather than from the node, which is the whole of what a
 * history is for: the document may have been edited since, and what a step was
 * actually given is what explains the answer it gave.
 */
function Snapshot({ parameters }: { parameters: unknown }) {
  if (parameters === null || typeof parameters !== "object") return null;
  const entries = Object.entries(parameters as Record<string, unknown>);
  if (entries.length === 0) return null;
  return (
    <dl className="history-params">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            {value !== null && typeof value === "object"
              ? JSON.stringify(value)
              : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RunRow({
  only,
  run,
  titles,
}: {
  only: HistoryFilter;
  run: RunRecord;
  titles: ReadonlyMap<NodeId, string>;
}) {
  const starting = useRunStore((state) => state.starting);
  const active = run.status === "queued" || run.status === "running";
  const steps =
    only === EVERY_NODE
      ? run.steps
      : run.steps.filter((step) => step.nodeId === only);

  /**
   * Asking again: the server retries a run that gave up, keeping the link back
   * to it, while a run that finished is asked over as a new run of its own.
   */
  const askAgain = () => {
    if (run.status === "failed" || run.status === "cancelled") {
      void retryRun(run.id);
      return;
    }
    void useRunStore
      .getState()
      .start(run.canvasId, run.requestedNodeIds)
      .catch((error: unknown) =>
        useAppStore
          .getState()
          .pushToast(
            "error",
            error instanceof Error ? error.message : "Run failed to start",
          ),
      );
  };

  return (
    <li className="history-run" data-testid={`history-run-${run.id}`}>
      <div className="history-run-head">
        <span className={`run-chip run-chip-${run.status}`}>
          {RUN_STATUS_LABEL[run.status]}
          {run.cancelRequested && active ? " · cancelling" : ""}
        </span>
        <span className="history-run-when">{formatWhen(run.createdAt)}</span>
        <button
          disabled={starting || active}
          onClick={askAgain}
          title="Ask for what this run asked for, once more"
          type="button"
        >
          Run again
        </button>
      </div>
      <ul className="history-steps">
        {steps.map((step) => {
          const error =
            step.error ?? (step.status === "failed" ? run.error : undefined);
          return (
            <li className="history-step" key={step.nodeId}>
              <span className="history-step-node">
                {titles.get(step.nodeId) ?? step.nodeId}
              </span>
              <span className={`run-chip run-chip-${step.status}`}>
                {RUN_STATUS_LABEL[step.status]}
              </span>
              {error && <p className="history-step-error">{error}</p>}
              <Snapshot parameters={run.parameters[step.nodeId]} />
            </li>
          );
        })}
      </ul>
    </li>
  );
}

/**
 * What has been asked of this project, newest first.
 *
 * Built from the run records rather than from anything the canvas holds: a run
 * is one ask of one or several nodes, and reading it back whole is how a
 * reader sees which nodes went together, what each was asked with, and how it
 * ended — with the one press that asks for the same thing again.
 */
export function HistoryPanel() {
  const runs = useRunStore((state) => state.runs);
  const loading = useRunStore((state) => state.loading);
  const moka = useProjectStore((state) => state.moka);
  const [only, setOnly] = useState<HistoryFilter>(EVERY_NODE);
  const titles = useMemo(() => nodeTitles(moka), [moka]);

  const filterable = useMemo(() => {
    const seen = new Set<NodeId>();
    for (const run of runs) {
      for (const step of run.steps) seen.add(step.nodeId);
    }
    return [...seen]
      .map((nodeId) => ({ nodeId, title: titles.get(nodeId) ?? nodeId }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [runs, titles]);

  const shown =
    only === EVERY_NODE
      ? runs
      : runs.filter((run) => run.steps.some((step) => step.nodeId === only));

  return (
    <aside
      aria-label="History"
      className="editor-inspector history-panel"
      data-testid="history-panel"
    >
      <h2>History</h2>
      {filterable.length > 1 && (
        <label className="history-filter">
          <span>Asked of</span>
          <select
            aria-label="Filter by node"
            data-testid="history-filter"
            onChange={(event) => setOnly(event.target.value)}
            value={only}
          >
            <option value={EVERY_NODE}>Every node</option>
            {filterable.map(({ nodeId, title }) => (
              <option key={nodeId} value={nodeId}>
                {title}
              </option>
            ))}
          </select>
        </label>
      )}
      {shown.length === 0 && (
        <p className="inspector-empty">
          {runs.length === 0
            ? loading
              ? "Reading what has been asked…"
              : "Nothing has been asked here yet."
            : "Nothing has asked that node."}
        </p>
      )}
      <ul className="history-list">
        {shown.map((run) => (
          <RunRow key={run.id} only={only} run={run} titles={titles} />
        ))}
      </ul>
    </aside>
  );
}
