// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  buildCutMokaFile,
  cutFixtureIds,
} from "../../../shared/domain/fixtures";
import type { PublicConfig } from "../../../api/config";
import { useAppStore } from "../../editor/stores/appStore";
import { SavePathHost } from "../../editor/launcher/SavePathHost";
import { useSavePathStore } from "../../editor/launcher/savePathStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { TextPanel } from "./TextPanel";

const CONFIG: PublicConfig = {
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

const fetchMock = vi.fn<typeof fetch>();

/** Lists whatever folder was asked for, and answers a write with its size. */
function serveFiles() {
  fetchMock.mockImplementation((input, init) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.startsWith("/api/v1/filesystem?")) {
      const asked = new URL(`http://localhost${url}`);
      return Promise.resolve(
        json({
          path: asked.searchParams.get("path") ?? "",
          parent: "/proj",
          entries: [],
          truncated: false,
        }),
      );
    }
    if (url.startsWith("/api/v1/filesystem/file?") && init?.method === "PUT") {
      return Promise.resolve(json({ path: "written", bytes: 3 }));
    }
    return Promise.resolve(json({ code: "NOT_FOUND", message: url }, 404));
  });
}

function writes(): { url: string; body: BodyInit | null | undefined }[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit)?.method === "PUT")
    .map(([url, init]) => ({
      url: String(url),
      body: (init as RequestInit).body,
    }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  serveFiles();
  useAppStore.setState({ config: CONFIG, toasts: [] });
  useProjectStore.setState({ moka: buildCutMokaFile(), root: "/proj/demo" });
  useClipStore.setState({
    activeTimelineId: cutFixtureIds().timeline,
    selection: { clipIds: [], transitionId: null },
  });
  useSavePathStore.setState({ pending: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("writing the subtitle track back out", () => {
  it("asks where the .srt goes, and writes the cues it was showing", async () => {
    render(
      <>
        <TextPanel />
        <SavePathHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export .srt" }));
    const choose = await screen.findByTestId("path-browser-choose");
    await waitFor(() => expect(choose).toHaveProperty("disabled", false));
    expect(screen.getByTestId("path-browser-name")).toHaveProperty(
      "value",
      "Timeline 1.srt",
    );
    fireEvent.click(choose);

    await waitFor(() => expect(writes()).toHaveLength(1));
    const asked = new URL(writes()[0].url, "http://localhost");
    expect(asked.searchParams.get("path")).toBe(
      "/proj/demo/output/Timeline 1.srt",
    );
    const body = writes()[0].body;
    expect(body).toBeInstanceOf(Blob);
    expect((body as Blob).type).toBe("application/x-subrip");
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        {
          kind: "success",
          message: "Subtitles saved to /proj/demo/output/Timeline 1.srt",
        },
      ]),
    );
  });

  it("writes nothing when the save question is backed out of", async () => {
    render(
      <>
        <TextPanel />
        <SavePathHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export .srt" }));
    const choose = await screen.findByTestId("path-browser-choose");
    await waitFor(() => expect(choose).toHaveProperty("disabled", false));
    fireEvent.click(
      screen.getByTestId("path-browser").querySelector("header button")!,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("path-browser")).toBeNull(),
    );
    expect(writes()).toHaveLength(0);
    expect(useAppStore.getState().toasts).toEqual([]);
  });
});
