import { useEffect, useRef, useState } from "react";
import {
  CAPABILITY_LABELS,
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
import { useRunStore } from "../stores/runStore";
import { GenerationParams, type ParamValue } from "./GenerationParams";

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 220;
/** The tallest the panel gets, which is with every parameter it has showing. */
const PANEL_HEIGHT_PARAMS = 360;
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
  const starting = useRunStore((state) => state.starting);
  const generationOn = useGenerationAvailable();
  const providers = useProviderStore((state) => state.view);
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

  const generate = async () => {
    setBusy(true);
    try {
      // A run is served from the document on disk, so what the panel holds is
      // saved before the run is asked for.
      commit();
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

  const dismiss = () => useEditorStore.getState().closePromptPanel();

  // The camera is read for its own sake as much as for the zoom: it is what
  // re-renders the panel as the view moves, since worldToClient answers from the
  // live camera without telling anyone it changed.
  const zoom = camera?.zoom ?? canvas.viewport.zoom ?? 1;
  const origin = worldToClient({
    x: node.bounds.x,
    y: node.bounds.y + node.bounds.height,
  });
  const tall = paramsOpen ? PANEL_HEIGHT_PARAMS : PANEL_HEIGHT;
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

      {models.length === 0 ? (
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
            void generate();
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
        <button
          className="primary"
          disabled={busy || starting || !generationOn}
          onClick={() => void generate()}
          title={generationOn ? undefined : GENERATION_UNAVAILABLE}
          type="button"
        >
          {busy || starting ? "Starting…" : "Run"}
        </button>
      </div>
    </div>
  );
}
