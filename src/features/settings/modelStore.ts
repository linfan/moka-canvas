import { create } from "zustand";
import {
  isApiError,
  modelsApi,
  type DefaultsPatch,
  type ModelDraft,
  type ModelsView,
  type PreferencesPatch,
  type ProtocolGroups,
  type SecretStorageChoice,
} from "../../api";
import {
  PROTOCOLS_BY_CATEGORY,
  PROTOCOL_LABELS,
  PROTOCOL_URL_EXAMPLES,
  type Capability,
  type ModelProtocol,
} from "../../shared/domain";
import { i18n } from "../../shared/i18n";

/** The settings tabs: one per model category, plus the global preferences. */
export type SettingsTab = Capability | "preferences";

/**
 * A place a model may be made the default of. `music` is the odd one out: not a
 * category of its own, but the audio model a telling's score is composed with
 * rather than the one that reads its lines aloud.
 */
export type DefaultPlace = Capability | "music";

/** The three top-level settings sections: the open project, models, the system. */
export type SettingsTopTab = "project" | "model" | "system";

export interface ModelOption {
  /** The model configuration's own id, which is what a node stores. */
  reference: string;
  label: string;
}

/**
 * The models a category can be pointed at: the enabled configurations of
 * that category, labelled by the display name somebody chose.
 */
export function modelOptionsFor(
  view: ModelsView | null,
  capability: Capability,
): ModelOption[] {
  if (!view) return [];
  return view.models
    .filter((model) => model.enabled && model.category === capability)
    .map((model) => ({ reference: model.id, label: model.displayName }));
}

/**
 * The default a category actually generates with: the stored choice while it
 * still names an enabled model of the category, and the first enabled model
 * otherwise. This mirrors the server's own fallback, so what the list shows
 * as the default is what a node naming no model of its own gets.
 */
export function effectiveDefaultId(
  view: ModelsView | null,
  capability: Capability,
): string | null {
  if (!view) return null;
  const serving = view.models.filter(
    (model) => model.enabled && model.category === capability,
  );
  const stored = view.defaults[capability];
  if (stored !== null && serving.some((model) => model.id === stored)) {
    return stored;
  }
  return serving[0]?.id ?? null;
}

/**
 * The audio model a telling's score is composed with: the stored choice while
 * it still names an enabled model of that category, and none otherwise. None
 * is not a refusal — the server answers a score from the audio default when no
 * music model was chosen, and the tab says as much.
 */
export function musicDefaultId(view: ModelsView | null): string | null {
  if (!view) return null;
  const stored = view.defaults.music;
  if (stored === null) return null;
  const serves = view.models.some(
    (model) =>
      model.id === stored && model.enabled && model.category === "audio",
  );
  return serves ? stored : null;
}

/** One protocol the form may offer for a category. */
export interface ProtocolChoice {
  id: string;
  label: string;
  urlExample: string;
}

/**
 * The protocols a category offers: the built-ins, then the registry's scripts.
 *
 * A built-in is implemented by this program, so it is offered whether or not a
 * script stands beside it; what the registry contributes is the scripts
 * deployed on this machine, which may be ones this build has never heard of.
 * Built-in ids keep their familiar order and go first — with the registry's
 * own label and address example where it holds one, since a deployment may
 * point its own script at another region — and the scripts beyond them follow,
 * alphabetically by the name a reader picks one by. While the registry has not
 * arrived — or the read failed — a built-in falls back to the name and address
 * this build knows it by, so the form is never empty.
 */
export function protocolChoices(
  protocols: ProtocolGroups | null,
  capability: Capability,
): ProtocolChoice[] {
  const group = protocols?.[capability];
  const builtin = PROTOCOLS_BY_CATEGORY[capability];
  if (!group) {
    return builtin.map((id) => ({
      id,
      label: i18n.t(PROTOCOL_LABELS[id]),
      urlExample: PROTOCOL_URL_EXAMPLES[id],
    }));
  }
  const extra = Object.keys(group)
    .filter((id) => !builtin.includes(id as ModelProtocol))
    .sort((a, b) => group[a].displayName.localeCompare(group[b].displayName));
  return [...builtin, ...extra].map((id) => ({
    id,
    label: protocolLabel(protocols, id),
    urlExample: protocolUrlExample(protocols, id),
  }));
}

/** What a protocol is called, registry first and its bare id last. */
export function protocolLabel(
  protocols: ProtocolGroups | null,
  id: string,
): string {
  const entry = findProtocol(protocols, id);
  if (entry) return entry.displayName;
  const label = PROTOCOL_LABELS[id as ModelProtocol];
  return label ? i18n.t(label) : id;
}

