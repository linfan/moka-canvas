// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { MokaFile, ResourceEntry } from "../../../shared/domain";
import { buildShelfMokaFile } from "../../../shared/domain/fixtures";
import { SidePanel } from "./SidePanel";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useHistoryStore } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function openShelf(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-shelf-test",
    selfCheck: { ok: true, issues: [] },
  });
  return moka;
}

function rowsShown(): string[] {
  return [...document.querySelectorAll(".resource-main strong")].map(
    (name) => name.textContent ?? "",
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(json({})));
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({ announcement: "", previewAssetId: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the resource shelf", () => {
  it("shows what a reader said about each file", () => {
    openShelf(buildShelfMokaFile());
    render(<SidePanel />);
    expect(screen.getByText("lake.png")).toBeTruthy();
    expect(screen.getByText("dusk")).toBeTruthy();
    expect(
      screen.getAllByTestId("resource-where").map((mark) => mark.textContent),
    ).toEqual(["Brought in", "Brought in"]);
    expect(
      screen.getByTestId("shelf-tag-lake").textContent?.replace(/\s+/g, " "),
    ).toBe("lake · 1");
  });

  it("narrows the shelf to a word in what was said", () => {
    openShelf(buildShelfMokaFile());
    render(<SidePanel />);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "lantern" },
    });
    expect(rowsShown()).toEqual(["lake.png"]);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "opening" },
    });
    expect(rowsShown().length).toBe(2);
  });

  it("asks for every word chosen on the shelf", () => {
    openShelf(buildShelfMokaFile());
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId("shelf-tag-dusk"));
    expect(rowsShown()).toEqual(["lake.png"]);
    fireEvent.click(screen.getByTestId("shelf-tag-opening"));
    expect(screen.getByTestId("shelf-no-match")).toBeTruthy();
    fireEvent.click(screen.getByTestId("shelf-clear"));
    expect(rowsShown().length).toBe(2);
  });

  it("keeps only the files marked to hand", () => {
    openShelf(buildShelfMokaFile());
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId("shelf-keepers"));
    expect(rowsShown()).toEqual(["lake.png"]);
  });

  it("separates what the project made from what it was handed", () => {
    openShelf(buildShelfMokaFile());
    render(<SidePanel />);
    fireEvent.change(screen.getByTestId("shelf-where"), {
      target: { value: "made" },
    });
    expect(screen.getByTestId("shelf-no-match")).toBeTruthy();
    fireEvent.change(screen.getByTestId("shelf-where"), {
      target: { value: "brought" },
    });
    expect(rowsShown().length).toBe(2);
  });

  it("carries on a shelf longer than one page", () => {
    const moka = buildShelfMokaFile();
    moka.resources.texts.push(
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `text-${index}`,
        name: `note-${index}.md`,
        path: `assets/texts/note-${index}.md`,
        mime: "text/markdown",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
    );
    openShelf(moka);
    render(<SidePanel />);
    expect(screen.getByTestId("shelf-shown").textContent).toBe("60 of 62");
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.queryByTestId("shelf-shown")).toBeNull();
    expect(rowsShown().length).toBe(62);
  });

  it("writes a keeper mark onto the shelf and keeps the list in step", async () => {
    const moka = openShelf(buildShelfMokaFile());
    const text = moka.resources.texts[0] as ResourceEntry;
    fetchMock.mockImplementation((_input, init) => {
      const edit = JSON.parse(String(init?.body)) as Partial<ResourceEntry>;
      return Promise.resolve(
        json({
          entry: { ...text, ...edit },
          revision: 12,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
    });
    render(<SidePanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Keep opening-lines.md to hand" }),
    );
    await waitFor(() => {
      expect(useProjectStore.getState().moka?.resources.texts[0].favorite).toBe(
        true,
      );
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/v1/projects/current/assets/${text.id}`);
    expect(options?.method).toBe("PATCH");
    expect(JSON.parse(String(options?.body))).toEqual({ favorite: true });
    expect(useProjectStore.getState().moka?.metadata.revision).toBe(12);
  });
});
