import { useEffect, useRef, useState } from "react";
import {
  CAPABILITY_LABELS,
  MAX_PROMPT_LENGTH,
  boundsForShape,
  defaultGenerationSpec,
  findNode,
  generationCapabilityFor,
  nowIso,
  type Capability,
  type GenerationMode,
  type GenerationSpec,
  type NodeId,
  type Rect,
  type RunStatus,
  type WorkflowNode,
} from "../../../shared/domain";
import { ModelPicker } from "../../settings/ModelPicker";
import {
  modelOptionsFor,
  useProviderStore,
} from "../../settings/providerStore";
import { worldToClient } from "../canvas/canvasControl";
import { setNodeGeneration } from "../interactions/actions";
import {
  GENERATION_UNAVAILABLE,
  useAppStore,
  useGenerationAvailable,
} from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { useLatestRunForNode, useRunStore } from "../stores/runStore";
import { GenerationParams, type ParamValue } from "./GenerationParams";

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 220;
/** The tallest the panel gets, which is with every parameter it has showing. */
const PANEL_HEIGHT_PARAMS = 360;
/** What the panel grows by once it is counting a prompt out loud. */
const PANEL_HEIGHT_COUNT = 22;
/** Gap left between the panel and the node, and between it and a canvas edge. */
const GAP = 8;

/**
 * The parameter that states the shape of what a node makes, and so the shape the
 * node itself is given while it waits.
 */
const SHAPE_PARAM: Record<Capability, string | null> = {
  image: "size",
  video: "ratio",
  text: null,
  audio: null,
};

/** The modes each kind of node can be asked in. */
const MODES: Record<Capability, readonly GenerationMode[]> = {
  text: ["generate", "question", "extend"],
  image: ["generate", "edit"],
  audio: ["generate", "extend"],
  video: ["generate", "extend"],
};

const MODE_LABELS: Record<GenerationMode, string> = {
  generate: "Generate",
  edit: "Edit",
  extend: "Extend",
  question: "Question",
};

/** Whether a node already holds something rather than waiting to be filled. */
function holdsSomething(node: WorkflowNode): boolean {
  const data = node.data as { assetId?: string; content?: string };
  return Boolean(data.assetId) || (data.content ?? "").trim() !== "";
}

