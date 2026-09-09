// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import App from "../../App";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import { MAX_IMAGES_PER_RUN, createNode } from "../../shared/domain";
import type { GenerationSpec, MokaFile, RunRecord } from "../../shared/domain";
import { PROVIDER_EXECUTOR_KEY } from "../../shared/domain";
import type { ProvidersView } from "../../api";
import { GENERATION_UNAVAILABLE, useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";
import { useRunStore } from "./stores/runStore";
import { useProviderStore } from "../settings/providerStore";
import { enterIntent } from "./interactions/keyboard";

const ids = goldenNodeIds();

const CONFIG = {
  productName: "Moka Canvas",
  maxUploadBytes: 104857600,
  allowedMediaTypes: ["image/png"],
  limits: {
    maxNodesPerCanvas: 500,
    maxEdgesPerCanvas: 800,
    maxCanvasesPerProject: 12,
    maxPackageBytes: 536870912,
    maxPackageEntries: 20000,
  },
  capabilities: { mode: "web", assetCategories: [] },
};

/** One channel offering one model per capability, as the server would send it. */
function providers(channels: ProvidersView["channels"]): ProvidersView {
  return {
    version: 1,
    revision: 7,
    channels,
    defaults: { text: null, image: null, audio: null, video: null },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1:1", quality: "auto", background: "auto", count: 1 },
      video: {
        seconds: 8,
        resolution: "1080",
        generateAudio: true,
        watermark: false,
        mode: "auto",
      },
      audio: { voice: "alloy", format: "mp3", speed: 1, instructions: "" },
    },
  };
}

const PAINTER = {
  id: "chan-1",
  name: "Demo",
  baseUrl: "https://demo.test/v1",
  protocol: "openai" as const,
  enabled: true,
  apiKey: { set: true, masked: "sk-…abcd" },
  models: [
    { id: "painter", capability: "image" as const, alias: "", enabled: true },
    { id: "writer", capability: "text" as const, alias: "", enabled: true },
  ],
};

interface MockApi {
  calls: { url: string; method: string; body?: unknown }[];
  executors: string[];
  providers: ProvidersView;
  moka: () => MokaFile;
}

const api: MockApi = {
  calls: [],
  executors: [PROVIDER_EXECUTOR_KEY],
  providers: providers([PAINTER]),
  moka: () => buildGoldenMokaFile(),
};

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: ids.project,
    canvasId: ids.canvasMain,
    requestedNodeIds: [ids.image],
    status: "queued",
    executorKey: PROVIDER_EXECUTOR_KEY,
    graphHash: "abc123",
    parameters: {},
    steps: [{ nodeId: ids.image, status: "queued" }],
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** jsdom has no stream; a run only needs one that can be opened and closed. */
class FakeEventSource {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener() {}
  close() {}
}

