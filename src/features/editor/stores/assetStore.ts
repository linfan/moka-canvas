import { create } from "zustand";
import { assetsApi, assetUrl, type AssetChange } from "../../../api/assets";
import { isApiError } from "../../../api/client";
import type {
  AssetCategory,
  AssetId,
  ResourceEntry,
} from "../../../shared/domain";
import { useProjectStore } from "./projectStore";

export interface UploadJob {
  id: number;
  name: string;
  progress: number;
  status: "uploading" | "error" | "done";
  error?: string;
}

interface AssetState {
  uploads: UploadJob[];
  upload: (
    file: File,
    options?: { categoryHint?: AssetCategory },
  ) => Promise<ResourceEntry | null>;
  replace: (assetId: AssetId, file: File) => Promise<ResourceEntry | null>;
  remove: (assetId: AssetId) => Promise<boolean>;
  previewUrl: (assetId: AssetId) => string;
  dismissUpload: (id: number) => void;
}

let nextUploadId = 1;

export const useAssetStore = create<AssetState>()((set) => ({
  uploads: [],

  async upload(file, options = {}) {
    const id = nextUploadId++;
    const job: UploadJob = {
      id,
      name: file.name,
      progress: 0,
      status: "uploading",
    };
    set((state) => ({ uploads: [...state.uploads, job] }));
    try {
      const change: AssetChange = await assetsApi.upload(file, {
        categoryHint: options.categoryHint,
        onUploadProgress: (progress) =>
          set((state) => ({
            uploads: state.uploads.map((item) =>
              item.id === id ? { ...item, progress } : item,
            ),
          })),
      });
      useProjectStore.getState().integrateAssetEntry(change.entry, change);
      set((state) => ({
        uploads: state.uploads.map((item) =>
          item.id === id ? { ...item, progress: 1, status: "done" } : item,
        ),
      }));
      return change.entry;
    } catch (error) {
      set((state) => ({
        uploads: state.uploads.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "error",
                error: error instanceof Error ? error.message : "Upload failed",
              }
            : item,
        ),
      }));
      return null;
    }
  },

  async replace(assetId, file) {
    try {
      const change = await assetsApi.replace(assetId, file);
      useProjectStore.getState().integrateAssetEntry(change.entry, change);
      return change.entry;
    } catch {
      return null;
    }
  },

  async remove(assetId) {
    try {
      const result = await assetsApi.remove(assetId);
      useProjectStore.getState().removeAssetEntry(assetId, result);
      return true;
    } catch (error) {
      if (isApiError(error, "ASSET_IN_USE")) return false;
      throw error;
    }
  },

  previewUrl(assetId) {
    return assetUrl(assetId);
  },

  dismissUpload(id) {
    set((state) => ({ uploads: state.uploads.filter((job) => job.id !== id) }));
  },
}));

export function useUploads(): UploadJob[] {
  return useAssetStore((state) => state.uploads);
}
