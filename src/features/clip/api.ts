import type { TimelineId } from "../../shared/domain";
import { http } from "../../api/client";

/**
 * What this machine's renderer can do.
 *
 * `available` false is a fact about the machine rather than about a request:
 * the cutting room works without it, and only an export says what is missing.
 */
export interface ClipCapabilities {
  available: boolean;
  version?: string;
  path?: string;
  /** The H.264 encoder an export would be asked for, by name. */
  videoEncoder?: string;
  /** Every `xfade` transition the build knows; empty means unknown. */
  transitions: string[];
  /** Whether text can be burned in, which is whether `libass` is there. */
  ass: boolean;
  reason?: string;
}

/** Where a render has got to. */
export type ClipExportStatus =
  "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * One render, as it is polled.
 *
 * The handle is the whole of it: a render outlives the dialog that asked for
 * it, so what the dialog holds between openings is this record.
 */
export interface ClipExportTask {
  id: string;
  timelineId: TimelineId;
  status: ClipExportStatus;
  /** 0..1, never going backwards. */
  progress01: number;
  /** What went wrong, on the paths that went wrong. */
  message?: string;
  /** Where the finished file was written, once there is one: the reader's own
   * path, and the only copy the render makes. */
  savedTo?: string;
}

export const clipApi = {
  capabilities(signal?: AbortSignal): Promise<ClipCapabilities> {
    return http.request<ClipCapabilities>("/api/v1/clip/capabilities", {
      signal,
    });
  },

  /** Asks for one render to the path the reader named; the file it writes may
   * be minutes away. */
  start(
    timelineId: TimelineId,
    destination: string,
    signal?: AbortSignal,
  ): Promise<ClipExportTask> {
    return http.request<ClipExportTask>("/api/v1/clip/export", {
      method: "POST",
      body: { timelineId, destination },
      signal,
    });
  },

  status(id: string, signal?: AbortSignal): Promise<ClipExportTask> {
    return http.request<ClipExportTask>(
      `/api/v1/clip/export/${encodeURIComponent(id)}`,
      { signal },
    );
  },

  /** Asks a render to stop; one that already ended answers how it ended. */
  cancel(id: string, signal?: AbortSignal): Promise<ClipExportTask> {
    return http.request<ClipExportTask>(
      `/api/v1/clip/export/${encodeURIComponent(id)}`,
      { method: "DELETE", signal },
    );
  },
};
