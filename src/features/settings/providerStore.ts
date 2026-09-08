import { create } from "zustand";
import {
  isApiError,
  providersApi,
  type ChannelDraft,
  type DefaultsPatch,
  type ImportChannelRequest,
  type ModelCandidate,
  type PreferencesPatch,
  type ProbeReport,
  type ProvidersView,
} from "../../api";
import type { Capability } from "../../shared/domain";

export type SettingsTab = "channels" | "defaults" | "preferences";

/** A model is addressed through the channel that serves it. */
const REFERENCE_SEPARATOR = "::";

export function modelReference(channelId: string, modelId: string): string {
  return `${channelId}${REFERENCE_SEPARATOR}${modelId}`;
}

/**
 * Splits on the first separator only, so a model identifier that happens to
 * contain one still resolves to the channel it belongs to.
 */
export function splitModelReference(
  reference: string,
): { channelId: string; modelId: string } | null {
  const index = reference.indexOf(REFERENCE_SEPARATOR);
  if (index <= 0) return null;
  return {
    channelId: reference.slice(0, index),
    modelId: reference.slice(index + REFERENCE_SEPARATOR.length),
  };
}

export interface ModelOption {
  reference: string;
  label: string;
}

/**
 * The models a capability can be pointed at: those of enabled channels that
 * are themselves enabled and tagged with it.
 */
export function modelOptionsFor(
  view: ProvidersView | null,
  capability: Capability,
): ModelOption[] {
  if (!view) return [];
  return view.channels.flatMap((channel) =>
    channel.enabled
      ? channel.models
          .filter((model) => model.enabled && model.capability === capability)
          .map((model) => ({
            reference: modelReference(channel.id, model.id),
            label: `${channel.name} · ${model.alias || model.id}`,
          }))
      : [],
  );
}

/** What a per-channel read is doing, and what it last produced. */
export interface ChannelActivity {
  listing: boolean;
  probing: boolean;
  /** A listing is a suggestion for the form, never the stored model list. */
  candidates: ModelCandidate[] | null;
  probe: ProbeReport | null;
}

const IDLE: ChannelActivity = {
  listing: false,
  probing: false,
  candidates: null,
  probe: null,
};

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Provider settings: the stored configuration, and the dialog that edits it.
 *
 * Every write answers with the whole view, so state never has to be patched
 * field by field — and the revision it carries is what the next write is
 * checked against.
 */
interface ProviderState {
  open: boolean;
  tab: SettingsTab;
  view: ProvidersView | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  activity: Record<string, ChannelActivity>;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setTab: (tab: SettingsTab) => void;
  load: () => Promise<void>;
  saveChannel: (draft: ChannelDraft) => Promise<boolean>;
  removeChannel: (id: string) => Promise<boolean>;
  setKey: (id: string, apiKey: string | null) => Promise<boolean>;
  saveDefaults: (patch: DefaultsPatch) => Promise<boolean>;
  savePreferences: (patch: PreferencesPatch) => Promise<boolean>;
  listModels: (id: string) => Promise<void>;
  probe: (id: string) => Promise<void>;
  importChannel: (request: ImportChannelRequest) => Promise<boolean>;
  reset: () => void;
}

export const useProviderStore = create<ProviderState>()((set, get) => {
  const withActivity = (
    id: string,
    patch: Partial<ChannelActivity>,
    extra: Partial<ProviderState> = {},
  ) => {
    set((state) => ({
      ...extra,
      activity: {
        ...state.activity,
        [id]: { ...(state.activity[id] ?? IDLE), ...patch },
      },
    }));
  };

  /**
   * Runs a write, adopting the view it returns.
   *
   * The revision is filled in here rather than at the call sites: it is a
   * property of the state this store holds, and a form that had to remember to
   * send it would eventually forget. A refused write refreshes the view first
   * and reports second, so the message describes state the user can now see.
   */
  const write = async (
    fallback: string,
    send: (revision: number | null) => Promise<ProvidersView>,
  ): Promise<boolean> => {
    set({ saving: true, error: null });
    try {
      set({ view: await send(get().view?.revision ?? null), saving: false });
      return true;
    } catch (error) {
      set({ saving: false });
      if (isApiError(error, "METADATA_CONFLICT")) await get().load();
      set({ error: describe(error, fallback) });
      return false;
    }
  };

  return {
    open: false,
    tab: "channels",
    view: null,
    loading: false,
    saving: false,
    error: null,
    activity: {},

    openSettings(tab = "channels") {
      set({ open: true, tab });
    },

    closeSettings() {
      set({ open: false });
    },

    setTab(tab) {
      set({ tab });
    },

    async load() {
      if (get().loading) return;
      set({ loading: true });
      try {
        set({ view: await providersApi.list(), loading: false, error: null });
      } catch (error) {
        set({
          loading: false,
          error: describe(error, "Failed to load settings"),
        });
      }
    },

    saveChannel(draft) {
      return write("Failed to save the channel", (revision) =>
        providersApi.upsertChannel({ ...draft, expectedRevision: revision }),
      );
    },

    removeChannel(id) {
      return write("Failed to remove the channel", (revision) =>
        providersApi.deleteChannel(id, revision ?? undefined),
      ).then((saved) => {
        if (saved) {
          set((state) => {
            const activity = { ...state.activity };
            delete activity[id];
            return { activity };
          });
        }
        return saved;
      });
    },

    setKey(id, apiKey) {
      return write("Failed to update the credential", () =>
        providersApi.setKey(id, apiKey),
      );
    },

    saveDefaults(patch) {
      return write("Failed to save the defaults", (revision) =>
        providersApi.setDefaults({ ...patch, expectedRevision: revision }),
      );
    },

    savePreferences(patch) {
      return write("Failed to save the preferences", (revision) =>
        providersApi.setPreferences({ ...patch, expectedRevision: revision }),
      );
    },

    async listModels(id) {
      withActivity(id, { listing: true });
      try {
        const candidates = await providersApi.fetchModels(id);
        withActivity(id, { listing: false, candidates }, { error: null });
      } catch (error) {
        withActivity(id, { listing: false });
        set({ error: describe(error, "Failed to list the channel's models") });
      }
    },

    async probe(id) {
      withActivity(id, { probing: true });
      try {
        const probe = await providersApi.probe(id);
        withActivity(id, { probing: false, probe }, { error: null });
      } catch (error) {
        withActivity(id, { probing: false });
        set({ error: describe(error, "Failed to reach the channel") });
      }
    },

    importChannel(request) {
      return write("Failed to add the channel", (revision) =>
        providersApi.importChannel({ ...request, expectedRevision: revision }),
      );
    },

    reset() {
      set({
        open: false,
        tab: "channels",
        view: null,
        loading: false,
        saving: false,
        error: null,
        activity: {},
      });
    },
  };
});