function route(url: string, method: string, body: unknown): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  api.calls.push({ url, method, body });
  if (url === "/api/v1/config") {
    return json({
      ...CONFIG,
      capabilities: { ...CONFIG.capabilities, executors: api.executors },
    });
  }
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/providers") return json(api.providers);
  if (url === "/api/v1/recent-projects") return json([]);
  if (
    url === "/api/v1/projects/open" ||
    url === "/api/v1/projects/current" ||
    url === "/api/v1/projects/current/commands"
  ) {
    if (url.endsWith("/commands") && method === "GET") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    if (url.endsWith("/commands")) {
      return json({ revision: 5, updatedAt: "2026-01-01T00:00:03.000Z" });
    }
    return json({
      root: "/tmp/golden",
      moka: api.moka(),
      selfCheck: { ok: true, issues: [] },
    });
  }
  if (url === "/api/v1/projects/current/runs" && method === "GET") {
    return json([]);
  }
  if (url === "/api/v1/projects/current/runs" && method === "POST") {
    return json(makeRun(), 201);
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

/** Lets a frame and the promises behind it finish. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function openEditor() {
  render(<App />);
  await act(async () => {
    await useProjectStore.getState().open("/tmp/golden");
    useAppStore.getState().setPhase("editing");
  });
  await screen.findByRole("button", { name: "Canvas 1" });
  await settle();
}

function selectNode(nodeId: string) {
  act(() => {
    useEditorStore.getState().setSelection({ nodeIds: [nodeId], edgeIds: [] });
  });
}

function panel() {
  return screen.getByTestId("prompt-panel");
}

/** The generation spec the document holds for a node, as it stands now. */
function specOf(nodeId: string): GenerationSpec | undefined {
  const moka = useProjectStore.getState().moka;
  const canvas = moka?.canvas.find((entry) => entry.id === ids.canvasMain);
  const node = canvas?.nodes.find((entry) => entry.id === nodeId);
  return (node?.data as { generation?: GenerationSpec } | undefined)
    ?.generation;
}

beforeEach(() => {
  api.calls = [];
  api.executors = [PROVIDER_EXECUTOR_KEY];
  api.providers = providers([PAINTER]);
  api.moka = () => buildGoldenMokaFile();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        route(
          String(input),
          init?.method ?? "GET",
          init?.body ? JSON.parse(String(init.body)) : undefined,
        ),
      ),
    ),
  );
  useRunStore.getState().reset();
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useProviderStore.getState().reset();
  useAppStore.setState({
    phase: "booting",
    config: null,
    bootError: null,
    toasts: [],
  });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    promptPanel: null,
    promptPanelOnSelect: true,
    contextMenu: null,
    renaming: null,
    textEditing: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what Enter asks for", () => {
  it("edits a text node that already has words in it", () => {
    const node = createNode("text", { x: 0, y: 0 });
    node.data = { content: "A lantern floats." };
    expect(enterIntent(node)).toBe("edit");
  });

  it("asks a text node that has nothing yet", () => {
    const node = createNode("text", { x: 0, y: 0 });
    node.data = { content: "   " };
    expect(enterIntent(node)).toBe("ask");
  });

  it("asks a node a provider can answer", () => {
    expect(enterIntent(createNode("image", { x: 0, y: 0 }))).toBe("ask");
    expect(enterIntent(createNode("audio", { x: 0, y: 0 }))).toBe("ask");
    expect(enterIntent(createNode("video", { x: 0, y: 0 }))).toBe("ask");
  });

  it("renames what no provider could make, and a selection gone stale", () => {
    expect(enterIntent(createNode("operation", { x: 0, y: 0 }))).toBe("rename");
    expect(enterIntent(createNode("group", { x: 0, y: 0 }))).toBe("rename");
    expect(enterIntent(createNode("export", { x: 0, y: 0 }))).toBe("rename");
    expect(enterIntent(undefined)).toBe("rename");
  });
});

