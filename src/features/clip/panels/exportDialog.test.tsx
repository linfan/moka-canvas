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
import {
  buildCutMokaFile,
  cutFixtureIds,
} from "../../../shared/domain/fixtures";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useSavePathStore } from "../../editor/launcher/savePathStore";
import { clipApi, type ClipExportTask } from "../api";
import { useClipStore } from "../stores/clipStore";
import { useExportStore } from "../stores/exportStore";
import { ExportDialog } from "./ExportDialog";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    clipApi: {
      ...actual.clipApi,
      capabilities: vi.fn(),
      start: vi.fn(),
      status: vi.fn(),
      cancel: vi.fn(),
    },
  };
});

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

const TIMELINE = "timeline-cut";

function task(over: Partial<ClipExportTask> = {}): ClipExportTask {
  return {
    id: "job-1",
    timelineId: cutFixtureIds().timeline,
    status: "queued",
    progress01: 0,
    ...over,
  };
}

/** The question standing, waited for — which is the ask itself. */
async function asked() {
  return vi.waitFor(() => {
    const pending = useSavePathStore.getState().pending;
    expect(pending).not.toBeNull();
    return pending!;
  });
}

/** Presses the one button that asks for a render, once it can be pressed. */
async function press(label: string): Promise<void> {
  const button = await screen.findByRole("button", { name: label });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
}

beforeEach(() => {
  vi.mocked(clipApi.capabilities).mockResolvedValue({
    available: true,
    version: "7.0",
    path: "/opt/ffmpeg",
    transitions: [],
    ass: true,
  });
  vi.mocked(clipApi.start).mockResolvedValue(task());
  vi.mocked(clipApi.status).mockResolvedValue(task({ status: "running" }));
  vi.mocked(clipApi.cancel).mockResolvedValue(task({ status: "cancelled" }));
  useAppStore.setState({ config: CONFIG, toasts: [] });
  useProjectStore.setState({ moka: buildCutMokaFile(), root: "/proj/demo" });
  useClipStore.setState({ activeTimelineId: TIMELINE });
  useExportStore.setState({
    open: true,
    task: null,
    destination: null,
    error: null,
  });
  useSavePathStore.setState({ pending: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("exporting a timeline to a file", () => {
  it("asks where the file goes before the render is asked for", async () => {
    render(<ExportDialog />);
    await press("Export video");

    const pending = await asked();
    expect(pending.title).toBe("Save the video");
    expect(pending.defaultName).toBe("Timeline 1.mp4");
    // Nothing has been asked of the server while the path is still a question.
    expect(clipApi.start).not.toHaveBeenCalled();

    useSavePathStore.getState().reply("/proj/demo/output/Timeline 1.mp4");
    await waitFor(() =>
      expect(clipApi.start).toHaveBeenCalledWith(
        TIMELINE,
        "/proj/demo/output/Timeline 1.mp4",
      ),
    );
    expect(useExportStore.getState().destination).toBe(
      "/proj/demo/output/Timeline 1.mp4",
    );
  });

  it("writes nothing when the save question is backed out of", async () => {
    render(<ExportDialog />);
    await press("Export video");

    await asked();
    useSavePathStore.getState().reply(null);

    await waitFor(() => expect(useSavePathStore.getState().pending).toBeNull());
    expect(clipApi.start).not.toHaveBeenCalled();
    expect(useExportStore.getState().destination).toBeNull();
    expect(useExportStore.getState().error).toBeNull();
  });

  it("says where the finished file was written", async () => {
    useExportStore.setState({
      task: task({
        status: "done",
        progress01: 1,
        savedTo: "/proj/demo/output/Timeline 1.mp4",
      }),
    });
    render(<ExportDialog />);

    expect(screen.getByTestId("clip-export-done").textContent).toBe(
      "Saved to /proj/demo/output/Timeline 1.mp4",
    );
  });

  it("retries a render that failed at the path it was going to", async () => {
    useExportStore.setState({
      task: task({ status: "failed", message: "The renderer stopped" }),
      destination: "/proj/demo/output/Timeline 1.mp4",
    });
    render(<ExportDialog />);

    await press("Try again");

    await waitFor(() =>
      expect(clipApi.start).toHaveBeenCalledWith(
        TIMELINE,
        "/proj/demo/output/Timeline 1.mp4",
      ),
    );
    // The path was chosen once; a retry is not a fresh question.
    expect(useSavePathStore.getState().pending).toBeNull();
  });
});
