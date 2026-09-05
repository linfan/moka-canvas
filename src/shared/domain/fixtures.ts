import { MOKA_FILE_VERSION } from "./constants";
import type { MokaFile, WorkflowEdge, WorkflowNode } from "./types";

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
    ports: [
      {
        id: "out",
        direction: "output",
        dataTypes: ["text"],
        required: false,
        cardinality: "one",
        label: "Text",
      },
    ],
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
    ports: [
      {
        id: "out",
        direction: "output",
        dataTypes: ["image"],
        required: false,
        cardinality: "one",
        label: "Image",
      },
    ],
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
    ports: [
      {
        id: "text",
        direction: "input",
        dataTypes: ["text"],
        required: true,
        cardinality: "many",
        label: "Text",
      },
      {
        id: "images",
        direction: "input",
        dataTypes: ["image"],
        required: false,
        cardinality: "many",
        label: "Images",
      },
      {
        id: "out",
        direction: "output",
        dataTypes: ["text", "image", "audio", "video"],
        required: false,
        cardinality: "many",
        label: "Result",
      },
    ],
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
    ports: [
      {
        id: "video",
        direction: "input",
        dataTypes: ["video"],
        required: false,
        cardinality: "one",
        label: "Video",
      },
      {
        id: "audio",
        direction: "input",
        dataTypes: ["audio"],
        required: false,
        cardinality: "one",
        label: "Audio",
      },
      {
        id: "out",
        direction: "output",
        dataTypes: ["artifact"],
        required: false,
        cardinality: "one",
        label: "Artifact",
      },
    ],
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
        schemaVersion: 1,
        viewport: { x: 120.5, y: -40.25, zoom: 1.5 },
        nodes: [textNode, imageNode, operationNode, exportNode],
        edges: [edgeTextOp, edgeOpExport],
        groups: [],
        settings: { background: "dots", showMinimap: true, snapToGrid: true },
      },
      {
        id: ids.canvasSecond,
        name: "Canvas 2",
        schemaVersion: 1,
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
