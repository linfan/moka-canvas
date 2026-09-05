import { create } from "zustand";
import {
  fetchHealth,
  fetchPublicConfig,
  type PublicConfig,
} from "../../../api";

export type AppPhase = "booting" | "launcher" | "opening" | "editing" | "error";

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

interface AppState {
  phase: AppPhase;
  config: PublicConfig | null;
  bootError: string | null;
  toasts: Toast[];
  boot: () => Promise<void>;
  setPhase: (phase: AppPhase) => void;
  pushToast: (kind: Toast["kind"], message: string) => void;
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
            : "The local process could not be reached",
      });
    }
  },

  setPhase(phase) {
    set({ phase });
  },

  pushToast(kind, message) {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), 6000);
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));
