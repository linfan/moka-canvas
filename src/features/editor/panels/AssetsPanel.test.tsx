// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { MokaFile, ResourceEntry } from "../../../shared/domain";
import {
  buildShelfMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
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

/**
 * The shelf as a reader reaches it: the left column, turned over to its assets
 * face. Rendered through the column rather than on its own, since which face a
 * reader gets is part of what is being tested.
 */
function openShelf(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: "/tmp/moka-shelf-test",
    selfCheck: { ok: true, issues: [] },
  });
  render(<SidePanel />);
  fireEvent.click(screen.getByTestId("left-tab-assets"));
  return moka;
}

/** The kind being read, which is one tab of four. */
function showKind(kind: "text" | "image" | "audio" | "video") {
  fireEvent.click(screen.getByTestId(`asset-kind-${kind}`));
}

function rowsShown(): string[] {
  return [...document.querySelectorAll(".resource-main strong")].map(
    (name) => name.textContent ?? "",
  );
}

/** A second picture, so a word chosen on the shelf has something to narrow. */
function withSecondPicture(moka: MokaFile): MokaFile {
  moka.resources.images.push({
    id: "image-dawn",
    name: "dawn.png",
    path: "assets/images/dawn-00000000.png",
    mime: "image/png",
    bytes: 2048,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: ["dusk"],
    origin: "brought",
  });
  return moka;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(() => Promise.resolve(json({})));
  useProjectStore.getState().close();
  useHistoryStore.getState().clear();
  useAppStore.setState({ toasts: [] });
  useEditorStore.setState({
    announcement: "",
    previewAssetId: null,
    leftPanelTab: "project",
    assetKind: "image",
    focusedAssetId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the shelf, one kind at a time", () => {
  it("lists each kind under its own tab and counts what it holds", () => {
    openShelf(buildShelfMokaFile());
    expect(rowsShown()).toEqual(["lake.png"]);
    showKind("text");
    expect(rowsShown()).toEqual(["opening-lines.md"]);
    showKind("audio");
    expect(rowsShown()).toEqual([]);
    expect(screen.queryByTestId("shelf-no-match")).toBeNull();
    expect(screen.getByText(/No audio assets yet/)).toBeTruthy();
  });

  it("shows what a reader said about each file", () => {
    openShelf(buildShelfMokaFile());
    expect(screen.getByText("lake.png")).toBeTruthy();
    expect(screen.getByText("dusk")).toBeTruthy();
    expect(
      screen.getAllByTestId("resource-where").map((mark) => mark.textContent),
    ).toEqual(["Brought in"]);
    expect(
      screen.getByTestId("shelf-tag-lake").textContent?.replace(/\s+/g, " "),
    ).toBe("lake · 1");
  });

  it("narrows the shelf to a word in what was said", () => {
    openShelf(buildShelfMokaFile());
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "lantern" },
    });
    expect(rowsShown()).toEqual(["lake.png"]);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "opening" },
    });
    // The note is searched too, and this one says "Kept for the opening shot",
    // so the picture is still the one found.
    expect(rowsShown()).toEqual(["lake.png"]);
    fireEvent.change(screen.getByTestId("shelf-asked"), {
      target: { value: "opening-lines" },
    });
    // What a file says about itself is read within the kind being looked at, so
    // the name of a text finds nothing among the pictures.
    expect(screen.getByTestId("shelf-no-match")).toBeTruthy();
  });

  it("asks for every word chosen on the shelf", () => {
    openShelf(withSecondPicture(buildShelfMokaFile()));
    fireEvent.click(screen.getByTestId("shelf-tag-dusk"));
    expect(rowsShown()).toEqual(["lake.png", "dawn.png"]);
    fireEvent.click(screen.getByTestId("shelf-tag-lake"));
    expect(rowsShown()).toEqual(["lake.png"]);
    fireEvent.click(screen.getByTestId("shelf-clear"));
    expect(rowsShown()).toEqual(["lake.png", "dawn.png"]);
  });

  it("keeps only the files marked to hand", () => {
    openShelf(withSecondPicture(buildShelfMokaFile()));
    fireEvent.click(screen.getByTestId("shelf-keepers"));
    expect(rowsShown()).toEqual(["lake.png"]);
  });

  it("separates what the project made from what it was handed", () => {
    openShelf(buildShelfMokaFile());
    fireEvent.change(screen.getByTestId("shelf-where"), {
      target: { value: "made" },
    });
    expect(screen.getByTestId("shelf-no-match")).toBeTruthy();
    fireEvent.change(screen.getByTestId("shelf-where"), {
      target: { value: "brought" },
    });
    expect(rowsShown()).toEqual(["lake.png"]);
  });

  it("tells two shelves of one kind apart, and asks nothing of a kind with one", () => {
    const moka = buildShelfMokaFile();
    moka.resources.voice.push({
      id: "voice-one",
      name: "reading.wav",
      path: "assets/voice/reading-00000000.wav",
      mime: "audio/wav",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    openShelf(moka);
    showKind("audio");
    expect(rowsShown()).toEqual(["reading.wav"]);
    // A sound is filed as either music or a voice, so the audio tab is two
    // shelves and offers the choice between them.
    fireEvent.change(screen.getByTestId("shelf-category"), {
      target: { value: "music" },
    });
    expect(rowsShown()).toEqual([]);
    showKind("image");
    expect(screen.queryByTestId("shelf-category")).toBeNull();
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
    showKind("text");
    expect(screen.getByTestId("shelf-shown").textContent).toBe("60 of 61");
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(screen.queryByTestId("shelf-shown")).toBeNull();
    expect(rowsShown()).toHaveLength(61);
  });

  it("writes a keeper mark onto the shelf and keeps the list in step", async () => {
    const moka = openShelf(buildShelfMokaFile());
    const text = moka.resources.texts[0] as ResourceEntry;
    showKind("text");
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

  it("refiles an entry with the words and note written on its row", async () => {
    const moka = openShelf(buildShelfMokaFile());
    const text = moka.resources.texts[0] as ResourceEntry;
    showKind("text");
    fetchMock.mockImplementation((_input, init) => {
      const edit = JSON.parse(String(init?.body)) as Partial<ResourceEntry>;
      return Promise.resolve(
        json({
          entry: { ...text, ...edit },
          revision: 13,
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Tag opening-lines.md" }),
    );
    fireEvent.change(
      screen.getByLabelText("Words to file opening-lines.md under"),
      { target: { value: "openers, dusk, openers" } },
    );
    fireEvent.change(screen.getByLabelText("Note about opening-lines.md"), {
      target: { value: "Worth an opening." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(useProjectStore.getState().moka?.resources.texts[0].note).toBe(
        "Worth an opening.",
      );
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/api/v1/projects/current/assets/${text.id}`);
    expect(options?.method).toBe("PATCH");
    expect(JSON.parse(String(options?.body))).toEqual({
      tags: ["openers", "dusk"],
      note: "Worth an opening.",
    });
    expect(useProjectStore.getState().moka?.resources.texts[0].tags).toEqual([
      "openers",
      "dusk",
    ]);
  });

  it("turns the column over to the file the tree asked for", () => {
    openShelf(buildShelfMokaFile());
    showKind("text");
    // Following a file from the tree: the column turns over, the kind it is
    // filed under is the one shown, and that row is the one marked.
    fireEvent.click(screen.getByTestId("left-tab-project"));
    act(() => {
      useEditorStore
        .getState()
        .showAssetOnShelf(goldenNodeIds().assetImage, "image");
    });
    expect(
      screen.getByTestId("left-tab-assets").getAttribute("aria-selected"),
    ).toBe("true");
    expect(rowsShown()).toEqual(["lake.png"]);
    const marked = document.querySelector(".resource-row.is-focused");
    expect(marked?.getAttribute("data-asset-id")).toBe(
      goldenNodeIds().assetImage,
    );
  });
});
