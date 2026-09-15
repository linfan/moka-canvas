import { useEffect, useMemo, useState } from "react";
import type {
  AssetCategory,
  AssetId,
  AssetProvenance,
  BackgroundMode,
  CanvasDocument,
  GenerationSpec,
  MokaFile,
  NodeKind,
  ResourceEntry,
  ResultSlot,
  WorkflowEdge,
  WorkflowNode,
} from "../../../shared/domain";
import {
  ASSET_CATEGORY_LABELS,
  BACKGROUND_MODES,
  CAPABILITY_LABELS,
  PROVIDER_EXECUTOR_KEY,
  executorKeyForNode,
  generationSpecFromSnapshot,
} from "../../../shared/domain";
import { assetsApi, assetUrl } from "../../../api";
import {
  GENERATION_UNAVAILABLE,
  useAppStore,
  useGenerationAvailable,
} from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas, useProjectStore } from "../stores/projectStore";
import {
  RUN_STATUS_LABEL,
  isActive,
  retryRun,
  useLatestRunForNode,
  useNodeGenerationAssets,
  useNodeRunError,
  useNodeRunProgress,
  useNodeRuns,
  useNodeStreamText,
  useRunStore,
} from "../stores/runStore";
import {
  buildIssueIndex,
  buildResourceIndex,
  formatBytes,
  formatDuration,
  mediaInfoForNode,
} from "../canvas/mediaCards";
import { CANVAS_THEME_LABELS, CANVAS_THEME_NAMES } from "../canvas/theme";
import { useAppearance } from "../stores/appearance";
import {
  chooseResult,
  choosableResults,
  deleteSelection,
  disconnectEdge,
  fileNodeAsAsset,
  filingPossible,
  focusAssetUses,
  linkAsset,
  markAssetKeeper,
  renameNode,
  requestDeleteAsset,
  setCanvasViewSettings,
  setNodeGeneration,
} from "../interactions/actions";
import { canvasNodesUsing, shelfOf } from "./canvasAssets";
import { SHELF_WHERE_LABELS, kindOfShelf, shelfWhere } from "./shelfFilter";
import { BAR_ENTRIES, TOOL_LABELS } from "../stores/toolPrefs";

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="inspector-row">
      <span>{label}</span>
      <span title={value}>{value}</span>
    </div>
  );
}

function TitleField({ node }: { node: WorkflowNode }) {
  const [value, setValue] = useState(node.title);
  useEffect(() => setValue(node.title), [node.id, node.title]);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== node.title) {
      renameNode(node.id, trimmed);
    } else {
      setValue(node.title);
    }
  };
  return (
    <input
      aria-label="Node title"
      className="inspector-title-input"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === "Escape") setValue(node.title);
      }}
      value={value}
    />
  );
}

/** Where the assets a node of each kind holds are filed in a project. */
const FILED_UNDER: Partial<Record<NodeKind, readonly AssetCategory[]>> = {
  image: ["images"],
  audio: ["music", "voice"],
  video: ["videos"],
};

/**
 * The project's own assets that could fill this node.
 *
 * Linking one is the other way to fill a node that is waiting: nothing is asked
 * for, so nothing is spent on a provider to get it.
 */
function linkable(moka: MokaFile | null, kind: NodeKind): ResourceEntry[] {
  const filed = FILED_UNDER[kind];
  if (!moka || !filed) return [];
  return filed.flatMap((category) => moka.resources[category] ?? []);
}

