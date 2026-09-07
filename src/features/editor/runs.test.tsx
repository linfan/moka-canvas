// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import App from "../../App";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../shared/domain/fixtures";
import type { RunRecord, RunStatus } from "../../shared/domain";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";
import { useRunStore } from "./stores/runStore";

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
  capabilities: {
    mode: "web",
    executors: ["deterministic"],
    assetCategories: [],
  },
};

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    projectId: ids.project,
    canvasId: ids.canvasMain,
    requestedNodeIds: [ids.operation],
    status: "queued",
    executorKey: "deterministic",
    graphHash: "abc123",
    parameters: {},
    steps: [
      { nodeId: ids.text, status: "queued" },
      { nodeId: ids.operation, status: "queued" },
    ],
    cancelRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function withStepStatus(run: RunRecord, status: RunStatus): RunRecord {
  return {
    ...run,
    steps: run.steps.map((step) => ({ ...step, status })),
  };
}

interface MockApi {
  runs: RunRecord[];
  startResponse: () => { body: unknown; status: number };
  calls: { url: string; method: string; body?: unknown }[];
}

const api: MockApi = {
  runs: [],
  startResponse: () => ({ body: makeRun(), status: 201 }),
  calls: [],
};

function route(url: string, method: string, body: unknown): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  api.calls.push({ url, method, body });
  if (url === "/api/v1/config") return json(CONFIG);
  if (url === "/api/health") return json({ status: "ok" });
  if (url === "/api/v1/recent-projects") return json([]);
  if (url === "/api/v1/projects/open") {
    return json({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
  }
  if (url === "/api/v1/projects/current") {
    return json({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
  }
  if (url === "/api/v1/projects/current/commands") {
    return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
  }
  if (url === "/api/v1/projects/current/runs" && method === "GET") {
    return json(api.runs);
  }
  if (url === "/api/v1/projects/current/runs" && method === "POST") {
    const { body: payload, status } = api.startResponse();
    return json(payload, status);
  }
  const cancelMatch = url.match(/\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const run = api.runs.find((entry) => entry.id === cancelMatch[1]);
    return run ? json({ ...run, cancelRequested: true }) : json({}, 404);
  }
  const retryMatch = url.match(/\/runs\/([^/]+)\/retry$/);
  if (retryMatch && method === "POST") {
    const run = api.runs.find((entry) => entry.id === retryMatch[1]);
    if (!run) return json({}, 404);
    return json(
      makeRun({ id: "run-2", retryOfRunId: run.id, status: "queued" }),
      201,
    );
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

function selectOperationNode() {
  act(() => {
    useEditorStore.getState().setSelection({
      nodeIds: [ids.operation],
      edgeIds: [],
    });
  });
}

async function openEditor() {
  render(<App />);
  // No recents: open through the store, then flip into the editor phase.
  await act(async () => {
    await useProjectStore.getState().open("/tmp/golden");
    useAppStore.getState().setPhase("editing");
  });
  await screen.findByRole("button", { name: "Canvas 1" });
}

beforeEach(() => {
  api.runs = [];
  api.startResponse = () => ({ body: makeRun(), status: 201 });
  api.calls = [];
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
  useAppStore.setState({
    phase: "booting",
    config: null,
    bootError: null,
    toasts: [],
  });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    inputPick: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runStore", () => {
  it("loads run history and selects the latest run", async () => {
    api.runs = [makeRun({ status: "succeeded" })];
    await useRunStore.getState().load();
    const state = useRunStore.getState();
    expect(state.runs).toHaveLength(1);
    expect(state.selectedRunId).toBe("run-1");
  });

  it("starts a run and folds the created record in", async () => {
    api.startResponse = () => ({
      body: makeRun({ status: "succeeded" }),
      status: 201,
    });
    const run = await useRunStore
      .getState()
      .start(ids.canvasMain, [ids.operation]);
    expect(run.status).toBe("succeeded");
    expect(useRunStore.getState().runs[0]?.id).toBe("run-1");
    const startCall = api.calls.find(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(startCall?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.operation],
    });
  });

  it("captures validation issues from a rejected start", async () => {
    api.startResponse = () => ({
      status: 422,
      body: {
        code: "RUN_VALIDATION_FAILED",
        message: "The run is not valid",
        status: 422,
        details: {
          issues: [
            {
              code: "PORT_UNRESOLVED",
              message: "Required input text has no value",
              nodeId: ids.operation,
              portId: "text",
            },
          ],
        },
      },
    });
    await expect(
      useRunStore.getState().start(ids.canvasMain, [ids.operation]),
    ).rejects.toThrow("The run is not valid");
    expect(useRunStore.getState().lastIssues).toHaveLength(1);
    expect(useRunStore.getState().lastIssues[0]?.code).toBe("PORT_UNRESOLVED");
  });

  it("adopts server state when a run reaches a terminal status", async () => {
    useProjectStore.getState().hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    expect(useRunStore.getState().runs[0]?.status).toBe("queued");

    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    await act(async () => {
      await useRunStore.getState().load();
    });
    expect(useRunStore.getState().runs[0]?.status).toBe("succeeded");
    // Terminal transition reloaded the project and announced completion.
    expect(
      api.calls.some(
        (call) =>
          call.url === "/api/v1/projects/current" && call.method === "GET",
      ),
    ).toBe(true);
    expect(
      useAppStore.getState().toasts.some((toast) => toast.kind === "success"),
    ).toBe(true);
  });

  it("defers the post-run resync while local edits are pending", async () => {
    const project = useProjectStore.getState();
    project.hydrate({
      root: "/tmp/golden",
      moka: buildGoldenMokaFile(),
      selfCheck: { ok: true, issues: [] },
    });
    // Park a local edit in the pending queue without flushing.
    useProjectStore.setState({
      pending: [{ type: "renameCanvas", canvasId: ids.canvasMain, name: "X" }],
    });
    api.startResponse = () => ({ body: makeRun(), status: 201 });
    await useRunStore.getState().start(ids.canvasMain, [ids.operation]);
    api.calls = [];
    api.runs = [withStepStatus(makeRun({ status: "succeeded" }), "succeeded")];
    await act(async () => {
      await useRunStore.getState().load();
    });
    expect(
      api.calls.some((call) => call.url === "/api/v1/projects/current"),
    ).toBe(false);

    // Once the queue drains, the deferred resync fires.
    act(() => {
      useProjectStore.setState({ pending: [] });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      api.calls.some((call) => call.url === "/api/v1/projects/current"),
    ).toBe(true);
  });

  it("cancels an active run and retries a failed one", async () => {
    api.runs = [makeRun({ status: "running" })];
    await useRunStore.getState().load();
    await useRunStore.getState().cancel("run-1");
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/cancel")),
    ).toBe(true);
    expect(useRunStore.getState().runs[0]?.cancelRequested).toBe(true);

    api.runs = [makeRun({ status: "failed", error: "boom" })];
    await useRunStore.getState().load();
    const retried = await useRunStore.getState().retry("run-1");
    expect(retried.retryOfRunId).toBe("run-1");
    expect(useRunStore.getState().runs[0]?.id).toBe("run-2");
    expect(useRunStore.getState().selectedRunId).toBe("run-2");
  });
});

describe("run UI", () => {
  it("runs the selected operation node from the topbar", async () => {
    await openEditor();
    const button = screen.getByRole("button", { name: /run/i });
    expect(button).toHaveProperty("disabled", true);

    selectOperationNode();
    await screen.findByRole("button", { name: "▶ Run" });
    api.startResponse = () => ({
      body: withStepStatus(makeRun({ status: "succeeded" }), "succeeded"),
      status: 201,
    });
    fireEvent.click(screen.getByRole("button", { name: "▶ Run" }));

    await act(async () => {
      await Promise.resolve();
    });
    const startCall = api.calls.find(
      (call) => call.url.endsWith("/runs") && call.method === "POST",
    );
    expect(startCall?.body).toEqual({
      canvasId: ids.canvasMain,
      nodeIds: [ids.operation],
    });
  });

  it("shows validation issues in the inspector after a rejected start", async () => {
    await openEditor();
    selectOperationNode();
    api.startResponse = () => ({
      status: 422,
      body: {
        code: "RUN_VALIDATION_FAILED",
        message: "The run is not valid",
        status: 422,
        details: {
          issues: [
            {
              code: "PORT_UNRESOLVED",
              message: "Required input text has no value",
              nodeId: ids.operation,
              portId: "text",
            },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "▶ Run" }));

    const issues = await screen.findByRole("alert");
    expect(issues.textContent).toContain("PORT_UNRESOLVED");
    expect(issues.textContent).toContain("Required input text has no value");
    expect(
      useAppStore.getState().toasts.some((toast) => toast.kind === "error"),
    ).toBe(true);
  });

  it("shows the latest run status with retry for the selected node", async () => {
    api.runs = [
      makeRun({
        status: "failed",
        error: "deterministic failure",
        steps: [
          { nodeId: ids.text, status: "succeeded" },
          { nodeId: ids.operation, status: "failed", error: "boom" },
        ],
      }),
    ];
    await openEditor();
    selectOperationNode();

    const chip = await screen.findByText("Failed");
    expect(chip.className).toContain("run-chip-failed");
    expect(await screen.findByText("boom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      api.calls.some((call) => call.url.endsWith("/runs/run-1/retry")),
    ).toBe(true);
  });
});
