import { CANVAS_SCHEMA_VERSION, MOKA_FILE_VERSION } from "./constants";
import { derivePorts } from "./factories";
import type {
  MokaFile,
  ResourceEntry,
  ResultSlot,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

function fixtureId(n: number): string {
  return `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function goldenNodeIds() {
  return {
    project: fixtureId(1),
    canvasMain: fixtureId(2),
    canvasSecond: fixtureId(3),
    text: fixtureId(10),
    image: fixtureId(11),
    operation: fixtureId(12),
    export: fixtureId(13),
    edgeTextOp: fixtureId(20),
    edgeOpExport: fixtureId(21),
    assetImage: fixtureId(30),
  };
}

export function buildGoldenMokaFile(): MokaFile {
  const ids = goldenNodeIds();

  const textNode: WorkflowNode = {
    id: ids.text,
    kind: "text",
    title: "Brief",
    bounds: { x: -320, y: -120, width: 280, height: 200 },
    zIndex: 0,
    ports: derivePorts("text"),
    data: { content: "A lantern floats over a quiet lake at dusk." },
    createdAt: T0,
    updatedAt: T0,
  };

  const imageNode: WorkflowNode = {
    id: ids.image,
    kind: "image",
    title: "Reference image",
    bounds: { x: -320, y: 160, width: 280, height: 220 },
    zIndex: 1,
    ports: derivePorts("image"),
    data: { assetId: ids.assetImage },
    createdAt: T0,
    updatedAt: T0,
  };

  const operationNode: WorkflowNode = {
    id: ids.operation,
    kind: "operation",
    title: "Generate frame",
    bounds: { x: 40, y: -120, width: 300, height: 220 },
    zIndex: 2,
    ports: derivePorts("operation"),
    data: {
      operationType: "deterministic.text",
      parameters: { style: "storyboard" },
      executorKey: "deterministic",
      resultSlots: [],
      resultNodeIds: [],
    },
    createdAt: T0,
    updatedAt: T0,
  };

  const exportNode: WorkflowNode = {
    id: ids.export,
    kind: "export",
    title: "Export",
    bounds: { x: 420, y: -120, width: 280, height: 180 },
    zIndex: 3,
    ports: derivePorts("export"),
    data: { format: "mp4", parameters: { resolution: "1080p" } },
    createdAt: T0,
    updatedAt: T0,
  };

  const edgeTextOp: WorkflowEdge = {
    id: ids.edgeTextOp,
    source: { nodeId: ids.text, portId: "out" },
    target: { nodeId: ids.operation, portId: "text" },
    createdAt: T0,
  };
  const edgeOpExport: WorkflowEdge = {
    id: ids.edgeOpExport,
    source: { nodeId: ids.operation, portId: "out" },
    target: { nodeId: ids.export, portId: "video" },
    createdAt: T0,
  };

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: ids.project,
      name: "Golden Fixture",
      description: "Shared cross-language fixture",
      revision: 3,
      createdAt: T0,
      updatedAt: T1,
    },
    resources: {
      images: [
        {
          id: ids.assetImage,
          name: "lake.png",
          path: "assets/images/lake-00000000.png",
          mime: "image/png",
          bytes: 2048,
          sha256:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          createdAt: T0,
          updatedAt: T0,
          probe: {
            mime: "image/png",
            bytes: 2048,
            sha256:
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            width: 64,
            height: 64,
          },
        },
      ],
      music: [],
      voice: [],
      texts: [],
      videos: [],
    },
    canvas: [
      {
        id: ids.canvasMain,
        name: "Canvas 1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 120.5, y: -40.25, zoom: 1.5 },
        nodes: [textNode, imageNode, operationNode, exportNode],
        edges: [edgeTextOp, edgeOpExport],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
      {
        id: ids.canvasSecond,
        name: "Canvas 2",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [],
        edges: [],
        groups: [],
        settings: {
          background: "lines",
          showMinimap: false,
          snapToGrid: false,
        },
      },
    ],
  };
}

/**
 * A document as schema version 1 stored it: generative nodes had only an
 * output port, plus one hand-added port the table never knew (migration
 * must keep it).
 */
export function buildLegacyV1MokaFile(): MokaFile {
  const textId = fixtureId(110);
  const imageId = fixtureId(111);
  const canvasId = fixtureId(112);

  const textNode: WorkflowNode = {
    id: textId,
    kind: "text",
    title: "Old brief",
    bounds: { x: 0, y: 0, width: 280, height: 200 },
    zIndex: 0,
    ports: [
      ...derivePorts("text").filter((p) => p.direction === "output"),
      {
        id: "legacyNote",
        direction: "input",
        dataTypes: ["text"],
        required: false,
        cardinality: "one",
        label: "Legacy note",
      },
    ],
    data: { content: "Written before ports grew." },
    createdAt: T0,
    updatedAt: T0,
  };

  const imageNode: WorkflowNode = {
    id: imageId,
    kind: "image",
    title: "Old plate",
    bounds: { x: 0, y: 240, width: 280, height: 220 },
    zIndex: 1,
    ports: derivePorts("image").filter((p) => p.direction === "output"),
    data: {},
    createdAt: T0,
    updatedAt: T0,
  };

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: fixtureId(109),
      name: "Legacy Fixture",
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
    },
    resources: { images: [], music: [], voice: [], texts: [], videos: [] },
    canvas: [
      {
        id: canvasId,
        name: "Canvas 1",
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [textNode, imageNode],
        edges: [],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
    ],
  };
}

export function generationNodeIds() {
  return {
    project: fixtureId(119),
    canvas: fixtureId(122),
    text: fixtureId(120),
    image: fixtureId(121),
    edge: fixtureId(123),
  };
}

export function batchNodeIds() {
  return {
    project: fixtureId(130),
    canvas: fixtureId(131),
    poster: fixtureId(132),
    second: fixtureId(133),
    third: fixtureId(134),
  };
}

const BATCH_ASSETS = ["asset-one", "asset-two", "asset-three"];

/** One answer of a batch, as the node holding it records it. */
function batchSlot(index: number, primary: boolean): ResultSlot {
  return {
    id: index === 0 ? "result" : `result-${index + 1}`,
    status: "succeeded",
    assetId: BATCH_ASSETS[index],
    isPrimary: primary,
  };
}

/**
 * A document as a generation that asked for three answers leaves it: the node
 * that asked shows the first and lists the cards the other two went onto, each
 * card holding its own copy of the answer it was made for.
 */
export function buildBatchMokaFile(): MokaFile {
  const ids = batchNodeIds();

  const poster: WorkflowNode = {
    id: ids.poster,
    kind: "image",
    title: "Poster",
    bounds: { x: 0, y: 0, width: 280, height: 220 },
    zIndex: 0,
    ports: derivePorts("image"),
    data: {
      assetId: BATCH_ASSETS[0],
      resultSlots: [
        batchSlot(0, true),
        batchSlot(1, false),
        batchSlot(2, false),
      ],
      resultNodeIds: [ids.second, ids.third],
    },
    createdAt: T0,
    updatedAt: T1,
  };

  const card = (id: string, index: number): WorkflowNode => ({
    id,
    kind: "image",
    title: `Poster ${index + 1}`,
    bounds: { x: 320 * index, y: 0, width: 280, height: 220 },
    zIndex: index,
    ports: derivePorts("image"),
    data: {
      assetId: BATCH_ASSETS[index],
      resultSlots: [{ ...batchSlot(index, true), id: "result" }],
    },
    createdAt: T0,
    updatedAt: T1,
  });

  const images: ResourceEntry[] = BATCH_ASSETS.map((assetId, index) => ({
    id: assetId,
    name: `poster-${index + 1}.png`,
    path: `assets/images/poster-${index + 1}.png`,
    createdAt: T1,
    updatedAt: T1,
    provenance: {
      runId: "run-batch",
      operationNodeId: ids.poster,
      createdAt: T1,
    },
  }));

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: ids.project,
      name: "Batch Fixture",
      revision: 1,
      createdAt: T0,
      updatedAt: T1,
    },
    resources: { images, music: [], voice: [], texts: [], videos: [] },
    canvas: [
      {
        id: ids.canvas,
        name: "Canvas 1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [poster, card(ids.second, 1), card(ids.third, 2)],
        edges: [],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
    ],
  };
}

/** A v2 document whose generative nodes carry specs, for 05/06 to reuse. */
export function buildGenerationMokaFile(): MokaFile {
  const ids = generationNodeIds();
  const textId = ids.text;
  const imageId = ids.image;
  const canvasId = ids.canvas;

  const textNode: WorkflowNode = {
    id: textId,
    kind: "text",
    title: "Brief",
    bounds: { x: 0, y: 0, width: 280, height: 200 },
    zIndex: 0,
    ports: derivePorts("text"),
    data: {
      content: "",
      generation: {
        capability: "text",
        mode: "generate",
        model: "",
        prompt: "Write a logline about a lantern over a lake.",
        inputMode: "upstream",
        params: { temperature: 0.7 },
        referenceNodeIds: [],
        updatedAt: T0,
      },
    },
    createdAt: T0,
    updatedAt: T0,
  };

  const imageNode: WorkflowNode = {
    id: imageId,
    kind: "image",
    title: "Poster",
    bounds: { x: 320, y: 0, width: 280, height: 220 },
    zIndex: 1,
    ports: derivePorts("image"),
    data: {
      generation: {
        capability: "image",
        mode: "generate",
        model: "demo::painter",
        prompt: `Paint @[node:${textId}] as a poster.`,
        inputMode: "mentions",
        params: { size: "1:1", count: 2 },
        referenceNodeIds: [textId],
        updatedAt: T1,
      },
    },
    createdAt: T0,
    updatedAt: T1,
  };

  const edge: WorkflowEdge = {
    id: ids.edge,
    source: { nodeId: textId, portId: "out" },
    target: { nodeId: imageId, portId: "prompt" },
    createdAt: T0,
  };

  return {
    version: MOKA_FILE_VERSION,
    metadata: {
      id: ids.project,
      name: "Generation Fixture",
      revision: 1,
      createdAt: T0,
      updatedAt: T1,
    },
    resources: { images: [], music: [], voice: [], texts: [], videos: [] },
    canvas: [
      {
        id: canvasId,
        name: "Canvas 1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [textNode, imageNode],
        edges: [edge],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
    ],
  };
}