describe("the generation panel", () => {
  it("comes up under a selected node, and stops when told to", async () => {
    await openEditor();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();

    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();

    // Turning the behaviour off lets a selection be just a selection.
    act(() => {
      useEditorStore.getState().closePromptPanel();
      useEditorStore.getState().togglePromptPanelOnSelect();
    });
    selectNode(ids.text);
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
  });

  it("does not come up for a node nothing can generate", async () => {
    await openEditor();
    selectNode(ids.operation);
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
  });

  it("opens from Enter with the keyboard in the prompt", async () => {
    await openEditor();
    act(() => {
      useEditorStore.getState().closePromptPanel();
      useEditorStore.getState().togglePromptPanelOnSelect();
    });
    selectNode(ids.image);
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();

    fireEvent.keyDown(window, { key: "Enter" });
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    expect(document.activeElement).toBe(prompt);
  });

  it("opens from the right-click menu, and is not offered where it cannot run", async () => {
    await openEditor();
    act(() => {
      useEditorStore.getState().closePromptPanel();
      useEditorStore.getState().openContextMenu({
        x: 40,
        y: 40,
        target: { kind: "node", nodeId: ids.image },
      });
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Generate…" }));
    await settle();
    expect(panel()).toBeTruthy();
    expect(useEditorStore.getState().contextMenu).toBeNull();

    act(() => {
      useEditorStore.getState().closePromptPanel();
      useEditorStore.getState().openContextMenu({
        x: 40,
        y: 40,
        target: { kind: "node", nodeId: ids.operation },
      });
    });
    expect(screen.queryByRole("menuitem", { name: "Generate…" })).toBeNull();
  });

  it("offers only the modes its kind of node can be asked in", async () => {
    await openEditor();
    // An image holding something starts on changing it rather than starting over.
    selectNode(ids.image);
    await settle();
    const modes = within(panel()).getByRole("group", { name: "Mode" });
    expect(
      within(modes)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Generate", "Edit"]);
    expect(
      within(modes)
        .getByRole("button", { name: "Edit" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    selectNode(ids.text);
    await settle();
    const textModes = within(panel()).getByRole("group", { name: "Mode" });
    expect(
      within(textModes)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Generate", "Question", "Extend"]);
  });

  it("writes the prompt when the field loses focus", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    expect(specOf(ids.image)).toBeUndefined();

    fireEvent.change(prompt, { target: { value: "A poster of the lake" } });
    fireEvent.blur(prompt);
    await settle();
    const spec = specOf(ids.image);
    expect(spec?.prompt).toBe("A poster of the lake");
    // The mode on show is the mode written, not the spec's own default.
    expect(spec?.mode).toBe("edit");
  });

  it("writes nothing when it came up on its own and nothing was typed", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    fireEvent.focus(prompt);
    fireEvent.blur(prompt);
    await settle();
    expect(specOf(ids.image)).toBeUndefined();
  });

  it("points the node at the model chosen for it", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const picker = within(panel()).getByRole("combobox", { name: "Image" });
    expect(picker).toHaveProperty("value", "");

    fireEvent.change(picker, { target: { value: "chan-1::painter" } });
    await settle();
    expect(specOf(ids.image)?.model).toBe("chan-1::painter");
  });

  it("offers the way to configure models when there are none", async () => {
    api.providers = providers([]);
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(
      within(panel()).queryByRole("combobox", { name: "Image" }),
    ).toBeNull();

    fireEvent.click(
      within(panel()).getByRole("button", { name: "Configure models" }),
    );
    await settle();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
  });

  it("saves what was typed before asking for the run", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    const prompt = within(panel()).getByRole("textbox", {
      name: "Prompt for Reference image",
    });
    fireEvent.change(prompt, { target: { value: "A poster of the lake" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Run" }));
    await settle();

    const saved = api.calls.findIndex(
      (call) => call.url.endsWith("/commands") && call.method === "POST",
    );
    const started = api.calls.findIndex(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(saved).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(saved);
    expect(api.calls[started]?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.image],
    });
    expect(specOf(ids.image)?.prompt).toBe("A poster of the lake");
  });

  it("says on the button when this deployment cannot generate", async () => {
    api.executors = ["deterministic"];
    await openEditor();
    selectNode(ids.image);
    await settle();
    const run = within(panel()).getByRole("button", { name: "Run" });
    expect(run).toHaveProperty("disabled", true);
    expect(run).toHaveProperty("title", GENERATION_UNAVAILABLE);
  });

  it("goes away on Escape, and stays away while that node is selected", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
    expect(useEditorStore.getState().selection.nodeIds).toEqual([ids.image]);

    // Selecting it again is a new question, so the panel comes back.
    selectNode(ids.text);
    await settle();
    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();
  });

  it("goes away when the selection lets go of its node", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    expect(panel()).toBeTruthy();

    act(() => {
      useEditorStore.getState().clearSelection();
    });
    await settle();
    expect(screen.queryByTestId("prompt-panel")).toBeNull();
  });
});

/** The bounds the document holds for a node, as they stand now. */
function boundsOf(nodeId: string) {
  const moka = useProjectStore.getState().moka;
  const canvas = moka?.canvas.find((entry) => entry.id === ids.canvasMain);
  return canvas?.nodes.find((entry) => entry.id === nodeId)?.bounds;
}

/**
 * A document with one empty node of each kind that has a shape or a yes-and-no
 * to offer, built once so their ids stay the same across every read of it.
 */
function withEmptyNodes() {
  const moka = buildGoldenMokaFile();
  const image = createNode("image", { x: 800, y: 0 });
  const video = createNode("video", { x: 1200, y: 0 });
  const audio = createNode("audio", { x: 1600, y: 0 });
  moka.canvas[0].nodes.push(image, video, audio);
  api.moka = () => moka;
  return { image: image.id, video: video.id, audio: audio.id };
}

function openParams() {
  fireEvent.click(within(panel()).getByRole("button", { name: "Parameters" }));
}

describe("the parameters a node carries", () => {
  it("offers the ones its kind of node has, and no others", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    for (const name of ["Shape", "Quality", "Background"]) {
      expect(within(panel()).queryByRole("combobox", { name })).toBeTruthy();
    }
    expect(
      within(panel()).queryByRole("spinbutton", { name: "Images" }),
    ).toBeTruthy();
    expect(
      within(panel()).queryByRole("spinbutton", { name: "Temperature" }),
    ).toBeNull();

    // The disclosure belongs to the panel rather than to one node, so a
    // selection that moves on finds it still open.
    selectNode(ids.text);
    await settle();
    for (const name of ["Temperature", "Max tokens"]) {
      expect(within(panel()).queryByRole("spinbutton", { name })).toBeTruthy();
    }
    expect(
      within(panel()).queryByRole("combobox", { name: "Reasoning effort" }),
    ).toBeTruthy();
    expect(
      within(panel()).queryByRole("textbox", { name: "System prompt" }),
    ).toBeTruthy();
    expect(
      within(panel()).queryByRole("combobox", { name: "Shape" }),
    ).toBeNull();
  });

  it("says on the choice that leaves a parameter out what the default is", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    const shape = within(panel()).getByRole("combobox", { name: "Shape" });
    expect(shape).toHaveProperty("value", "");
    expect(
      Array.from((shape as HTMLSelectElement).options).map(
        (option) => option.textContent,
      ),
    ).toEqual(["Default · 1:1", "1:1", "3:4", "4:3", "16:9", "9:16", "21:9"]);
  });

  it("writes the parameter and takes it back out again", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    const shape = within(panel()).getByRole("combobox", { name: "Shape" });

    fireEvent.change(shape, { target: { value: "16:9" } });
    await settle();
    expect(specOf(ids.image)?.params.size).toBe("16:9");

    fireEvent.change(shape, { target: { value: "" } });
    await settle();
    expect(specOf(ids.image)?.params).toEqual({});
  });

  it("gives an empty node the shape it was asked for", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.image);
    await settle();
    openParams();
    await settle();
    expect(boundsOf(empty.image)).toEqual({
      x: 800,
      y: 0,
      width: 280,
      height: 200,
    });

    fireEvent.change(within(panel()).getByRole("combobox", { name: "Shape" }), {
      target: { value: "16:9" },
    });
    await settle();
    expect(boundsOf(empty.image)).toEqual({
      x: 800,
      y: 21,
      width: 280,
      height: 158,
    });

    // Taking the parameter back out leaves the node the size the shape gave it:
    // the size is the user's to change by hand, and the ask no longer names one.
    fireEvent.change(within(panel()).getByRole("combobox", { name: "Shape" }), {
      target: { value: "" },
    });
    await settle();
    expect(boundsOf(empty.image)?.height).toBe(158);
  });

  it("leaves the size of a node that already holds something alone", async () => {
    await openEditor();
    selectNode(ids.image);
    await settle();
    openParams();
    await settle();
    fireEvent.change(within(panel()).getByRole("combobox", { name: "Shape" }), {
      target: { value: "21:9" },
    });
    await settle();
    expect(boundsOf(ids.image)).toEqual({
      x: -320,
      y: 160,
      width: 280,
      height: 220,
    });
  });

  it("shows on a yes-and-no the answer that will be sent", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.video);
    await settle();
    openParams();
    await settle();
    const audio = within(panel()).getByRole("checkbox", {
      name: "Generate audio",
    });
    const watermark = within(panel()).getByRole("checkbox", {
      name: "Watermark",
    });
    // Neither is the node's own yet: each shows what the defaults would send.
    expect(specOf(empty.video)).toBeUndefined();
    expect(audio).toHaveProperty("checked", true);
    expect(watermark).toHaveProperty("checked", false);

    fireEvent.click(audio);
    fireEvent.click(watermark);
    await settle();
    expect(specOf(empty.video)?.params).toEqual({
      generateAudio: false,
      watermark: true,
    });
  });

  it("files an audio result where the node says rather than by default", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.audio);
    await settle();
    openParams();
    await settle();
    const music = within(panel()).getByRole("checkbox", {
      name: "File under Music",
    });
    expect(music).toHaveProperty("checked", false);

    fireEvent.click(music);
    await settle();
    expect(specOf(empty.audio)?.params.music).toBe(true);
  });

  it("lets one text node frame its own answer", async () => {
    await openEditor();
    selectNode(ids.text);
    await settle();
    openParams();
    await settle();
    const system = within(panel()).getByRole("textbox", {
      name: "System prompt",
    });
    fireEvent.change(system, { target: { value: "Answer in one sentence." } });
    // A keystroke is not a choice, so nothing is written until the field is left.
    expect(specOf(ids.text)?.params.instructions).toBeUndefined();
    fireEvent.blur(system);
    await settle();
    expect(specOf(ids.text)?.params.instructions).toBe(
      "Answer in one sentence.",
    );

    fireEvent.change(
      within(panel()).getByRole("combobox", {
        name: "Reasoning effort",
      }),
      { target: { value: "high" } },
    );
    await settle();
    expect(specOf(ids.text)?.params.reasoningEffort).toBe("high");
  });

  it("holds a number to the bounds an ask is made within", async () => {
    const empty = withEmptyNodes();
    await openEditor();
    selectNode(empty.image);
    await settle();
    openParams();
    await settle();
    const images = within(panel()).getByRole("spinbutton", { name: "Images" });

    fireEvent.change(images, { target: { value: "99" } });
    // Nothing is written while the field still has the keyboard.
    expect(specOf(empty.image)).toBeUndefined();
    fireEvent.blur(images);
    await settle();
    expect(specOf(empty.image)?.params.count).toBe(MAX_IMAGES_PER_RUN);
    expect(images).toHaveProperty("value", `${MAX_IMAGES_PER_RUN}`);

    // Emptying it hands the choice back to the default.
    fireEvent.change(images, { target: { value: "" } });
    fireEvent.blur(images);
    await settle();
    expect(specOf(empty.image)?.params.count).toBeUndefined();
    expect(images).toHaveProperty("value", "");
  });
});
