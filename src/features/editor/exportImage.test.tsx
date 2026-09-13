// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../../App";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
import { registerController } from "./canvas/canvasControl";
import type { LeaferEditorController } from "./canvas/controller";
import { useAppStore } from "./stores/appStore";
import { useEditorStore } from "./stores/editorStore";
import { useHistoryStore } from "./stores/historyStore";
import { useProjectStore } from "./stores/projectStore";

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
  capabilities: { mode: "web", executors: ["noop"], assetCategories: [] },
};

const RECENTS = [
  {
    id: "recent-1",
    name: "Golden Fixture",
    path: "/tmp/golden",
    lastOpened: "2026-01-01T00:00:00.000Z",
  },
];

const fetchMock = vi.fn<typeof fetch>();

async function openGolden() {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/v1/config") return Promise.resolve(json(CONFIG));
    if (url === "/api/health") return Promise.resolve(json({ status: "ok" }));
    if (url === "/api/v1/recent-projects")
      return Promise.resolve(json(RECENTS));
    if (url === "/api/v1/projects/open") {
      return Promise.resolve(
        json({
          root: "/tmp/golden",
          moka: buildGoldenMokaFile(),
          selfCheck: { ok: true, issues: [] },
        }),
      );
    }
    if (url === "/api/v1/projects/current/runs")
      return Promise.resolve(json([]));
    if (url === "/api/v1/projects/current/commands") {
      return Promise.resolve(
        json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" }),
      );
    }
    return Promise.resolve(
      json({ code: "NOT_FOUND", message: url, status: 404 }, 404),
    );
  });
  render(<App />);
  const recent = await screen.findByText("Golden Fixture");
  fireEvent.click(recent);
  await screen.findByTestId("canvas-tab-Canvas 1");
}

/**
 * Stands in for the mounted canvas, which jsdom cannot build. Only the
 * snapshot the export reaches for is real; the rest answers harmlessly.
 */
function stubCanvas(snapshot: () => Promise<Blob>) {
  registerController({
    renderSnapshot: snapshot,
  } as unknown as LeaferEditorController);
}

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function stubObjectUrls() {
  const create = vi.fn(() => "blob:snapshot");
  const revoke = vi.fn();
  URL.createObjectURL = create as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
  return { create, revoke };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    nodeMenu: null,
    contextMenu: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  registerController(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("exporting the canvas as an image", () => {
  it("hands the snapshot to the browser under the canvas's name", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const snapshot = vi.fn(async () => blob);
    await openGolden();
    stubCanvas(snapshot);
    const urls = stubObjectUrls();
    let saved: { name: string; href: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved = { name: this.download, href: this.getAttribute("href") ?? "" };
    });

    fireEvent.click(screen.getByRole("button", { name: "Export image" }));
    await waitFor(() => expect(urls.create).toHaveBeenCalledWith(blob));

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(saved!.name).toBe("Canvas 1.png");
    expect(saved!.href).toBe("blob:snapshot");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(useEditorStore.getState().announcement).toBe(
      "Canvas image exported",
    );
    await waitFor(() =>
      expect(urls.revoke).toHaveBeenCalledWith("blob:snapshot"),
    );
  });

  it("shows why when the canvas cannot draw the picture", async () => {
    const snapshot = vi.fn(async () => {
      throw new Error("There is nothing to export yet");
    });
    await openGolden();
    stubCanvas(snapshot);
    const urls = stubObjectUrls();

    fireEvent.click(screen.getByRole("button", { name: "Export image" }));
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        { kind: "error", message: "There is nothing to export yet" },
      ]),
    );
    expect(urls.create).not.toHaveBeenCalled();
    expect(useEditorStore.getState().announcement).toBe("");
  });

  it("says the canvas is not ready while none is mounted", async () => {
    await openGolden();
    const urls = stubObjectUrls();

    fireEvent.click(screen.getByRole("button", { name: "Export image" }));
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        { kind: "error", message: "The canvas is not ready" },
      ]),
    );
    expect(urls.create).not.toHaveBeenCalled();
  });
});
