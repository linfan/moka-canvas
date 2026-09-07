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
import type { SelfCheckReport } from "../../shared/domain";
import { editTextContent } from "./interactions/actions";
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

interface RouteOptions {
  selfCheck?: SelfCheckReport;
  /** When set, the first export fails with this problem body. */
  exportFailure?: { code: string; message: string; status: number };
}

function route(options: RouteOptions = {}) {
  let exportAttempts = 0;
  return (url: string, init?: RequestInit): Response => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url === "/api/v1/config") return json(CONFIG);
    if (url === "/api/health") return json({ status: "ok" });
    if (url === "/api/v1/recent-projects") return json(RECENTS);
    if (url === "/api/v1/projects/open") {
      return json({
        root: "/tmp/golden",
        moka: buildGoldenMokaFile(),
        selfCheck: options.selfCheck ?? { ok: true, issues: [] },
      });
    }
    if (url === "/api/v1/projects/current/runs") return json([]);
    if (url === "/api/v1/projects/current/commands") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    if (url.includes("/content") && init?.method === "PUT") {
      return json(
        {
          entry: {
            id: url.split("/assets/")[1].split("/")[0],
            name: "lake.png",
            path: "assets/images/lake-00000000.png",
            mime: "image/png",
            bytes: 128,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
          revision: 7,
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        200,
      );
    }
    if (url === "/api/v1/projects/current/export" && init?.method === "POST") {
      exportAttempts += 1;
      if (options.exportFailure && exportAttempts === 1) {
        return json(options.exportFailure, options.exportFailure.status);
      }
      const body = JSON.parse(String(init.body ?? "{}")) as {
        allowIncomplete?: boolean;
      };
      return json({
        destination: "/tmp/golden/pack.zip",
        entries: 5,
        bytes: 4096,
        incomplete: body.allowIncomplete === true,
      });
    }
    return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
  };
}

async function openGolden(options: RouteOptions = {}) {
  const handler = route(options);
  fetchMock.mockImplementation((input, init) =>
    Promise.resolve(handler(String(input), init as RequestInit)),
  );
  render(<App />);
  const recent = await screen.findByText("Golden Fixture");
  fireEvent.click(recent);
}

function missingImageCheck(): SelfCheckReport {
  const ids = goldenNodeIds();
  return {
    ok: false,
    issues: [
      {
        assetId: ids.assetImage,
        name: "lake.png",
        expectedPath: "assets/images/lake-00000000.png",
        reason: "missing",
        referencingNodes: [
          {
            canvasId: ids.canvasMain,
            nodeId: ids.image,
            title: "Reference image",
          },
        ],
      },
    ],
  };
}

function exportCalls(): { body: { allowIncomplete?: boolean } }[] {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        String(url) === "/api/v1/projects/current/export" &&
        (init as RequestInit)?.method === "POST",
    )
    .map(([, init]) => ({
      body: JSON.parse(String((init as RequestInit).body ?? "{}")) as {
        allowIncomplete?: boolean;
      },
    }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ revision: 9, updatedAt: "2026-01-02" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    selection: { nodeIds: [], edgeIds: [] },
    inputPick: null,
    assetDeletePrompt: null,
    previewAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("missing-asset recovery", () => {
  it("locating a replacement resolves the issue and opens the project", async () => {
    const ids = goldenNodeIds();
    await openGolden({ selfCheck: missingImageCheck() });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("lake.png");

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));
    const input = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, {
      target: { files: [new File(["x"], "lake.png", { type: "image/png" })] },
    });

    await screen.findByText("All referenced assets are accounted for.");
    const putCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes(`/assets/${ids.assetImage}/content`) &&
        (init as RequestInit)?.method === "PUT",
    );
    expect(putCall).toBeTruthy();
    expect((putCall![1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(useProjectStore.getState().selfCheck?.ok).toBe(true);
    expect(dialog.textContent).toContain("Restored");

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open project" }),
    );
    expect(useAppStore.getState().phase).toBe("editing");
    // The restored asset is no longer flagged broken in the resource panel.
    const row = screen.getByText("lake.png").closest(".resource-row");
    expect(row?.textContent).not.toContain("broken");
  });

  it("keeps the issue and reports the error when replacement fails", async () => {
    await openGolden({ selfCheck: missingImageCheck() });
    const dialog = await screen.findByRole("alertdialog");
    fetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes("/content") && (init as RequestInit)?.method === "PUT") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "UNSUPPORTED_MEDIA_TYPE",
              message: "Unsupported media type",
              status: 415,
            }),
            { status: 415, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        route({ selfCheck: missingImageCheck() })(url, init as RequestInit),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Locate…" }));
    const input = dialog.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "lake.txt", { type: "text/plain" })] },
    });

    await screen.findByRole("alert");
    expect(dialog.textContent).toContain("Unsupported media type");
    expect(dialog.textContent).toContain("Open with missing assets");
    expect(useProjectStore.getState().selfCheck?.ok).toBe(false);
  });
});

