// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { buildGoldenMokaFile } from "../../shared/domain/fixtures";
import { i18n } from "../../shared/i18n";
import { AssetsPage } from "./AssetsPage";
import { useAppStore } from "../editor/stores/appStore";
import { useHistoryStore } from "../editor/stores/historyStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useAssetsStore } from "./stores/assetsStore";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The room as a reader arrives in it: a project open, nothing chosen. */
function openRoom() {
  const moka = buildGoldenMokaFile();
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-assets-test",
    selfCheck: { ok: true, issues: [] },
  });
  useAppStore.getState().setPhase("assets");
  render(<AssetsPage />);
  return moka;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(json({})));
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAssetsStore.setState({ inspectedAssetId: null, view: "all" });
  useAppStore.setState({ phase: "launcher", toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the files room", () => {
  it("stands its three panes, the menu marking it as where the reader is", () => {
    openRoom();
    expect(screen.getByTestId("assets-page")).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("assets:page.title"))).toBeTruthy();
    expect(screen.getByLabelText(i18n.t("assets:stage.label"))).toBeTruthy();
    expect(
      screen.getByLabelText(i18n.t("assets:inspector.label")),
    ).toBeTruthy();
    expect(screen.getByTestId("assets-stage-hint")).toBeTruthy();

    fireEvent.click(screen.getByTestId("home-menu-button"));
    const current = screen
      .getAllByRole("menuitem")
      .find((item) => item.getAttribute("aria-current") === "page");
    expect(current?.textContent).toContain(i18n.t("app:homeMenu.assets"));
  });

  it("puts the project down on going home", async () => {
    openRoom();
    fireEvent.click(screen.getByTestId("home-menu-button"));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Projects" }));
    });
    expect(useAppStore.getState().phase).toBe("launcher");
    expect(useProjectStore.getState().moka).toBeNull();
  });
});