/** The example address a protocol speaks at, empty when none is known. */
export function protocolUrlExample(
  protocols: ProtocolGroups | null,
  id: string,
): string {
  const entry = findProtocol(protocols, id);
  if (entry) return entry.urlExample;
  return PROTOCOL_URL_EXAMPLES[id as ModelProtocol] ?? "";
}

function findProtocol(protocols: ProtocolGroups | null, id: string) {
  if (!protocols) return undefined;
  for (const group of Object.values(protocols)) {
    if (group[id]) return group[id];
  }
  return undefined;
}

/**
 * Codes whose fix is not in this dialog. The server's message says what is
 * wrong; this says what to do about it, because the remedy is a shell command
 * and a restart that no control here can perform.
 */
const GUIDANCE: Record<string, string> = {
  CONFIG_METADATA_KEY_MISSING: "settings:guidance.configMetadataKeyMissing",
};

/** How to act on a failure whose code is known, if there is anything to add. */
export function guidanceFor(code: string | null): string | null {
  if (code === null) return null;
  const key = GUIDANCE[code];
  return key ? i18n.t(key) : null;
}

/** The two fields every failure sets on the store. */
interface Failure {
  error: string;
  errorCode: string | null;
}

function describe(error: unknown, fallback: string): Failure {
  return {
    error: error instanceof Error ? error.message : fallback,
    errorCode: isApiError(error) ? error.code : null,
  };
}

/**
 * Model settings: the stored configuration, and the dialog that edits it.
 *
 * Every write answers with the whole view, so state never has to be patched
 * field by field — and the revision it carries is what the next write is
 * checked against.
 */
interface ModelState {
  open: boolean;
  /** Which top-level section the dialog shows. */
  topTab: SettingsTopTab;
  tab: SettingsTab;
  /** Which model the editor is open on: an id, "new", or null for the list. */
  editing: string | "new" | null;
  /** The category a "new" editor starts on. */
  newCategory: Capability;
  /**
   * The configuration a "new" editor is a copy of. The copy is a draft like
   * any other: nothing is stored until the form saves, and the identifier is
   * a suggestion the form is free to overwrite until then.
   */
  copyOf: string | null;
  view: ModelsView | null;
  /**
   * The converter registry's protocols, grouped by capability. Null until
   * the read lands — or forever, if it failed, and the built-in list stands
   * in. Re-read whenever settings opens: a converter is added by dropping a
   * directory into the models tree, and that happens while the app runs.
   */
  protocols: ProtocolGroups | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** The problem code behind `error`, so the dialog can explain the fix. */
  errorCode: string | null;
  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setTopTab: (topTab: SettingsTopTab) => void;
  setTab: (tab: SettingsTab) => void;
  editModel: (id: string) => void;
  newModel: (category: Capability) => void;
  closeEditor: () => void;
  /**
   * Opens settings on the category that matters for a node: the tab of the
   * model it named if that still exists, otherwise the category's own tab,
   * ready to add one.
   */
  openModelForCapability: (
    capability: Capability,
    reference?: string | null,
  ) => void;
  load: () => Promise<void>;
  /** Reads the registry's protocols. `force` re-reads one already held. */
  loadProtocols: (force?: boolean) => Promise<void>;
  saveModel: (draft: ModelDraft) => Promise<boolean>;
  removeModel: (id: string) => Promise<boolean>;
  /** Opens a new-model editor pre-filled as a copy of one configuration. */
  duplicateModel: (id: string) => void;
  setKey: (id: string, apiKey: string | null) => Promise<boolean>;
  /** Moves the master key protecting every stored credential to another tier. */
  setSecretStorage: (storage: SecretStorageChoice) => Promise<boolean>;
  /** Makes one model the default of a place, or clears that place. */
  setDefault: (place: DefaultPlace, id: string | null) => Promise<boolean>;
  savePreferences: (patch: PreferencesPatch) => Promise<boolean>;
  reset: () => void;
}

