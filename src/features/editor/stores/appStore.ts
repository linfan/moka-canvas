import { create } from "zustand";
import {
  fetchHealth,
  fetchPublicConfig,
  type PublicConfig,
} from "../../../api";
import { PROVIDER_EXECUTOR_KEY } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";

export type AppPhase =
  "booting" | "launcher" | "opening" | "editing" | "clip" | "story" | "error";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
  /**
   * Where choosing the toast goes, for a report of something that has a place.
   * A toast is read and gone in a few seconds, so a reader who wants to see the
   * thing it named should not have to remember where it was put; the label is
   * what tells them choosing it leads somewhere rather than only away.
   */
  choice?: { label: string; go: () => void };
}

interface AppState {
  phase: AppPhase;
  config: PublicConfig | null;
  bootError: string | null;
  toasts: Toast[];
  boot: () => Promise<void>;
  setPhase: (phase: AppPhase) => void;
  pushToast: (
    kind: Toast["kind"],
    message: string,
    choice?: Toast["choice"],
  ) => void;
  dismissToast: (id: number) => void;
}

let nextToastId = 1;

export const useAppStore = create<AppState>()((set, get) => ({
  phase: "booting",
  config: null,
  bootError: null,
  toasts: [],

  async boot() {
    set({ phase: "booting", bootError: null });
    try {
      const [config] = await Promise.all([fetchPublicConfig(), fetchHealth()]);
      set({ config, phase: "launcher" });
    } catch (error) {
      set({
        phase: "error",
        bootError:
          error instanceof Error
            ? error.message
            : i18n.t("editor:stores.localProcessUnreachable"),
      });
    }
  },

  setPhase(phase) {
    set({ phase });
  },

  pushToast(kind, message, choice) {
    const id = nextToastId++;
    set((state) => ({
      toasts: [...state.toasts, { id, kind, message, choice }],
    }));
    setTimeout(() => get().dismissToast(id), 6000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

/**
 * Whether this deployment will drive a generation node at all.
 *
 * Read from the executor list the server publishes rather than from an offline
 * switch of the client's own: the server validates a run against that same list,
 * so a control offered here and refused there is a click whose only product is
 * an error. Nothing known yet reads as available, because a control that is dead
 * until the config arrives fails for no reason a user can see.
 */
export function useGenerationAvailable(): boolean {
  return useAppStore(
    (state) =>
      state.config === null ||
      state.config.capabilities.executors.includes(PROVIDER_EXECUTOR_KEY),
  );
}

/**
 * Why a generation control is dead where nothing can reach a provider.
 *
 * Read at each use rather than once, so a reader who switches the interface
 * language hears the new one without a reload.
 */
export function generationUnavailable(): string {
  return i18n.t("editor:stores.generationUnavailable");
}
