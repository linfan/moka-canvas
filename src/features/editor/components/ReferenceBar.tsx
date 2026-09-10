import { useState } from "react";
import {
  findNode,
  type AssetId,
  type CanvasDocument,
  type GenerationInputMode,
  type GenerationSpec,
  type NodeId,
  type PortDefinition,
  type ResourceEntry,
  type WorkflowEdge,
  type WorkflowNode,
} from "../../../shared/domain";
import {
  mediaInfoForNode,
  type MediaCardInfo,
  type MediaState,
} from "../canvas/mediaCards";
import { mentionChoices } from "../canvas/mentions";
import { ASSET_DRAG_MIME } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";

/**
 * Where an ask takes what it is given from.
 *
 * Named for what the reader does rather than for the mechanism: the wiring is
 * one way to hand a node something, a list kept by hand is another, and the
 * prompt's own pointing is a third.
 */
const MODE_LABELS: Record<GenerationInputMode, string> = {
  upstream: "Wired in",
  manual: "By hand",
  mentions: "In the prompt",
};

const MODES: readonly GenerationInputMode[] = [
  "upstream",
  "manual",
  "mentions",
];

/** One edge arriving at this node, which is one thing it is being given. */
interface Arrival {
  edge: WorkflowEdge;
  source: WorkflowNode;
  /** What this node calls the input the edge lands on. */
  port: string;
  media: MediaCardInfo | null;
  /** The other inputs of this node the arrival could be moved to. */
  moves: PortDefinition[];
}

/**
 * The inputs of `node` that hold one thing and could take what `source` gives:
 * the mask of a picture being painted over, the frames a shot is built between.
 */
function movesFor(node: WorkflowNode, source: WorkflowNode): PortDefinition[] {
  const gives = source.ports
    .filter((port) => port.direction === "output")
    .flatMap((port) => port.dataTypes);
  return node.ports.filter(
    (port) =>
      port.direction === "input" &&
      port.cardinality === "one" &&
      port.dataTypes.some((type) => gives.includes(type)),
  );
}

/**
 * What is arriving at `node`, in the order the document holds the edges in.
 *
 * That order is the one the resolver reads them in, so the bar lists what will
 * be sent in the order it will be sent rather than in one of its own.
 */
function arrivalsAt(
  canvas: CanvasDocument,
  node: WorkflowNode,
  resources: ReadonlyMap<AssetId, ResourceEntry>,
  issues: ReadonlyMap<AssetId, MediaState>,
): Arrival[] {
  const found: Arrival[] = [];
  for (const edge of canvas.edges) {
    if (edge.target.nodeId !== node.id) continue;
    const source = findNode(canvas, edge.source.nodeId);
    if (!source) continue;
    found.push({
      edge,
      source,
      port:
        node.ports.find((port) => port.id === edge.target.portId)?.label ??
        edge.target.portId,
      media: mediaInfoForNode(source, resources, issues),
      moves: movesFor(node, source).filter(
        (port) => port.id !== edge.target.portId,
      ),
    });
  }
  return found;
}

/** A list with one entry taken from where it was and put where it is going. */
function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [taken] = next.splice(from, 1);
  if (taken === undefined) return next;
  next.splice(to, 0, taken);
  return next;
}

export interface ReferenceBarProps {
  canvas: CanvasDocument;
  issues: ReadonlyMap<AssetId, MediaState>;
  node: WorkflowNode;
  resources: ReadonlyMap<AssetId, ResourceEntry>;
  spec: GenerationSpec;
  /** Takes a wired-in arrival out, which is one edge and one step of history. */
  onCut: (edge: WorkflowEdge) => void;
  /** Brings a node into view on the canvas. */
  onFind: (nodeId: NodeId) => void;
  /** Chooses where the ask takes what it is given from. */
  onMode: (mode: GenerationInputMode) => void;
  /** Moves an arrival to another of this node's inputs. */
  onMove: (edge: WorkflowEdge, portId: string) => void;
  /**
   * Writes the list pointed at by hand, whole.
   *
   * Whole because the order is the priority, and a reorder is one thing a reader
   * will want to undo in one step rather than one per chip that moved.
   */
  onPoint: (nodeIds: NodeId[]) => void;
  /** Says whether the picker is open, which is when the panel needs the room. */
  onPicking: (picking: boolean) => void;
  /** Takes an asset dropped here from the resource panel. */
  onTakeAsset: (assetId: AssetId) => void;
  /** Takes files dropped here from this machine, filed then listed. */
  onTakeFiles: (files: File[]) => void;
}