/** Preview + metadata + provenance + file actions for a media node's asset. */
function MediaAssetSection({ node }: { node: WorkflowNode }) {
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const openPreview = useEditorStore((state) => state.openPreview);
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map<AssetId, ResourceEntry>()),
    [moka],
  );
  const media = useMemo(() => {
    if (!moka) return null;
    return mediaInfoForNode(node, resources, buildIssueIndex(selfCheck));
  }, [moka, resources, selfCheck, node]);

  if (node.kind !== "image" && node.kind !== "audio" && node.kind !== "video") {
    return null;
  }
  const data = node.data as { assetId?: AssetId };
  if (!data.assetId) {
    const offers = linkable(moka, node.kind);
    return (
      <section className="inspector-section">
        <h3>Asset</h3>
        <p className="inspector-empty">No asset linked</p>
        {offers.length > 0 && (
          <select
            aria-label={`Link an asset to ${node.title}`}
            onChange={(event) => {
              if (event.target.value) linkAsset(node.id, event.target.value);
            }}
            value=""
          >
            <option value="">Link an asset…</option>
            {offers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
      </section>
    );
  }
  const entry = media?.entry;
  const broken = media && media.state !== "ready";

  return (
    <section className="inspector-section">
      <h3>Asset</h3>
      {broken && (
        <p className="inspector-media-broken" role="alert">
          ⚠ Asset {media.state}
          {media.state === "changed" ? " — file contents changed on disk" : ""}
        </p>
      )}
      {media?.state === "ready" && media.url && entry && (
        <>
          {node.kind === "image" && (
            <button
              aria-label="Open full preview"
              className="inspector-preview"
              onClick={() => openPreview(entry.id)}
              type="button"
            >
              <img alt={entry.name} src={media.url} />
            </button>
          )}
          {node.kind === "audio" && (
            <audio controls preload="metadata" src={media.url} />
          )}
          {node.kind === "video" && (
            <video controls preload="metadata" src={media.url} />
          )}
        </>
      )}
      {entry && <AssetRows entry={entry} />}
      {entry?.provenance && (
        <ProvenanceRows entry={entry} resources={resources} />
      )}
      {media?.state === "ready" && entry && (
        <div className="inspector-actions">
          <button onClick={() => void revealAsset(entry.id)} type="button">
            Reveal
          </button>
          <a download={entry.name} href={assetUrl(entry.id)}>
            Download
          </a>
          <button
            className="danger"
            onClick={() => void requestDeleteAsset(entry.id)}
            type="button"
          >
            Remove
          </button>
        </div>
      )}
    </section>
  );
}

function AssetRows({ entry }: { entry: ResourceEntry }) {
  const probe = entry.probe;
  const dimensions =
    probe?.width && probe.height ? `${probe.width}×${probe.height}` : "";
  const audio = probe?.sampleRate
    ? `${Math.round(probe.sampleRate / 100) / 10} kHz · ${probe.channels ?? "?"} ch`
    : "";
  return (
    <>
      <Row label="File" value={entry.name} />
      <Row label="Type" value={entry.mime ?? probe?.mime ?? ""} />
      <Row label="Dimensions" value={dimensions} />
      <Row label="Duration" value={formatDuration(probe?.durationMs)} />
      <Row label="Audio" value={audio} />
      <Row label="Codec" value={probe?.codecSummary ?? ""} />
      <Row label="Size" value={formatBytes(entry.bytes ?? probe?.bytes)} />
      <Row label="Path" value={entry.path} />
    </>
  );
}

/**
 * Which of the tools on the bar made this, in the word the bar uses.
 *
 * A tool records itself in the snapshot it leaves behind, and what it records is
 * the name it answers to on the server. Only a name the bar also offers is read
 * as a tool: anything else is a snapshot from somewhere else, and guessing at it
 * would say something the picture did not do.
 */
function toolThatMade(provenance: AssetProvenance): string | null {
  const named = provenance.parameterSnapshot?.tool;
  if (typeof named !== "string") return null;
  const entry = BAR_ENTRIES.find((candidate) => candidate === named);
  return entry === undefined ? null : TOOL_LABELS[entry];
}

/** The picture a tool worked on, by name when the project still holds it. */
function workedOn(
  provenance: AssetProvenance,
  resources: ReadonlyMap<AssetId, ResourceEntry>,
): string {
  const recorded = provenance.parameterSnapshot?.sourceAssetId;
  const subject =
    provenance.inputAssetIds?.[0] ??
    (typeof recorded === "string" ? recorded : undefined);
  if (!subject) return "";
  return resources.get(subject)?.name ?? subject;
}

/**
 * Where a picture came from.
 *
 * Two things make one here and they leave different marks. A tool worked the
 * pixels of a picture already in the project, so what it has to say is which tool
 * and which picture, and there is no run behind it; an answer from a model has a
 * run and a node that asked for it. Calling a crop "generated by workflow" points
 * at a run that never happened, and rows left empty are questions left hanging.
 */
function ProvenanceRows({
  entry,
  resources,
}: {
  entry: ResourceEntry;
  resources: ReadonlyMap<AssetId, ResourceEntry>;
}) {
  const provenance = entry.provenance;
  if (!provenance) return null;
  const tool = toolThatMade(provenance);
  return (
    <>
      <h3>Provenance</h3>
      {tool ? (
        <>
          <Row label="Made by" value={tool} />
          <Row label="From" value={workedOn(provenance, resources)} />
        </>
      ) : (
        <>
          <Row label="Source" value="Generated by workflow" />
          <Row label="Run" value={provenance.runId ?? ""} />
          <Row
            label="Operation node"
            value={provenance.operationNodeId ?? ""}
          />
        </>
      )}
      <Row label="Created" value={provenance.createdAt} />
    </>
  );
}

/** Incoming-connection chips with disconnect / replace-via-pick actions. */
function InputChips({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const inputPick = useEditorStore((state) => state.inputPick);
  const inputs = node.ports.filter((port) => port.direction === "input");
  if (inputs.length === 0 || node.kind === "group") return null;
  return (
    <section className="inspector-section">
      <h3>Inputs</h3>
      {inputs.map((port) => {
        const incoming = canvas.edges.filter(
          (edge) =>
            edge.target.nodeId === node.id && edge.target.portId === port.id,
        );
        const picking =
          inputPick?.nodeId === node.id && inputPick?.portId === port.id;
        return (
          <div className="inspector-input-port" key={port.id}>
            <div className="inspector-input-head">
              <span>
                {port.label}
                {port.required ? " *" : ""}
              </span>
              <button
                aria-pressed={picking}
                className={picking ? "is-active" : ""}
                onClick={() => {
                  const store = useEditorStore.getState();
                  if (picking) store.stopInputPick();
                  else
                    store.startInputPick({ nodeId: node.id, portId: port.id });
                }}
                type="button"
              >
                {picking ? "Cancel pick" : "Replace"}
              </button>
            </div>
            {picking && (
              <p className="inspector-pick-hint">
                Click a compatible source node on the canvas (Esc to cancel)
              </p>
            )}
            {incoming.length === 0 ? (
              <p className="inspector-empty">Not connected</p>
            ) : (
              <ul className="inspector-chip-list">
                {incoming.map((edge) => (
                  <InputChip canvas={canvas} edge={edge} key={edge.id} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

function InputChip({
  canvas,
  edge,
}: {
  canvas: CanvasDocument;
  edge: WorkflowEdge;
}) {
  const source = canvas.nodes.find((node) => node.id === edge.source.nodeId);
  const portLabel = source?.ports.find(
    (port) => port.id === edge.source.portId,
  )?.label;
  const excerpt =
    source?.kind === "text"
      ? ((source.data as { content?: string }).content ?? "").slice(0, 24)
      : "";
  return (
    <li className="inspector-chip">
      <span className="inspector-chip-label">
        <strong>{source?.title ?? "Unknown"}</strong>
        {portLabel ? ` · ${portLabel}` : ""}
        {excerpt ? <em> “{excerpt}”</em> : null}
      </span>
      <button
        aria-label="Disconnect"
        onClick={() => disconnectEdge(edge.id)}
        type="button"
      >
        ✕
      </button>
    </li>
  );
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}

/** When a file arrived or was last written, as this machine says it. */
function formatStamp(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/**
 * Opens a file in this machine's file manager, and says so when it cannot.
 *
 * One function for both the file a card holds and the file a reader asked the
 * shelf about, since what is being asked of the machine is the same in both
 * cases and the answer it gives when it fails should be too.
 */
async function revealAsset(assetId: AssetId) {
  try {
    await assetsApi.reveal(assetId);
  } catch (error) {
    useAppStore
      .getState()
      .pushToast(
        "error",
        error instanceof Error ? error.message : "Reveal failed",
      );
  }
}

/**
 * The words a text file holds.
 *
 * Read out of the file rather than out of its entry: an entry says what a file
 * is about in a word or two, and a reader who clicked a text file to see what
 * is in it is asking the file. Cut short, since the column beside the canvas is
 * no place to read a long thing — the whole of it is a download away.
 */
function TextExcerpt({ entry }: { entry: ResourceEntry }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let wanted = true;
    setText(null);
    setFailed(false);
    fetch(assetUrl(entry.id))
      .then((response) =>
        response.ok
          ? response.text()
          : Promise.reject(new Error(response.statusText)),
      )
      .then((body) => {
        if (wanted) setText(body.slice(0, 600));
      })
      .catch(() => {
        if (wanted) setFailed(true);
      });
    return () => {
      wanted = false;
    };
  }, [entry.id]);

  if (failed) {
    return (
      <p className="inspector-empty" data-testid="asset-text-failed">
        What is in it could not be read.
      </p>
    );
  }
  if (text === null) {
    return <p className="inspector-empty">Reading…</p>;
  }
  return (
    <p className="inspector-text-excerpt" data-testid="asset-text">
      {text.trim() ? text : "Empty"}
    </p>
  );
}

/** What a node asks a provider to make, as it stands now. */
function GenerationSection({ node }: { node: WorkflowNode }) {
  const spec = (node.data as { generation?: GenerationSpec }).generation;
  if (!spec) return null;
  return (
    <section className="inspector-section">
      <h3>Generation</h3>
      <Row label="Capability" value={CAPABILITY_LABELS[spec.capability]} />
      <Row label="Mode" value={spec.mode} />
      <Row label="Model" value={spec.model || "Provider default"} />
      <Row label="Inputs from" value={spec.inputMode} />
      <h3>Prompt</h3>
      <p className="inspector-text-excerpt">
        {spec.prompt.trim() ? spec.prompt : "Empty"}
      </p>
      {Object.keys(spec.params).length > 0 && (
        <pre className="inspector-json">
          {JSON.stringify(spec.params, null, 2)}
        </pre>
      )}
    </section>
  );
}

/**
 * What the last answer this node produced was asked for, and the way to ask for
 * it again.
 *
 * Taken from the assets rather than from a run record: an exported package
 * carries its assets and their provenance but no runs, so a control that needed
 * the run it came from would be dead in every document that arrived from
 * somewhere else. Asking again is therefore a new run under the snapshot's own
 * spec, and never a retry of a run that may not exist here to retry.
 */
function LastGeneration({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const moka = useProjectStore((state) => state.moka);
  const made = useNodeGenerationAssets(node.id);
  const starting = useRunStore((state) => state.starting);
  const generationOn = useGenerationAvailable();
  const [busy, setBusy] = useState(false);
  const recorded = made
    .map((entry) => entry.provenance)
    .find((provenance) => provenance?.parameterSnapshot);
  const spec = generationSpecFromSnapshot(
    recorded?.parameterSnapshot,
    node.kind,
  );
  const inputs = useMemo(() => {
    const wanted = recorded?.inputAssetIds;
    if (!moka || !wanted) return "";
    const resources = buildResourceIndex(moka);
    return wanted.map((id) => resources.get(id)?.name ?? id).join(", ");
  }, [moka, recorded]);

  if (!recorded || !spec) return null;

  const askAgain = async () => {
    setBusy(true);
    try {
      // A run is served from the document on disk, so a spec this control has
      // to put back is saved before the run is asked for.
      setNodeGeneration(canvas.id, node.id, spec);
      await useProjectStore.getState().flush();
      await useRunStore.getState().start(canvas.id, [node.id]);
    } catch (error) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          error instanceof Error ? error.message : "Run failed to start",
        );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3>Last generation</h3>
      {!recorded.runId && (
        <p className="inspector-note">
          The record of the run that made this did not come with the project.
          What it was asked for did, so it can be asked for again.
        </p>
      )}
      <Row label="Inputs" value={inputs} />
      <pre className="inspector-json">
        {JSON.stringify(recorded.parameterSnapshot, null, 2)}
      </pre>
      <div className="inspector-actions">
        <button
          aria-label="Run again with the parameters of the last generation"
          disabled={busy || starting || !generationOn}
          onClick={() => void askAgain()}
          title={generationOn ? undefined : GENERATION_UNAVAILABLE}
          type="button"
        >
          {busy ? "Starting…" : "Run again"}
        </button>
      </div>
    </>
  );
}

/** Run controls, latest run state, and result slots for the selected node. */
function RunSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const run = useLatestRunForNode(node.id);
  const asked = useNodeRuns(node.id);
  const choices = choosableResults(canvas, node);
  const starting = useRunStore((state) => state.starting);
  const issues = useRunStore((state) => state.lastIssues);
  const generationOn = useGenerationAvailable();
  const progress = useNodeRunProgress(node.id);
  const failure = useNodeRunError(node.id);
  const said = useNodeStreamText(node.id);
  const step = run?.steps.find((entry) => entry.nodeId === node.id);
  /**
   * Whether this node's own part of the run is still going.
   *
   * Read from the step rather than from the run: a run that drove several nodes
   * stays going after one of them has landed, and a node that has finished has
   * no business offering to stop work it is no longer part of. What it offers
   * instead is another run of its own.
   */
  const active = step !== undefined && isActive(step.status);
  const slots = (node.data as { resultSlots?: ResultSlot[] }).resultSlots ?? [];
  const relevantIssues = issues.filter(
    (issue) => !issue.nodeId || issue.nodeId === node.id,
  );
  // Which executor a step would go to, rather than which kind of node this is:
  // a generation node is as runnable as an operation one, and a node neither
  // executor would take has no business offering a control at all.
  const executor = executorKeyForNode(node);
  const offline = executor === PROVIDER_EXECUTOR_KEY && !generationOn;
  const retryable = run?.status === "failed" || run?.status === "cancelled";

  const start = async () => {
    try {
      await useRunStore.getState().start(canvas.id, [node.id]);
    } catch {
      // Issues surface below via lastIssues; transport errors toast globally.
    }
  };

  return (
    <section className="inspector-section">
      <h3>Run</h3>
      {executor !== null && (
        <div className="inspector-actions">
          <button
            disabled={starting || offline}
            onClick={() => void start()}
            title={offline ? GENERATION_UNAVAILABLE : undefined}
            type="button"
          >
            {starting ? "Starting…" : "▶ Run this node"}
          </button>
          {active && run && (
            <button
              className="danger"
              onClick={() => void useRunStore.getState().cancel(run.id)}
              type="button"
            >
              Cancel
            </button>
          )}
          {retryable && run && (
            <button onClick={() => void retryRun(run.id)} type="button">
              Retry
            </button>
          )}
        </div>
      )}
      {offline && <p className="inspector-empty">{GENERATION_UNAVAILABLE}</p>}
      {relevantIssues.length > 0 && (
        <ul className="inspector-issues" role="alert">
          {relevantIssues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              <strong>{issue.code}</strong> {issue.message}
            </li>
          ))}
        </ul>
      )}
      {run && step && (
        <>
          <div className="inspector-row">
            <span>Status</span>
            <span className={`run-chip run-chip-${step.status}`}>
              {RUN_STATUS_LABEL[step.status]}
              {run.cancelRequested && active ? " · cancelling" : ""}
            </span>
          </div>
          {active && progress !== null && (
            <progress
              aria-label="How far this node's run has got"
              className="inspector-progress"
              max={1}
              value={progress}
            />
          )}
          <Row
            label="Started"
            value={formatTime(step.startedAt ?? run.createdAt)}
          />
          <Row label="Finished" value={formatTime(step.finishedAt)} />
          {failure && <p className="inspector-run-error">{failure}</p>}
          {!failure && run.error && !active && (
            <p className="inspector-run-error">{run.error}</p>
          )}
          {said ? (
            <p className="inspector-run-output">{said}</p>
          ) : (
            step.outputText && (
              <p className="inspector-run-output">{step.outputText}</p>
            )
          )}
        </>
      )}
      {asked.length > 1 && (
        <>
          <div className="inspector-row">
            <span>Asked in</span>
            <span className="inspector-run-list">
              {asked.map((entry) => (
                <span
                  className={`run-chip run-chip-${entry.step.status}`}
                  key={entry.run.id}
                >
                  {formatTime(entry.run.createdAt)} ·{" "}
                  {RUN_STATUS_LABEL[entry.step.status]}
                </span>
              ))}
            </span>
          </div>
          <p className="inspector-empty">
            Each ask went ahead. What the node shows is what the last of them to
            land wrote.
          </p>
        </>
      )}
      <LastGeneration canvas={canvas} node={node} />
      {slots.length > 0 && (
        <>
          <h3>Results</h3>
          {slots.map((slot, index) => (
            <div className="inspector-row" key={slot.id}>
              <span>{slot.isPrimary ? "Shown" : `Result ${index + 1}`}</span>
              <span className={`run-chip run-chip-${slot.status}`}>
                {slot.status}
              </span>
            </div>
          ))}
          {choices.length > 0 && (
            <div className="inspector-actions">
              {choices.map((choice) => (
                <button
                  key={choice.slotId}
                  onClick={() => chooseResult(node.id, choice.slotId)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
          {slots.find((slot) => slot.status === "failed")?.error && (
            <p className="inspector-run-error">
              {slots.find((slot) => slot.status === "failed")?.error}
            </p>
          )}
        </>
      )}
      {!run && executor !== null && relevantIssues.length === 0 && (
        <p className="inspector-empty">No runs yet</p>
      )}
    </section>
  );
}

/**
 * The way a node's work is kept to hand.
 *
 * A node that already holds a file is only marked as kept, and one whose words
 * are its own gets them written out; either way the shelf comes away with an
 * entry rather than a second copy of anything.
 */
function ShelfSection({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  const [busy, setBusy] = useState(false);
  if (!filingPossible(node)) return null;
  const save = async () => {
    setBusy(true);
    try {
      await fileNodeAsAsset(canvas.id, node.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="inspector-section">
      <h3>Shelf</h3>
      <div className="inspector-actions">
        <button disabled={busy} onClick={() => void save()} type="button">
          {busy ? "Saving…" : "Save as material"}
        </button>
      </div>
    </section>
  );
}

/**
 * The node as the document holds it, for reading rather than editing.
 *
 * Everything above this is one reading of that object, and when a reading looks
 * wrong the plain copy is what settles it — including the parts that have no
 * row of their own. Folded away because it is for comparing against, not for
 * looking at.
 */
function JsonSection({ node }: { node: WorkflowNode }) {
  const json = JSON.stringify(node, null, 2);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      useEditorStore.getState().announce("Node JSON copied");
    } catch {
      useAppStore
        .getState()
        .pushToast("error", "The clipboard is not available");
    }
  };
  return (
    <details className="inspector-section inspector-json-section">
      <summary>JSON</summary>
      <pre className="inspector-json" data-testid="node-json">
        {json}
      </pre>
      <div className="inspector-actions">
        <button onClick={() => void copy()} type="button">
          Copy JSON
        </button>
      </div>
    </details>
  );
}

function NodeInspector({
  canvas,
  node,
}: {
  canvas: CanvasDocument;
  node: WorkflowNode;
}) {
  return (
    <>
      <TitleField node={node} />
      <div className="inspector-row">
        <span>Kind</span>
        <span>{node.kind}</span>
      </div>
      <div className="inspector-row">
        <span>Position</span>
        <span>
          {Math.round(node.bounds.x)}, {Math.round(node.bounds.y)} ·{" "}
          {Math.round(node.bounds.width)}×{Math.round(node.bounds.height)}
        </span>
      </div>
      {node.kind === "text" && <TextSection node={node} />}
      {node.kind === "operation" && <OperationSection node={node} />}
      {node.kind === "export" && (
        <div className="inspector-row">
          <span>Format</span>
          <span>{(node.data as { format?: string }).format ?? ""}</span>
        </div>
      )}
      <GenerationSection node={node} />
      <MediaAssetSection node={node} />
      <ShelfSection canvas={canvas} node={node} />
      <InputChips canvas={canvas} node={node} />
      <RunSection canvas={canvas} node={node} />
      <JsonSection node={node} />
    </>
  );
}

function TextSection({ node }: { node: WorkflowNode }) {
  const content = (node.data as { content?: string }).content ?? "";
  return (
    <section className="inspector-section">
      <h3>Content</h3>
      <p className="inspector-text-excerpt">
        {content.trim() ? content.slice(0, 280) : "Empty"}
      </p>
      <div className="inspector-actions">
        <button
          onClick={() => useEditorStore.getState().startEditingText(node.id)}
          type="button"
        >
          Edit text
        </button>
      </div>
    </section>
  );
}

function OperationSection({ node }: { node: WorkflowNode }) {
  const data = node.data as {
    operationType?: string;
    parameters?: Record<string, unknown>;
  };
  const params = Object.entries(data.parameters ?? {});
  return (
    <section className="inspector-section">
      <h3>Operation</h3>
      <Row label="Type" value={data.operationType ?? ""} />
      {params.map(([key, value]) => (
        <Row key={key} label={key} value={String(value)} />
      ))}
    </section>
  );
}

function EdgeInspector({
  canvas,
  edge,
}: {
  canvas: CanvasDocument;
  edge: WorkflowEdge;
}) {
  const endpoint = (nodeId: string, portId: string) => {
    const node = canvas.nodes.find((entry) => entry.id === nodeId);
    const port = node?.ports.find((entry) => entry.id === portId);
    return node ? `${node.title}${port ? ` · ${port.label}` : ""}` : "Unknown";
  };
  return (
    <>
      <h2 className="inspector-heading">Edge</h2>
      <Row
        label="From"
        value={endpoint(edge.source.nodeId, edge.source.portId)}
      />
      <Row
        label="To"
        value={endpoint(edge.target.nodeId, edge.target.portId)}
      />
      <div className="inspector-actions">
        <button
          className="danger"
          onClick={() => deleteSelection()}
          type="button"
        >
          Delete edge
        </button>
      </div>
    </>
  );
}

const BACKGROUND_LABELS: Record<BackgroundMode, string> = {
  dots: "Dots",
  lines: "Lines",
  blank: "Blank",
};

/**
 * The canvas's own settings, shown when nothing on it is selected.
 *
 * With no node to describe, the panel says what the surface behind the nodes
 * is drawn with, and what colors the whole board is painted in. The
 * background is the document's own, so it is written into the document and
 * undoes like any other edit; the palette is this machine's, kept beside the
 * project rather than inside it, and offered here because where the canvas is
 * looked at is where a way of looking at it belongs.
 */
function CanvasViewSection({ canvas }: { canvas: CanvasDocument }) {
  const { background, showMinimap } = canvas.settings;
  const theme = useAppearance((state) => state.theme);
  return (
    <section className="inspector-section">
      <h3>Canvas view</h3>
      <div className="inspector-row">
        <span>Background</span>
        <div aria-label="Canvas background" className="tool-group" role="group">
          {BACKGROUND_MODES.map((mode) => (
            <button
              aria-pressed={background === mode}
              className={background === mode ? "is-active" : ""}
              key={mode}
              onClick={() => setCanvasViewSettings({ background: mode })}
              type="button"
            >
              {BACKGROUND_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-row">
        <span>Palette</span>
        <div aria-label="Theme" className="tool-group" role="group">
          {CANVAS_THEME_NAMES.map((name) => (
            <button
              aria-pressed={theme === name}
              className={theme === name ? "is-active" : ""}
              key={name}
              onClick={() => useAppearance.getState().setTheme(name)}
              title="The colors this machine draws the canvas in"
              type="button"
            >
              {CANVAS_THEME_LABELS[name]}
            </button>
          ))}
        </div>
      </div>
      <div className="inspector-row">
        <span>Minimap</span>
        <button
          aria-pressed={showMinimap}
          className={showMinimap ? "is-active" : ""}
          onClick={() => setCanvasViewSettings({ showMinimap: !showMinimap })}
          type="button"
        >
          Show minimap
        </button>
      </div>
    </section>
  );
}

/**
 * A file the project holds, read on its own.
 *
 * What the column beside the canvas says when a reader clicked a file on the
 * shelf rather than a card on the board: what the file is, what it holds, where
 * it came from, and what in this project is made of it. The same file a card
 * holds, described without the card — since a file nobody has put on a board
 * yet is still a file worth reading, and one that forty cards hold is worth
 * reading once.
 */
function AssetInspector({ entry }: { entry: ResourceEntry }) {
  const moka = useProjectStore((state) => state.moka);
  const selfCheck = useProjectStore((state) => state.selfCheck);
  const activeCanvas = useActiveCanvas();
  const resources = useMemo(
    () => (moka ? buildResourceIndex(moka) : new Map<AssetId, ResourceEntry>()),
    [moka],
  );
  const issue = buildIssueIndex(selfCheck).get(entry.id);
  const mime = entry.mime ?? entry.probe?.mime ?? "";
  const shelf = shelfOf(entry);
  const keeper = entry.favorite === true;
  const url = assetUrl(entry.id);
  // Counted here rather than taken from the row that was clicked, since the
  // column reads the file as it stands and not as it stood a click ago.
  const usesHere = activeCanvas ? canvasNodesUsing(activeCanvas, entry.id) : [];
  const usesProject =
    moka?.canvas.reduce(
      (total, canvas) => total + canvasNodesUsing(canvas, entry.id).length,
      0,
    ) ?? 0;
  const cards = (count: number) => `${count} card${count === 1 ? "" : "s"}`;

  return (
    <div className="inspector-asset" data-testid="asset-inspector">
      <h3 className="inspector-asset-name" title={entry.name}>
        {entry.name}
      </h3>
      <section className="inspector-section">
        <h3>Preview</h3>
        {issue && (
          <p className="inspector-media-broken" role="alert">
            ⚠ Asset {issue}
            {issue === "changed" ? " — file contents changed on disk" : ""}
          </p>
        )}
        {!issue && <AssetPreview entry={entry} mime={mime} />}
      </section>
      <section className="inspector-section">
        <h3>File</h3>
        <Row
          label="Shelf"
          value={
            shelf
              ? `${ASSET_CATEGORY_LABELS[shelf]} · ${CAPABILITY_LABELS[kindOfShelf(shelf)]}`
              : ""
          }
        />
        <AssetRows entry={entry} />
        <Row label="Origin" value={SHELF_WHERE_LABELS[shelfWhere(entry)]} />
        <Row label="Kept to hand" value={keeper ? "Yes" : ""} />
        <Row label="Words" value={(entry.tags ?? []).join(", ")} />
        <Row label="About" value={entry.keyword ?? ""} />
        <Row label="Added" value={formatStamp(entry.createdAt)} />
        <Row label="Updated" value={formatStamp(entry.updatedAt)} />
      </section>
      {entry.note && (
        <section className="inspector-section">
          <h3>Note</h3>
          <p className="inspector-text-excerpt">{entry.note}</p>
        </section>
      )}
      {entry.provenance && (
        <section className="inspector-section">
          <ProvenanceRows entry={entry} resources={resources} />
        </section>
      )}
      <section className="inspector-section">
        <h3>Used by</h3>
        <Row label="On this canvas" value={cards(usesHere.length)} />
        <Row label="In this project" value={cards(usesProject)} />
      </section>
      {/* What can be done about the file rather than about a card: where it is
          on this machine, the cards made of it, whether it is kept to hand, and
          whether it stays in the project at all. */}
      <div className="inspector-actions">
        <button
          disabled={usesHere.length === 0}
          onClick={() => focusAssetUses(usesHere)}
          title={
            usesHere.length === 0
              ? "No card on this canvas uses it"
              : `Select the ${cards(usesHere.length)} on this canvas using it`
          }
          type="button"
        >
          Focus cards
        </button>
        <button onClick={() => void revealAsset(entry.id)} type="button">
          Reveal
        </button>
        <a download={entry.name} href={url}>
          Download
        </a>
        <button
          aria-pressed={keeper}
          onClick={() => void markAssetKeeper(entry, !keeper)}
          type="button"
        >
          {keeper ? "Stop keeping" : "Keep to hand"}
        </button>
        <button
          className="danger"
          onClick={() => void requestDeleteAsset(entry.id)}
          type="button"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/**
 * What a file looks like, when it is the kind of file that looks like anything.
 *
 * Drawn from the file itself rather than from a card that holds it, since what
 * is being read here is the file the project holds — the same bytes whichever
 * board it was dragged onto, and readable when no board holds it at all.
 */
function AssetPreview({ entry, mime }: { entry: ResourceEntry; mime: string }) {
  const openPreview = useEditorStore((state) => state.openPreview);
  const url = assetUrl(entry.id);
  if (mime.startsWith("image/")) {
    return (
      <button
        aria-label="Open full preview"
        className="inspector-preview"
        data-testid="asset-preview-image"
        onClick={() => openPreview(entry.id)}
        type="button"
      >
        <img alt={entry.name} src={url} />
      </button>
    );
  }
  if (mime.startsWith("video/")) {
    return (
      <video
        controls
        data-testid="asset-preview-video"
        preload="metadata"
        src={url}
      />
    );
  }
  if (mime.startsWith("audio/")) {
    return (
      <audio
        controls
        data-testid="asset-preview-audio"
        preload="metadata"
        src={url}
      />
    );
  }
  if (mime.startsWith("text/")) return <TextExcerpt entry={entry} />;
  return (
    <p className="inspector-empty" data-testid="asset-preview-none">
      {mime ? `Nothing to show for ${mime}` : "Nothing to show for this file"}
    </p>
  );
}

export function InspectorPanel() {
  const selection = useEditorStore((state) => state.selection);
  const inspectedAssetId = useEditorStore((state) => state.inspectedAssetId);
  const activeCanvas = useActiveCanvas();
  const moka = useProjectStore((state) => state.moka);
  // Read out of the project rather than held from the click that asked: a file
  // deleted or replaced while the column was reading it is read as it stands.
  const inspected = useMemo(
    () =>
      moka && inspectedAssetId
        ? buildResourceIndex(moka).get(inspectedAssetId)
        : undefined,
    [moka, inspectedAssetId],
  );

  const selectedNodes = activeCanvas
    ? activeCanvas.nodes.filter((node) => selection.nodeIds.includes(node.id))
    : [];
  const selectedEdges = activeCanvas
    ? activeCanvas.edges.filter((edge) => selection.edgeIds.includes(edge.id))
    : [];

  let body;
  // A file asked about on the shelf is read first, and stays read until
  // something on the canvas is chosen instead: the shelf's import puts a card
  // on the board and chooses it, so a reader who then clicked the file the card
  // was made of would otherwise be answered about the card they never asked
  // about. Choosing on the canvas puts the file down, so the column always
  // reads the last thing asked of it.
  if (inspected) {
    body = <AssetInspector entry={inspected} />;
  } else if (
    activeCanvas &&
    selectedNodes.length === 1 &&
    selectedEdges.length === 0
  ) {
    body = <NodeInspector canvas={activeCanvas} node={selectedNodes[0]} />;
  } else if (
    activeCanvas &&
    selectedEdges.length === 1 &&
    selectedNodes.length === 0
  ) {
    body = <EdgeInspector canvas={activeCanvas} edge={selectedEdges[0]} />;
  } else if (selectedNodes.length === 0 && selectedEdges.length === 0) {
    body = (
      <>
        <p className="inspector-empty">Nothing selected</p>
        {activeCanvas && <CanvasViewSection canvas={activeCanvas} />}
      </>
    );
  } else {
    body = (
      <ul className="inspector-list">
        {selectedNodes.map((node) => (
          <li key={node.id}>
            <strong>{node.title}</strong>
            <span>{node.kind}</span>
          </li>
        ))}
        {selectedEdges.map((edge) => (
          <li key={edge.id}>
            <strong>Edge</strong>
            <span>
              {edge.source.nodeId} → {edge.target.nodeId}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <aside aria-label="Inspector" className="editor-inspector">
      <h2>Inspector</h2>
      {body}
    </aside>
  );
}
