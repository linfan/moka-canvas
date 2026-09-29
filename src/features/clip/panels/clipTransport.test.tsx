// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PublicConfig } from "../../../api/config";
import { buildCutMokaFile } from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { SavePathHost } from "../../editor/launcher/SavePathHost";
import { useSavePathStore } from "../../editor/launcher/savePathStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { ClipTransport } from "./ClipTransport";

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
const originalToBlob = HTMLCanvasElement.prototype.toBlob;

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

/** The picture the preview pane would have drawn. */
function stubPreviewCanvas() {
  const canvas = document.createElement("canvas");
  canvas.className = "clip-preview-canvas";
  document.body.appendChild(canvas);
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
    callback(new Blob(["png"], { type: "image/png" }));
  };
  return canvas;
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
  useProjectStore.setState({ root: "/proj/demo" });
  useClipStore.setState({ playheadMs: 0 });
  useSavePathStore.setState({ pending: null });
});

afterEach(() => {
  cleanup();
  document.querySelector(".clip-preview-canvas")?.remove();
  HTMLCanvasElement.prototype.toBlob = originalToBlob;
  vi.unstubAllGlobals();
});

describe("saving the frame under the playhead", () => {
  const timeline = buildCutMokaFile().timelines![0]!;

  it("asks where the picture goes and writes the preview's own frame", async () => {
    stubPreviewCanvas();
    render(
      <>
        <ClipTransport timeline={timeline} />
        <SavePathHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save snapshot" }));
    const choose = await screen.findByTestId("path-browser-choose");
    await waitFor(() => expect(choose).toHaveProperty("disabled", false));
    // The name carries the moment, since a cut can be saved frame by frame.
    expect(
      (screen.getByTestId("path-browser-name") as HTMLInputElement).value,
    ).toBe("Timeline 1-00-00-00-00.png");
    fireEvent.click(choose);

    await waitFor(() => expect(writes()).toHaveLength(1));
    const asked = new URL(writes()[0].url, "http://localhost");
    expect(asked.searchParams.get("path")).toBe(
      "/proj/demo/output/Timeline 1-00-00-00-00.png",
    );
    expect(writes()[0].body).toBeInstanceOf(Blob);
    await waitFor(() =>
      expect(useAppStore.getState().toasts).toMatchObject([
        {
          kind: "success",
          message:
            "Snapshot saved to /proj/demo/output/Timeline 1-00-00-00-00.png",
        },
      ]),
    );
  });

  it("writes nothing when the save question is backed out of", async () => {
    stubPreviewCanvas();
    render(
      <>
        <ClipTransport timeline={timeline} />
        <SavePathHost />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save snapshot" }));
    const close = await screen.findByTestId("path-browser");
    fireEvent.click(close.querySelector("header button")!);

    await waitFor(() =>
      expect(screen.queryByTestId("path-browser")).toBeNull(),
    );
    expect(writes()).toHaveLength(0);
    expect(useAppStore.getState().toasts).toEqual([]);
  });
});

describe("the row without a pane", () => {
  it("has nothing to save while no preview is mounted", async () => {
    const timeline = buildCutMokaFile().timelines![0]!;
    render(
      <>
        <ClipTransport timeline={timeline} />
        <SavePathHost />
      </>,
    );

    // The button is offered, but with no canvas there is no frame — and no
    // question is asked about a picture that does not exist.
    fireEvent.click(screen.getByRole("button", { name: "Save snapshot" }));
    await waitFor(() => expect(useSavePathStore.getState().pending).toBeNull());
    expect(writes()).toHaveLength(0);
  });
});
