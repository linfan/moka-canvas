import type { AssetId, ResourceEntry } from "../shared/domain";
import { http } from "./client";
import type { SaveResult } from "./projects";

/**
 * The things that can be done to a picture the project already holds.
 *
 * None of them asks anybody for anything. They are arithmetic on pixels that are
 * already here, so they cost nothing, give the same answer twice, and there is
 * no model to configure when one of them cannot be done.
 */
export type PictureTool = "crop" | "split" | "resize" | "tilt";

/**
 * Where a cut goes, in the picture's own pixels rather than in the rectangle a
 * node happens to be drawn in. The two are only the same shape until somebody
 * resizes the node, and a node is display while a file is the thing itself.
 */
export interface PictureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How a picture meets a box that is not its shape. */
export type PictureFit = "contain" | "cover" | "fill";

/** A size by name — the long edge it is fitted inside — or one asked for. */
export type PictureBox = "k2" | "k4" | { width: number; height: number };

/** What each tool is asked for. A field another tool has is refused, not dropped. */
export interface PictureToolParams {
  crop: { region?: PictureRegion; ratio?: string };
  split: { rows: number; cols: number };
  resize: { target: PictureBox; fit?: PictureFit };
  tilt: { yaw?: number; pitch?: number };
}

export interface ToolReport extends SaveResult {
  /** What was filed, in the order it is to be laid out. */
  entries: ResourceEntry[];
  /**
   * What a result is for, in words, where the tool has something to say about
   * it. A turn does: the picture it makes is a reference, and the words are what
   * the next ask out of it is written against.
   */
  prompt?: string;
}

export const toolsApi = {
  apply<Tool extends PictureTool>(
    tool: Tool,
    assetId: AssetId,
    params: PictureToolParams[Tool],
    signal?: AbortSignal,
  ): Promise<ToolReport> {
    return http.request<ToolReport>("/api/v1/projects/current/tools", {
      method: "POST",
      body: { tool, assetId, params },
      signal,
    });
  },
};
