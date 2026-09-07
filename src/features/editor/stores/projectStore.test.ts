import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoldenMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import { HISTORY_LIMIT, type MokaFile } from "../../../shared/domain";
import { execute, historyBoundary, redo, undo } from "../commands/execute";
import { useAppStore } from "./appStore";
import { useHistoryStore, isBoundary } from "./historyStore";
import { useProjectStore } from "./projectStore";

function hydrate(moka?: MokaFile) {
  const document = moka ?? buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    root: "/tmp/moka-test",
    moka: document,
    selfCheck: { ok: true, issues: [] },
  });
  return document;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("command pipeline", () => {
  it("applies commands optimistically and records an undoable entry", () => {
    const moka = hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    const inverse = execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);

    const state = useProjectStore.getState();
    expect(state.moka?.canvas[0].name).toBe("Storyboard");
    expect(state.pending).toHaveLength(1);
    expect(inverse).toEqual([
      { type: "renameCanvas", canvasId, name: moka.canvas[0].name },
    ]);
    const { undoStack } = useHistoryStore.getState();
    expect(undoStack).toHaveLength(1);
    expect(isBoundary(undoStack[0])).toBe(false);
  });

  it("flushes pending commands with the current revision", async () => {
    const moka = hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockResolvedValue(
      jsonResponse(200, { revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    await useProjectStore.getState().flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/projects/current/commands");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedRevision: moka.metadata.revision,
      commands: [{ type: "renameCanvas", canvasId, name: "Storyboard" }],
    });

    const state = useProjectStore.getState();
    expect(state.pending).toHaveLength(0);
    expect(state.saveStatus).toBe("saved");
    expect(state.moka?.metadata.revision).toBe(4);
  });

  it("shares one in-flight flush so concurrent saves cannot double-send", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    let resolveSave: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveSave = resolve;
        }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    // The autosave debounce and an explicit save race here; both callers
    // must resolve from a single request, never a duplicate second POST.
    const first = useProjectStore.getState().flush();
    const second = useProjectStore.getState().flush();
    resolveSave(
      jsonResponse(200, { revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
    );
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().saveStatus).toBe("saved");
    expect(useProjectStore.getState().pending).toHaveLength(0);
  });

  it("freezes autosave on a revision conflict and rejects further edits", async () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        code: "REVISION_CONFLICT",
        message: "The project changed on disk",
        status: 409,
      }),
    );

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    await useProjectStore.getState().flush();

    expect(useProjectStore.getState().saveStatus).toBe("conflicted");

    const result = execute("Rename again", [
      { type: "renameCanvas", canvasId, name: "Nope" },
    ]);
    expect(result).toBeNull();
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe("Storyboard");
    expect(useAppStore.getState().toasts).toHaveLength(1);
  });

  it("undo and redo re-apply inverse and forward commands", () => {
    const moka = hydrate();
    const canvasId = goldenNodeIds().canvasMain;
    const original = moka.canvas[0].name;

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    expect(undo()).toBe(true);
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe(original);
    expect(redo()).toBe(true);
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe("Storyboard");

    // Undo and redo changes are persisted like any other edit.
    expect(useProjectStore.getState().pending).toHaveLength(3);
  });

  it("refuses to undo across a boundary", () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;

    execute("Rename canvas", [
      { type: "renameCanvas", canvasId, name: "Storyboard" },
    ]);
    historyBoundary("Switch canvas");

    expect(undo()).toBe(false);
    expect(useProjectStore.getState().moka?.canvas[0].name).toBe("Storyboard");
    expect(redo()).toBe(false);
  });

  it("caps history and keeps boundary markers while evicting old entries", () => {
    hydrate();
    const canvasId = goldenNodeIds().canvasMain;

    historyBoundary("Open project");
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      execute(`Rename ${i}`, [
        { type: "renameCanvas", canvasId, name: `Canvas ${i}` },
      ]);
    }

    const { undoStack } = useHistoryStore.getState();
    expect(undoStack.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(undoStack.some(isBoundary)).toBe(true);
  });
});

describe("asset registry integration", () => {
  const entry = {
    id: "asset-1",
    name: "clip.png",
    path: "assets/images/clip.png",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("folds uploads and removals into the registry with the new revision", () => {
    hydrate();

    useProjectStore
      .getState()
      .integrateAssetEntry(entry, { revision: 4, updatedAt: entry.updatedAt });
    let state = useProjectStore.getState();
    expect(state.moka?.resources.images.map((item) => item.id)).toContain(
      "asset-1",
    );
    expect(state.moka?.metadata.revision).toBe(4);

    useProjectStore
      .getState()
      .removeAssetEntry("asset-1", { revision: 5, updatedAt: entry.updatedAt });
    state = useProjectStore.getState();
    expect(state.moka?.resources.images.map((item) => item.id)).not.toContain(
      "asset-1",
    );
    expect(state.moka?.metadata.revision).toBe(5);
  });
});