describe("export package", () => {
  it("offers an incomplete export when assets are missing", async () => {
    await openGolden({
      exportFailure: {
        code: "ASSET_MISSING",
        message: "Export blocked: 1 referenced asset(s) are missing",
        status: 404,
      },
    });
    await screen.findByRole("button", { name: "Canvas 1" });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("1 referenced asset");
    expect(exportCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Export anyway" }));
    await vi.waitFor(() => {
      expect(exportCalls()).toHaveLength(2);
    });
    expect(exportCalls()[1].body.allowIncomplete).toBe(true);
    await vi.waitFor(() => {
      expect(
        useAppStore
          .getState()
          .toasts.some(
            (toast) =>
              toast.kind === "success" &&
              toast.message.includes("flagged incomplete"),
          ),
      ).toBe(true);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("cancel leaves the project untouched", async () => {
    await openGolden({
      exportFailure: {
        code: "ASSET_MISSING",
        message: "Export blocked: 1 referenced asset(s) are missing",
        status: 404,
      },
    });
    await screen.findByRole("button", { name: "Canvas 1" });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(exportCalls()).toHaveLength(1);
    expect(useAppStore.getState().phase).toBe("editing");
  });
});

describe("unsaved-work guard", () => {
  function makeUnsavedEdit() {
    const ids = goldenNodeIds();
    act(() => {
      editTextContent(ids.text, "A changed brief");
    });
    expect(useProjectStore.getState().pending.length).toBeGreaterThan(0);
  }

  it("asks before leaving and discard drops the changes", async () => {
    await openGolden();
    await screen.findByRole("button", { name: "Canvas 1" });
    makeUnsavedEdit();

    fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Unsaved changes");
    expect(useAppStore.getState().phase).toBe("editing");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(useAppStore.getState().phase).toBe("editing");

    fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
    expect(useAppStore.getState().phase).toBe("launcher");
    expect(useProjectStore.getState().moka).toBeNull();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/projects/current/commands"),
      ),
    ).toBe(false);
  });

  it("save and close flushes the pending changes first", async () => {
    await openGolden();
    await screen.findByRole("button", { name: "Canvas 1" });
    makeUnsavedEdit();

    fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));

    await vi.waitFor(() => {
      expect(useAppStore.getState().phase).toBe("launcher");
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).includes("/projects/current/commands") &&
          (init as RequestInit)?.method === "POST",
      ),
    ).toBe(true);
  });

  it("conflicted state blocks saving but keeps the export escape hatch", async () => {
    await openGolden();
    await screen.findByRole("button", { name: "Canvas 1" });
    makeUnsavedEdit();
    act(() => {
      useProjectStore.setState({ saveStatus: "conflicted" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Back to launcher" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("revision conflict");
    expect(
      screen.getByRole("button", { name: "Save and close" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(
      screen.getByRole("button", { name: "Export copy and close" }),
    );
    await vi.waitFor(() => {
      expect(useAppStore.getState().phase).toBe("launcher");
    });
    expect(exportCalls()).toHaveLength(1);
    // A conflicted project cannot flush; the export ships the saved revision.
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/projects/current/commands"),
      ),
    ).toBe(false);
  });
});
