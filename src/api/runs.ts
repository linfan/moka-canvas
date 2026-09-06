import type { CanvasId, NodeId, RunId, RunRecord } from "../shared/domain";
import { http } from "./client";

export const runsApi = {
  list(signal?: AbortSignal): Promise<RunRecord[]> {
    return http.request<RunRecord[]>("/api/v1/projects/current/runs", {
      signal,
    });
  },

  get(id: RunId, signal?: AbortSignal): Promise<RunRecord> {
    return http.request<RunRecord>(`/api/v1/projects/current/runs/${id}`, {
      signal,
    });
  },

  start(canvasId: CanvasId, nodeIds: NodeId[]): Promise<RunRecord> {
    return http.request<RunRecord>("/api/v1/projects/current/runs", {
      method: "POST",
      body: { canvasId, nodeIds },
    });
  },

  cancel(id: RunId): Promise<RunRecord> {
    return http.request<RunRecord>(
      `/api/v1/projects/current/runs/${id}/cancel`,
      { method: "POST" },
    );
  },

  retry(id: RunId): Promise<RunRecord> {
    return http.request<RunRecord>(
      `/api/v1/projects/current/runs/${id}/retry`,
      { method: "POST" },
    );
  },
};
