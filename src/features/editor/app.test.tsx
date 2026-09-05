// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import App from "../../App";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
import { useAppStore } from "./stores/appStore";
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

function route(url: string): Response {
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
  if (url === "/api/v1/projects/current/commands") {
    return json({ revision: 4, updatedAt: "2026-01-01T00:00:02.000Z" });
  }
  return json({ code: "NOT_FOUND", message: url, status: 404 }, 404);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => Promise.resolve(route(String(input)))),
  );
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({
    phase: "booting",
    config: null,
    bootError: null,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("app boot", () => {
  it("reaches the launcher and lists recent projects", async () => {
    render(<App />);
    const heading = await screen.findByRole("heading", {
      name: "Moka Canvas",
    });
    expect(heading).toBeTruthy();
    expect(screen.getByText("Golden Fixture")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New project" })).toBeTruthy();
  });

  it("opens a project into the editor shell", async () => {
    render(<App />);
    const recent = await screen.findByText("Golden Fixture");
    fireEvent.click(recent);

    // Both canvas tabs and the shell chrome appear.
    const tab = await screen.findByRole("button", { name: "Canvas 1" });
    expect(tab).toBeTruthy();
    expect(screen.getByRole("button", { name: "Canvas 2" })).toBeTruthy();
    const host = screen.getByTestId("canvas-host");
    expect(within(host).getByText("4 nodes · 2 edges")).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(useAppStore.getState().phase).toBe("editing");

    // Switching canvases swaps the scene summary.
    fireEvent.click(screen.getByRole("button", { name: "Canvas 2" }));
    expect(await within(host).findByText("0 nodes · 0 edges")).toBeTruthy();
  });
});
