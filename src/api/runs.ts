import type { RunRecord } from "../shared/domain";
import { http } from "./client";

export const runsApi = {
  list(signal?: AbortSignal): Promise<RunRecord[]> {
    return http.request<RunRecord[]>("/api/v1/projects/current/runs", {
      signal,
    });
  },
};
