// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import type { PublicConfig } from "../../../api/config";
import { useAppStore } from "../stores/appStore";
import { useProjectStore } from "../stores/projectStore";
import {
  askSavePath,
  fileSafeName,
  outputFolder,
  suggestedSavePath,
} from "./savePath";
import { useSavePathStore } from "./savePathStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

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

beforeEach(() => {
  useAppStore.setState({ config: CONFIG });
  useProjectStore.setState({ root: "/proj/demo" });
  useSavePathStore.setState({ pending: null });
});

afterEach(() => {
  vi.mocked(save).mockReset();
});

describe("a name a file can have", () => {
  it("turns the separators a name cannot hold into dashes", () => {
    expect(fileSafeName("Cut 1")).toBe("Cut 1");
    expect(fileSafeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });
});

describe("where a save is offered", () => {
  it("suggests the project's own output folder", () => {
    expect(suggestedSavePath("film.mp4")).toBe("/proj/demo/output/film.mp4");
    expect(outputFolder()).toBe("/proj/demo/output");
  });

  it("offers the name alone when no project is open", () => {
    useProjectStore.setState({ root: null });
    expect(suggestedSavePath("film.mp4")).toBe("film.mp4");
    expect(outputFolder()).toBeNull();
  });
});

describe("asking where a file goes", () => {
  it("in the web runtime, asks the window and answers what the dialog said", async () => {
    const asking = askSavePath({
      title: "Save the video",
      defaultName: "Cut 1.mp4",
      extensions: ["mp4"],
    });
    const pending = useSavePathStore.getState().pending;
    expect(pending?.title).toBe("Save the video");
    expect(pending?.defaultName).toBe("Cut 1.mp4");

    useSavePathStore.getState().reply("/proj/demo/output/Cut 1.mp4");
    await expect(asking).resolves.toBe("/proj/demo/output/Cut 1.mp4");
    expect(useSavePathStore.getState().pending).toBeNull();
  });

  it("answers null when the question is backed out of", async () => {
    const asking = askSavePath({
      title: "Save the video",
      defaultName: "Cut 1.mp4",
      extensions: ["mp4"],
    });
    useSavePathStore.getState().reply(null);
    await expect(asking).resolves.toBeNull();
  });

  it("answers a second question rather than stacking it", async () => {
    const first = askSavePath({
      title: "Save the video",
      defaultName: "Cut 1.mp4",
      extensions: ["mp4"],
    });
    const second = askSavePath({
      title: "Save the image",
      defaultName: "Board.png",
      extensions: ["png"],
    });
    await expect(second).resolves.toBeNull();
    useSavePathStore.getState().reply("/x.mp4");
    await expect(first).resolves.toBe("/x.mp4");
  });

  it("in the desktop runtime, asks the operating system at the output folder", async () => {
    useAppStore.setState({
      config: {
        ...CONFIG,
        capabilities: { ...CONFIG.capabilities, mode: "tauri" },
      },
    });
    vi.mocked(save).mockResolvedValue("/Users/you/Movies/Cut 1.mp4");

    const answer = await askSavePath({
      title: "Save the video",
      defaultName: "Cut 1.mp4",
      extensions: ["mp4"],
    });

    expect(answer).toBe("/Users/you/Movies/Cut 1.mp4");
    expect(vi.mocked(save).mock.calls[0][0]).toEqual({
      title: "Save the video",
      defaultPath: "/proj/demo/output/Cut 1.mp4",
      filters: [{ name: "Save the video", extensions: ["mp4"] }],
    });
    expect(useSavePathStore.getState().pending).toBeNull();
  });

  it("in the desktop runtime, a dialog that is closed answers null", async () => {
    useAppStore.setState({
      config: {
        ...CONFIG,
        capabilities: { ...CONFIG.capabilities, mode: "tauri" },
      },
    });
    vi.mocked(save).mockResolvedValue(null);

    await expect(
      askSavePath({
        title: "Save the video",
        defaultName: "Cut 1.mp4",
        extensions: ["mp4"],
      }),
    ).resolves.toBeNull();
  });
});