/** Whether a run still has something left to do. */
function isGoing(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * How long a prompt gets before the panel counts it out loud.
 *
 * A count beside every word would be noise for the short asks that are most of
 * them; what matters is that the limit is not reached in silence.
 */
const COUNTED_FROM = Math.round(MAX_PROMPT_LENGTH * 0.9);

/**
 * Why this node cannot be asked yet, or null when it can.
 *
 * Stated on the control rather than left to be discovered by using it: a refusal
 * that arrives as a failed run costs a round trip, and reads as something a
 * provider did rather than as something missing here.
 */
function refusalFor(asked: {
  available: boolean;
  /** Settled: the models were read, and this kind of node has none to be pointed at. */
  noModel: boolean;
  capability: Capability;
  prompt: string;
  fedFromUpstream: boolean;
}): string | null {
  if (!asked.available) return GENERATION_UNAVAILABLE;
  if (asked.noModel) {
    const kind = CAPABILITY_LABELS[asked.capability].toLowerCase();
    return `No ${kind} model is configured yet`;
  }
  if (asked.prompt.trim() === "" && !asked.fedFromUpstream) {
    return "Nothing to ask for yet: write a prompt, or connect one";
  }
  const over = asked.prompt.length - MAX_PROMPT_LENGTH;
  if (over > 0) {
    const limit = MAX_PROMPT_LENGTH.toLocaleString();
    return `The prompt is ${over.toLocaleString()} characters past the ${limit} it may be`;
  }
  return null;
}

/**
 * Asks one node for something: the mode, the model, the words, and the button
 * that sends them.
 *
 * A DOM panel under the node rather than part of its card, because a card drawn
 * on a canvas has no room for a form and a child element in it would break the
 * canvas's own hit testing. Anchored in world coordinates so it travels with the
 * node, and kept inside the canvas by clamping in CSS rather than by measuring:
 * on the first render there is nothing to measure yet, so a measured clamp would
 * show the panel in the wrong place until something else happened to redraw it.
 *
 * What is typed is held here until it is asked for, so a keystroke is not an
 * undo entry and a save; the discrete controls write straight through, because
 * a click is a choice rather than a draft of one.
 */
export function PromptPanel() {
  const open = useEditorStore((state) => state.promptPanel);
  const onSelect = useEditorStore((state) => state.promptPanelOnSelect);
  const selected = useEditorStore((state) => state.selection.nodeIds);
  const camera = useEditorStore((state) => state.camera);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const generationOn = useGenerationAvailable();
  const providers = useProviderStore((state) => state.view);
  const run = useLatestRunForNode(open?.nodeId ?? null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const shownFor = useRef<NodeId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  const node = open && canvas ? findNode(canvas, open.nodeId) : null;
  const capability = node ? generationCapabilityFor(node.kind) : null;
  const nodeId = node && capability ? node.id : null;
  const chosen =
    selected.length === 1 && canvas ? findNode(canvas, selected[0]) : undefined;
  const chosenId =
    chosen && generationCapabilityFor(chosen.kind) !== null ? chosen.id : null;

  /**
   * Brings the panel up with the selected node, once per selection.
   *
   * Remembering which node it was shown for is what lets Escape close it: an
   * effect that only asked whether the panel is open would put it straight back,
   * and the key would look like it did nothing.
   */
  useEffect(() => {
    if (!onSelect) {
      shownFor.current = null;
      return;
    }
    if (shownFor.current === chosenId) return;
    shownFor.current = chosenId;
    if (chosenId) useEditorStore.getState().openPromptPanel(chosenId);
  }, [onSelect, chosenId]);

  // The panel is about a selected node, so a selection that has let go of that
  // node takes the panel with it.
  useEffect(() => {
    const current = useEditorStore.getState().promptPanel;
    if (current && !selected.includes(current.nodeId)) {
      useEditorStore.getState().closePromptPanel();
    }
  }, [selected]);

  useEffect(() => {
    if (!nodeId || !node) return;
    const stored = (node.data as { generation?: GenerationSpec }).generation;
    setPrompt(stored?.prompt ?? "");
    // Taking the keyboard is for an entry the user chose. Coming up because a
    // node was selected must not, or words would land in the prompt and Delete
    // would stop deleting the node.
    if (!open?.focus) return;
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!node || !canvas || !capability) return null;

  const stored = (node.data as { generation?: GenerationSpec }).generation;
  const spec = stored ?? defaultGenerationSpec(node.kind);
  if (!spec) return null;

  const offered = MODES[capability];
  // An image node already holding something is more often to be changed than
  // started over, so that is what its panel starts on.
  const opening: GenerationMode =
    capability === "image" && holdsSomething(node) ? "edit" : "generate";
  const mode = stored && offered.includes(stored.mode) ? stored.mode : opening;
  const models = modelOptionsFor(providers, capability);
  const going = run !== null && isGoing(run.status);
  const stopping = run !== null && going && run.cancelRequested;
  /**
   * Whether the run this node was last asked in is one worth asking again as a
   * follower of itself, which is what keeps the two visible as one question
   * asked twice rather than as two that have nothing to do with each other.
   * Only where it asked for this node and nothing else: a run that drove several
   * is not this panel's to send off again.
   */
  const again =
    run !== null &&
    !going &&
    (run.status === "failed" || run.status === "cancelled") &&
    run.requestedNodeIds.length === 1 &&
    run.requestedNodeIds[0] === node.id;
  // A configuration still being read is not one with nothing in it.
  const noModel = providers !== null && models.length === 0;
  // What a node with no words of its own may still be asked for: something
  // arriving on its prompt port, or a reference it points at by hand.
  const fedFromUpstream =
    spec.referenceNodeIds.length > 0 ||
    canvas.edges.some(
      (edge) =>
        edge.target.nodeId === node.id && edge.target.portId === "prompt",
    );
  const refusal = refusalFor({
    available: generationOn,
    noModel,
    capability,
    prompt,
    fedFromUpstream,
  });
  const over = prompt.length - MAX_PROMPT_LENGTH;
  const counted = prompt.length >= COUNTED_FROM;

  const commit = (patch: Partial<GenerationSpec> = {}, bounds?: Rect) => {
    setNodeGeneration(
      canvas.id,
      node.id,
      {
        ...spec,
        mode,
        prompt,
        ...patch,
        updatedAt: nowIso(),
      },
      bounds,
    );
  };

  const setParam = (key: string, value: ParamValue | null) => {
    const params = { ...spec.params };
    if (value === null) delete params[key];
    else params[key] = value;
    // A shape is the shape of the node as well, while the node is still waiting
    // for something: an empty one is resized to it in the same step. One that
    // already holds something keeps the size its content gave it, since a
    // picture has the shape it has whatever was asked for.
    const reshaped =
      value !== null && key === SHAPE_PARAM[capability] && !holdsSomething(node)
        ? boundsForShape(node.bounds, `${value}`)
        : null;
    commit({ params }, reshaped ?? undefined);
  };

  // Losing focus with nothing typed is not a request. The panel came up on its
  // own here, and a spec written for it would make the node look runnable
  // before anything had been asked of it.
  const commitPrompt = () => {
    if (!stored && prompt.trim() === "") return;
    commit({ prompt });
  };

  /**
   * Asks the node for what the panel holds.
   *
   * Where a run of this node's gave up, the ask follows it rather than starting
   * over: a retry is asked against the document as it now stands, so what has
   * been typed since still counts, and the two runs stay visible as one question
   * asked twice rather than as two with nothing to do with each other.
   */
  const ask = async () => {
    setBusy(true);
    try {
      // A run is served from the document on disk, so what the panel holds is
      // saved before the run is asked for.
      commit();
      await useProjectStore.getState().flush();
      const runs = useRunStore.getState();
      if (again && run) await runs.retry(run.id);
      else await runs.start(canvas.id, [node.id]);
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

  /**
   * Asks a run still going to stop.
   *
   * The store says so at once rather than when the server answers, so the
   * control reads as one that has been used instead of one still waiting to be.
   */
  const stop = () => {
    if (run) void useRunStore.getState().cancel(run.id);
  };

  const dismiss = () => useEditorStore.getState().closePromptPanel();

  // The camera is read for its own sake as much as for the zoom: it is what
  // re-renders the panel as the view moves, since worldToClient answers from the
  // live camera without telling anyone it changed.
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  const origin = worldToClient({
    x: node.bounds.x,
    y: node.bounds.y + node.bounds.height,
  });
  const tall =
    (paramsOpen ? PANEL_HEIGHT_PARAMS : PANEL_HEIGHT) +
    (counted ? PANEL_HEIGHT_COUNT : 0);
  const style: React.CSSProperties = {
    left: `clamp(${GAP}px, ${origin?.x ?? 0}px, calc(100% - ${
      PANEL_WIDTH + GAP
    }px))`,
    top: `clamp(${GAP}px, ${(origin?.y ?? 0) + GAP * zoom}px, calc(100% - ${
      tall + GAP
    }px))`,
    width: PANEL_WIDTH,
  };

  return (
    <div
      aria-label={`Generation panel for ${node.title}`}
      className="prompt-panel"
      data-testid="prompt-panel"
      role="group"
      style={style}
    >
      <div className="prompt-panel-head">
        <div aria-label="Mode" className="prompt-panel-modes" role="group">
          {offered.map((option) => (
            <button
              aria-pressed={option === mode}
              className={option === mode ? "is-active" : ""}
              key={option}
              onClick={() => commit({ mode: option })}
              type="button"
            >
              {MODE_LABELS[option]}
            </button>
          ))}
        </div>
        <button
          aria-label="Close the generation panel"
          className="prompt-panel-close"
          onClick={dismiss}
          type="button"
        >
          ✕
        </button>
      </div>

      {noModel ? (
        <div className="prompt-panel-models">
          <p className="prompt-panel-note">
            No {CAPABILITY_LABELS[capability].toLowerCase()} model is configured
            yet.
          </p>
          <button
            onClick={() => useProviderStore.getState().openSettings("channels")}
            type="button"
          >
            Configure models
          </button>
        </div>
      ) : (
        <ModelPicker
          capability={capability}
          noneLabel="Provider default"
          onChange={(reference) => commit({ model: reference ?? "" })}
          value={spec.model || null}
        />
      )}

      <textarea
        aria-label={`Prompt for ${node.title}`}
        className="prompt-panel-input"
        onBlur={commitPrompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void ask();
          } else if (event.key === "Escape") {
            event.preventDefault();
            dismiss();
          }
        }}
        placeholder="What should this node make?"
        ref={areaRef}
        rows={3}
        value={prompt}
      />

      {counted && (
        <p
          className={
            over > 0 ? "prompt-panel-count is-over" : "prompt-panel-count"
          }
        >
          {prompt.length.toLocaleString()} of{" "}
          {MAX_PROMPT_LENGTH.toLocaleString()} characters
        </p>
      )}

      {paramsOpen && (
        <GenerationParams
          capability={capability}
          defaults={providers?.preferences ?? null}
          key={node.id}
          onChange={setParam}
          params={spec.params}
        />
      )}

      <div className="prompt-panel-actions">
        <button
          aria-expanded={paramsOpen}
          onClick={() => setParamsOpen((shown) => !shown)}
          title="What this node's own ask carries, over the defaults set in settings"
          type="button"
        >
          Parameters
        </button>
        {going ? (
          <button
            className="primary"
            disabled={stopping}
            onClick={stop}
            title={
              stopping
                ? "This run has been asked to stop and has not noticed yet"
                : "Stop this run"
            }
            type="button"
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || refusal !== null}
            onClick={() => void ask()}
            title={refusal ?? undefined}
            type="button"
          >
            {busy ? "Starting…" : again ? "Ask again" : "Run"}
          </button>
        )}
      </div>
    </div>
  );
}
