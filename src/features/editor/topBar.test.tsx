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

function route(): (url: string, init?: RequestInit) => Response {
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
        selfCheck: { ok: true, issues: [] },
      });
    }
    if (url === "/api/v1/projects/current/runs") return json([]);
    if (url === "/api/v1/projects/current/commands") {
      return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
    }
    if (url === "/api/v1/projects/current/assets" && init?.method === "POST") {
      return json({
        entry: {
          id: "dropped-asset",
          name: "drop.png",
          path: "assets/images/drop-1.png",
          mime: "image/png",
          bytes: 12,
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        revision: 6,
        updatedAt: "2026-01-01T00:00:04.000Z",
      });
    }
    return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
  };
}

async function openGolden() {
  const handler = route();
  fetchMock.mockImplementation((input, init) =>
    Promise.resolve(handler(String(input), init as RequestInit)),
  );
  render(<App />);
  const recent = await screen.findByText("Golden Fixture");
  fireEvent.click(recent);
  await screen.findByRole("button", { name: "Canvas 1" });
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
    nodeMenu: null,
    contextMenu: null,
    assetDeletePrompt: null,
    previewAssetId: null,
    announcement: "",
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("top bar", () => {
  it("adds a node of the chosen kind from the bar", async () => {
    await openGolden();
    const before = useProjectStore.getState().moka!.canvas[0].nodes.length;

    fireEvent.click(screen.getByRole("button", { name: "Add node" }));
    const menu = await screen.findByRole("menu", { name: "Add node" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Text" }));

    const canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.nodes).toHaveLength(before + 1);
    const added = canvas.nodes[canvas.nodes.length - 1];
    expect(added.kind).toBe("text");
    // The choice moves the document, so the question it was asked through goes
    // away rather than staying up over the new node.
    expect(screen.queryByRole("menu", { name: "Add node" })).toBeNull();
  });

  it("groups what is selected and takes the group apart again", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    const groupButton = screen.getByRole("button", { name: "Group" });
    expect(groupButton).toHaveProperty("disabled", true);

    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.text, ids.image], edgeIds: [] });
    });
    expect(groupButton).toHaveProperty("disabled", false);
    fireEvent.click(groupButton);

    let canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.groups).toHaveLength(1);
    expect(canvas.groups[0].childNodeIds).toEqual([ids.text, ids.image]);
    const groupId = canvas.groups[0].groupId;
    expect(
      canvas.nodes.some((node) => node.id === groupId && node.kind === "group"),
    ).toBe(true);

    // Grouping leaves the group selected with its members, which is what
    // Ungroup is for.
    fireEvent.click(screen.getByRole("button", { name: "Ungroup" }));
    canvas = useProjectStore.getState().moka!.canvas[0];
    expect(canvas.groups).toHaveLength(0);
    expect(canvas.nodes.some((node) => node.id === groupId)).toBe(false);
    expect(canvas.nodes.some((node) => node.id === ids.text)).toBe(true);
  });

  it("leaves Ungroup alone until a group is selected", async () => {
    const ids = goldenNodeIds();
    await openGolden();
    act(() => {
      useEditorStore
        .getState()
        .setSelection({ nodeIds: [ids.text], edgeIds: [] });
    });
    expect(screen.getByRole("button", { name: "Ungroup" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("imports files chosen from the bar as assets and nodes", async () => {
    await openGolden();
    // The resource panel offers its own Import…, so the bar's is asked for by
    // region rather than by name alone.
    const topbar = screen.getByRole("banner");
    fireEvent.click(within(topbar).getByRole("button", { name: "Import…" }));
    const input = screen.getByLabelText(
      "Import files into the project",
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["x"], "drop.png", { type: "image/png" }),
          new File(["y"], "second.png", { type: "image/png" }),
        ],
      },
    });

    await vi.waitFor(() => {
      expect(
        useProjectStore
          .getState()
          .moka!.resources.images.some((entry) => entry.id === "dropped-asset"),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      const titles = useProjectStore
        .getState()
        .moka!.canvas[0].nodes.map((node) => node.title);
      expect(titles.filter((title) => title === "drop.png")).toHaveLength(2);
    });
  });
});