/**
 * What this node is being given, above the words it is being asked in.
 *
 * The list is read off the graph rather than kept beside it: an edge is the
 * only thing that says one node feeds another, and a second copy of that would
 * be free to disagree with the first.
 */
export function ReferenceBar({
  canvas,
  issues,
  node,
  resources,
  spec,
  onCut,
  onFind,
  onMode,
  onMove,
  onPoint,
  onPicking,
  onTakeAsset,
  onTakeFiles,
}: ReferenceBarProps) {
  const [picking, setPicking] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);

  const arrivals = arrivalsAt(canvas, node, resources, issues);
  const pointed = spec.referenceNodeIds;
  const available = mentionChoices(canvas, node, resources, issues)
    .map((group) => ({
      ...group,
      choices: group.choices.filter(
        (choice) => !pointed.includes(choice.node.id),
      ),
    }))
    .filter((group) => group.choices.length > 0);

  const pick = (open: boolean) => {
    setPicking(open);
    onPicking(open);
  };

  // Where the prompt's own pointing decides, a dropped asset would be wired in
  // to no effect: the ask reads the tokens and nothing else. Better to say so
  // by not being a place anything can be left.
  const takes = spec.inputMode !== "mentions";

  return (
    <div
      aria-label="What this node is given"
      className={hovered ? "reference-bar is-dropping" : "reference-bar"}
      data-testid="reference-bar"
      onDragLeave={() => setHovered(false)}
      onDragOver={(event) => {
        if (!takes) return;
        const kinds = event.dataTransfer.types;
        if (!kinds.includes(ASSET_DRAG_MIME) && !kinds.includes("Files")) {
          return;
        }
        event.preventDefault();
        setHovered(true);
      }}
      onDrop={(event) => {
        setHovered(false);
        if (!takes) return;
        // Consumed here: the canvas under the panel would otherwise take the
        // same drop and make a node of it a second time.
        const files = [...(event.dataTransfer.files ?? [])];
        if (files.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          onTakeFiles(files);
          return;
        }
        const assetId = event.dataTransfer.getData(ASSET_DRAG_MIME);
        if (!assetId) return;
        event.preventDefault();
        event.stopPropagation();
        onTakeAsset(assetId as AssetId);
      }}
      role="group"
    >
      <div
        aria-label="Where the ask takes what it is given from"
        className="reference-modes"
        role="group"
      >
        {MODES.map((mode) => (
          <button
            aria-pressed={mode === spec.inputMode}
            className={mode === spec.inputMode ? "is-active" : ""}
            key={mode}
            onClick={() => onMode(mode)}
            title={
              mode === "upstream"
                ? "Whatever is connected to this node is what it is given"
                : mode === "manual"
                  ? "Only the nodes listed here, in this order"
                  : "Only the nodes the prompt points at with @"
            }
            type="button"
          >
            {MODE_LABELS[mode]}
            {mode === "upstream" && arrivals.length > 0
              ? ` ${arrivals.length}`
              : mode === "manual" && pointed.length > 0
                ? ` ${pointed.length}`
                : ""}
          </button>
        ))}
      </div>

      {spec.inputMode === "upstream" &&
        (arrivals.length === 0 ? (
          <p className="reference-empty">
            Nothing is wired into this node yet.
          </p>
        ) : (
          <ul aria-label="What is wired in" className="reference-chips">
            {arrivals.map((arrival) => (
              <li className="reference-chip" key={arrival.edge.id}>
                {arrival.media?.url && (
                  <img
                    alt=""
                    className="reference-thumb"
                    src={arrival.media.url}
                  />
                )}
                <span className="reference-name">{arrival.source.title}</span>
                <span className="reference-port">{arrival.port}</span>
                {arrival.moves.map((port) => (
                  <button
                    aria-label={`Use ${arrival.source.title} as the ${port.label.toLowerCase()}`}
                    className="reference-action"
                    key={port.id}
                    onClick={() => onMove(arrival.edge, port.id)}
                    type="button"
                  >
                    {port.label}
                  </button>
                ))}
                <button
                  aria-label={`Find ${arrival.source.title} on the canvas`}
                  className="reference-action"
                  onClick={() => onFind(arrival.source.id)}
                  type="button"
                >
                  Find
                </button>
                <button
                  aria-label={`Disconnect ${arrival.source.title} from ${node.title}`}
                  className="reference-action"
                  onClick={() => onCut(arrival.edge)}
                  type="button"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ))}

      {spec.inputMode === "manual" &&
        (pointed.length === 0 ? (
          <p className="reference-empty">
            Nothing is listed yet.{" "}
            {arrivals.length > 0 ? (
              <button
                className="reference-action"
                onClick={() =>
                  onPoint(
                    arrivals
                      .map((arrival) => arrival.source.id)
                      .filter((id, at, all) => all.indexOf(id) === at),
                  )
                }
                type="button"
              >
                List what is wired in
              </button>
            ) : (
              "Connect a node, or write @ to point at one."
            )}
          </p>
        ) : (
          <ul
            aria-label="What is pointed at by hand"
            className="reference-chips"
          >
            {pointed.map((nodeId, at) => {
              const named = findNode(canvas, nodeId);
              const media = named
                ? mediaInfoForNode(named, resources, issues)
                : null;
              const name = named?.title ?? "a node that is gone";
              return (
                <li
                  className={
                    named ? "reference-chip" : "reference-chip is-gone"
                  }
                  draggable={Boolean(named)}
                  key={nodeId}
                  onDragEnd={() => setDragged(null)}
                  onDragOver={(event) => {
                    if (dragged === null) return;
                    event.preventDefault();
                  }}
                  onDragStart={() => setDragged(at)}
                  onDrop={(event) => {
                    // A chip landing on a chip is a reorder, not an asset
                    // arriving from the resource panel.
                    event.stopPropagation();
                    if (dragged === null) return;
                    event.preventDefault();
                    setDragged(null);
                    onPoint(moved(pointed, dragged, at));
                  }}
                >
                  {media?.url && (
                    <img alt="" className="reference-thumb" src={media.url} />
                  )}
                  <span
                    className="reference-name"
                    title="Drag to change the order"
                  >
                    {name}
                  </span>
                  {named && (
                    <button
                      aria-label={`Find ${named.title} on the canvas`}
                      className="reference-action"
                      onClick={() => onFind(named.id)}
                      type="button"
                    >
                      Find
                    </button>
                  )}
                  <button
                    aria-label={`Take ${name} out of the list`}
                    className="reference-action"
                    onClick={() =>
                      onPoint(
                        pointed.filter((_, elsewhere) => elsewhere !== at),
                      )
                    }
                    type="button"
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        ))}

      {spec.inputMode === "mentions" && (
        <p className="reference-empty">
          What the prompt points at with @ is what will be sent, in the order it
          is written.
        </p>
      )}

      {takes && (
        <button
          className="reference-add"
          onClick={() =>
            useEditorStore
              .getState()
              .openAssetPicker({ mode: "reference", nodeId: node.id })
          }
          type="button"
        >
          From assets…
        </button>
      )}

      {spec.inputMode === "manual" && (
        <>
          <button
            aria-expanded={picking}
            className="reference-add"
            onClick={() => pick(!picking)}
            type="button"
          >
            Point at…
          </button>
          {picking && (
            <div
              aria-label="What this node may point at"
              className="reference-pick"
              role="group"
            >
              {available.length === 0 && (
                <p className="prompt-panel-note">
                  Nothing else on this canvas holds anything.
                </p>
              )}
              {available.map((group) => (
                <div key={group.label}>
                  <p className="reference-pick-label">{group.label}</p>
                  {group.choices.map((choice) => (
                    <button
                      key={choice.node.id}
                      onClick={() => onPoint([...pointed, choice.node.id])}
                      type="button"
                    >
                      {choice.media?.url && (
                        <img
                          alt=""
                          className="reference-thumb"
                          src={choice.media.url}
                        />
                      )}
                      <span className="reference-name">
                        {choice.node.title}
                      </span>
                      <span className="reference-summary">
                        {choice.summary}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              <button
                className="reference-add"
                onClick={() => pick(false)}
                type="button"
              >
                Done
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
