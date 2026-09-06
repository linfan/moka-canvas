import { create } from "zustand";
import {
  applyCommands as applyToDocument,
  CommandError,
  nextCanvasName,
  type AssetCategory,
  type AssetId,
  type CanvasId,
  type DocumentCommand,
  type MokaFile,
  type ResourceEntry,
  type SelfCheckReport,
} from "../../../shared/domain";
import {
  projectsApi,
  type OpenProjectResult,
  type SaveResult,
} from "../../../api/projects";
import { isApiError } from "../../../api/client";

export type SaveStatus = "saved" | "saving" | "conflicted" | "error";

interface ProjectState {
  root: string | null;
  moka: MokaFile | null;
  activeCanvasId: CanvasId | null;
  selfCheck: SelfCheckReport | null;
  saveStatus: SaveStatus;
  saveError: string | null;
  /** Optimistically applied commands not yet acknowledged by the server. */
  pending: DocumentCommand[];

  hydrate: (opened: OpenProjectResult) => SelfCheckReport;
  open: (path: string) => Promise<SelfCheckReport>;
  create: (directory: string, name: string) => Promise<SelfCheckReport>;
  importFromPath: (
    archivePath: string,
    directory: string,
    name?: string,
  ) => Promise<SelfCheckReport>;
  importUpload: (
    file: File,
    directory: string,
    name?: string,
    onProgress?: (fraction: number) => void,
  ) => Promise<SelfCheckReport>;
  reload: () => Promise<void>;
  close: () => void;

  switchCanvas: (canvasId: CanvasId) => void;
  applyLocal: (commands: DocumentCommand[]) => DocumentCommand[];
  flush: () => Promise<void>;
  integrateSaveResult: (result: SaveResult) => void;
  /** Replaces the open-time self-check report (e.g. after a located replacement). */
  setSelfCheck: (report: SelfCheckReport) => void;
  /** Folds a server-side asset upload/replace into the local registry. */
  integrateAssetEntry: (entry: ResourceEntry, result: SaveResult) => void;
  /** Folds a server-side asset removal into the local registry. */
  removeAssetEntry: (assetId: AssetId, result: SaveResult) => void;
}

const FLUSH_DEBOUNCE_MS = 400;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function activeCanvasOf(moka: MokaFile, activeCanvasId: CanvasId | null) {
  return (
    moka.canvas.find((canvas) => canvas.id === activeCanvasId) ??
    moka.canvas[0] ??
    null
  );
}

export const useProjectStore = create<ProjectState>()((set, get) => {
  const scheduleFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void get().flush();
    }, FLUSH_DEBOUNCE_MS);
  };

  return {
    root: null,
    moka: null,
    activeCanvasId: null,
    selfCheck: null,
    saveStatus: "saved",
    saveError: null,
    pending: [],

    hydrate(opened) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      set({
        root: opened.root,
        moka: opened.moka,
        activeCanvasId: opened.moka.canvas[0]?.id ?? null,
        selfCheck: opened.selfCheck,
        saveStatus: "saved",
        saveError: null,
        pending: [],
      });
      return opened.selfCheck;
    },

    async open(path) {
      return get().hydrate(await projectsApi.open(path));
    },

    async create(directory, name) {
      return get().hydrate(await projectsApi.create(directory, name));
    },

    async importFromPath(archivePath, directory, name) {
      return get().hydrate(
        await projectsApi.importFromPath(archivePath, directory, name),
      );
    },

    async importUpload(file, directory, name, onProgress) {
      return get().hydrate(
        await projectsApi.importUpload(file, directory, name, onProgress),
      );
    },

    async reload() {
      const opened = await projectsApi.current();
      get().hydrate(opened);
    },

    close() {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      set({
        root: null,
        moka: null,
        activeCanvasId: null,
        selfCheck: null,
        saveStatus: "saved",
        saveError: null,
        pending: [],
      });
    },

    switchCanvas(canvasId) {
      const { moka } = get();
      if (!moka || !moka.canvas.some((canvas) => canvas.id === canvasId))
        return;
      set({ activeCanvasId: canvasId });
    },

    applyLocal(commands) {
      const { moka, saveStatus } = get();
      if (!moka) {
        throw new CommandError("PROJECT_NOT_OPEN", "No project is open");
      }
      if (saveStatus === "conflicted") {
        throw new CommandError(
          "REVISION_CONFLICT",
          "Resolve the save conflict before making more changes",
        );
      }
      const { next, inverse } = applyToDocument(moka, commands);
      set((state) => ({
        moka: next,
        pending: [...state.pending, ...commands],
      }));
      scheduleFlush();
      return inverse;
    },

    async flush() {
      const { moka, pending, saveStatus } = get();
      if (!moka || pending.length === 0 || saveStatus === "conflicted") return;
      const batch = pending;
      set({ saveStatus: "saving", saveError: null });
      try {
        const result = await projectsApi.applyCommands(
          moka.metadata.revision,
          batch,
        );
        set((state) => {
          const remaining = state.pending.slice(batch.length);
          return {
            saveStatus: "saved",
            pending: remaining,
            moka: state.moka
              ? {
                  ...state.moka,
                  metadata: {
                    ...state.moka.metadata,
                    revision: result.revision,
                    updatedAt: result.updatedAt,
                  },
                }
              : null,
          };
        });
        if (get().pending.length > 0) scheduleFlush();
      } catch (error) {
        if (isApiError(error, "REVISION_CONFLICT")) {
          // Stop autosave; the user chooses reload or export-local-copy.
          set({ saveStatus: "conflicted" });
        } else {
          set({
            saveStatus: "error",
            saveError: error instanceof Error ? error.message : "Saving failed",
          });
          // Transient failures retry on the next change; keep the batch queued.
        }
      }
    },

    setSelfCheck(report) {
      set({ selfCheck: report });
    },

    integrateSaveResult(result) {
      set((state) => ({
        moka: state.moka
          ? {
              ...state.moka,
              metadata: {
                ...state.moka.metadata,
                revision: result.revision,
                updatedAt: result.updatedAt,
              },
            }
          : null,
      }));
    },

    integrateAssetEntry(entry, result) {
      const category = entry.path.split("/")[1] as AssetCategory | undefined;
      set((state) => {
        if (!state.moka || !category || !(category in state.moka.resources)) {
          return state;
        }
        const list = state.moka.resources[category];
        const index = list.findIndex((item) => item.id === entry.id);
        const nextList =
          index === -1
            ? [...list, entry]
            : list.map((item) => (item.id === entry.id ? entry : item));
        return {
          moka: {
            ...state.moka,
            metadata: {
              ...state.moka.metadata,
              revision: result.revision,
              updatedAt: result.updatedAt,
            },
            resources: { ...state.moka.resources, [category]: nextList },
          },
        };
      });
    },

    removeAssetEntry(assetId, result) {
      set((state) => {
        if (!state.moka) return state;
        const resources = { ...state.moka.resources };
        for (const category of Object.keys(resources) as AssetCategory[]) {
          resources[category] = resources[category].filter(
            (entry) => entry.id !== assetId,
          );
        }
        return {
          moka: {
            ...state.moka,
            metadata: {
              ...state.moka.metadata,
              revision: result.revision,
              updatedAt: result.updatedAt,
            },
            resources,
          },
        };
      });
    },
  };
});

export function useActiveCanvas() {
  return useProjectStore((state) =>
    state.moka ? activeCanvasOf(state.moka, state.activeCanvasId) : null,
  );
}

export { nextCanvasName };
