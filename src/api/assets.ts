import type { AssetCategory, AssetId, ResourceEntry } from "../shared/domain";
import { http } from "./client";
import type { SaveResult } from "./projects";

/** Asset mutations persist server-side, so they echo the new revision. */
export interface AssetChange {
  entry: ResourceEntry;
  revision: number;
  updatedAt: string;
}

export interface UploadOptions {
  categoryHint?: AssetCategory;
  signal?: AbortSignal;
  onUploadProgress?: (fraction: number) => void;
}

export const assetsApi = {
  upload(file: File, options: UploadOptions = {}): Promise<AssetChange> {
    const formData = new FormData();
    if (options.categoryHint)
      formData.set("categoryHint", options.categoryHint);
    formData.set("file", file, file.name);
    return http.request<AssetChange>("/api/v1/projects/current/assets", {
      method: "POST",
      formData,
      signal: options.signal,
      onUploadProgress: options.onUploadProgress,
    });
  },

  replace(
    id: AssetId,
    file: File,
    options: UploadOptions = {},
  ): Promise<AssetChange> {
    const formData = new FormData();
    formData.set("file", file, file.name);
    return http.request<AssetChange>(
      `/api/v1/projects/current/assets/${id}/content`,
      { method: "PUT", formData, signal: options.signal },
    );
  },

  remove(id: AssetId): Promise<SaveResult> {
    return http.request<SaveResult>(`/api/v1/projects/current/assets/${id}`, {
      method: "DELETE",
    });
  },

  /** Opens the asset file in the OS file manager. */
  reveal(id: AssetId): Promise<void> {
    return http.request<void>(`/api/v1/projects/current/assets/${id}/reveal`, {
      method: "POST",
    });
  },
};

/** Same-origin streaming URL for an asset of the currently open project. */
export function assetUrl(id: AssetId): string {
  return `/api/v1/projects/current/assets/${id}`;
}