export const useModelStore = create<ModelState>()((set, get) => {
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
    send: (revision: number | null) => Promise<ModelsView>,
  ): Promise<boolean> => {
    set({ saving: true, error: null, errorCode: null });
    try {
      set({ view: await send(get().view?.revision ?? null), saving: false });
      return true;
    } catch (error) {
      set({ saving: false });
      if (isApiError(error, "METADATA_CONFLICT")) await get().load();
      set(describe(error, fallback));
      return false;
    }
  };

  return {
    open: false,
    topTab: "model",
    tab: "text",
    editing: null,
    newCategory: "text",
    copyOf: null,
    view: null,
    protocols: null,
    loading: false,
    saving: false,
    error: null,
    errorCode: null,

    openSettings(tab = "text") {
      // The registry read rides along, so a converter directory added since
      // the last open is on offer by the time a tab is picked.
      void get().loadProtocols(true);
      set({ open: true, topTab: "model", tab });
    },

    closeSettings() {
      // Back to the list on the next open: an editor left open on a model is
      // a surprise to whoever opens settings for something else.
      set({ open: false, editing: null, copyOf: null });
    },

    setTopTab(topTab) {
      // The model editor belongs to the Model section; leaving it behind
      // closes it, the same way switching a category tab does.
      set({ topTab, editing: null, copyOf: null });
    },

    setTab(tab) {
      set({ tab, editing: null, copyOf: null });
    },

    editModel(id) {
      const view = get().view;
      const category =
        view?.models.find((model) => model.id === id)?.category ?? get().tab;
      set({
        open: true,
        topTab: "model",
        tab: category === "preferences" ? "text" : category,
        editing: id,
        copyOf: null,
      });
    },

    newModel(category) {
      set({
        open: true,
        topTab: "model",
        tab: category,
        newCategory: category,
        editing: "new",
        copyOf: null,
      });
    },

    closeEditor() {
      set({ editing: null, copyOf: null });
    },

    openModelForCapability(capability, reference = null) {
      const view = get().view;
      const models = view?.models ?? [];
      const known =
        reference !== null && models.some((model) => model.id === reference);
      // Straight to the model a node named when it still exists, so the thing
      // that would serve the node is the thing the editor opens on.
      set({
        open: true,
        topTab: "model",
        tab: capability,
        editing: known ? reference : null,
        copyOf: null,
      });
    },

    async load() {
      if (get().loading) return;
      set({ loading: true });
      try {
        set({
          view: await modelsApi.list(),
          loading: false,
          error: null,
          errorCode: null,
        });
      } catch (error) {
        set({
          loading: false,
          ...describe(error, i18n.t("settings:errors.load")),
        });
      }
    },

    async loadProtocols(force = false) {
      if (!force && get().protocols !== null) return;
      try {
        const response = await modelsApi.fetchProtocols();
        set({ protocols: response.protocols });
      } catch {
        // Quiet on purpose: the form falls back to the built-in list, and
        // a settings dialog that cannot save says so loudly enough.
      }
    },

    saveModel(draft) {
      return write(i18n.t("settings:errors.saveModel"), (revision) =>
        modelsApi.upsert({ ...draft, expectedRevision: revision }),
      );
    },

    removeModel(id) {
      return write(i18n.t("settings:errors.removeModel"), (revision) =>
        modelsApi.remove(id, revision ?? undefined),
      );
    },

    duplicateModel(id) {
      const source = (get().view?.models ?? []).find(
        (model) => model.id === id,
      );
      if (!source) return;
      // The copy is a draft, not a write: the point of duplicating is to
      // change something before it exists — the identifier above all — so
      // nothing is stored until the form saves, and an abandoned copy leaves
      // nothing behind.
      set({
        open: true,
        topTab: "model",
        tab: source.category,
        newCategory: source.category,
        editing: "new",
        copyOf: id,
      });
    },

    setKey(id, apiKey) {
      return write(i18n.t("settings:errors.updateKey"), () =>
        modelsApi.setKey(id, apiKey),
      );
    },

    setSecretStorage(storage) {
      return write(i18n.t("settings:errors.switchStorage"), () =>
        modelsApi.setSecretStorage(storage),
      );
    },

    setDefault(place, id) {
      const patch: DefaultsPatch = { [place]: id };
      return write(i18n.t("settings:errors.saveDefault"), (revision) =>
        modelsApi.setDefaults({ ...patch, expectedRevision: revision }),
      );
    },

    savePreferences(patch) {
      return write(i18n.t("settings:errors.savePreferences"), (revision) =>
        modelsApi.setPreferences({ ...patch, expectedRevision: revision }),
      );
    },

    reset() {
      set({
        open: false,
        topTab: "model",
        tab: "text",
        editing: null,
        newCategory: "text",
        copyOf: null,
        view: null,
        loading: false,
        saving: false,
        error: null,
        errorCode: null,
      });
    },
  };
});
