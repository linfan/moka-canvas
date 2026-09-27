import type { Capability } from "../shared/domain";
import { http } from "./client";

/**
 * What may be disclosed about a stored credential. The server never sends
 * anything else, so there is no plaintext here to leak into state or a log.
 */
export interface ApiKeyView {
  set: boolean;
  masked: string | null;
  /** When the credential was last replaced; null when none is stored. */
  rotatedAt?: string | null;
}

/**
 * One model, configured on its own: a category, a protocol from the list that
 * category offers, the complete endpoint URL, the model name the provider
 * knows, and a display name. There is no provider grouping.
 */
export interface ModelView {
  id: string;
  category: Capability;
  /**
   * The protocol's wire name, which is the id of the converter directory that
   * serves it — a name read from disk rather than a union this build knows,
   * so a converter added later is one a stored model can speak.
   */
  protocol: string;
  /** The full endpoint address requests are sent to — not a base URL. */
  url: string;
  /** The model name the provider knows, sent in the body where one travels. */
  model: string;
  displayName: string;
  /**
   * The longest one clip this model films, when the deployment knows it. Absent
   * or null leaves the app's own ceiling standing in for it; a telling filmed
   * in pieces is cut to this length.
   */
  maxVideoSeconds?: number | null;
  enabled: boolean;
  apiKey: ApiKeyView;
}

/**
 * The default model of each category, by model configuration id — plus the one
 * choice that is not a category of its own: the audio model that composes a
 * telling's score rather than reading its lines aloud.
 */
export type ModelDefaults = Record<Capability, string | null> & {
  music: string | null;
};

export interface ImagePreferences {
  size: string;
  quality: string;
  background: string;
  count: number;
}

export interface VideoPreferences {
  seconds: number;
  resolution: string;
  generateAudio: boolean;
  watermark: boolean;
  mode: string;
  ratio: string;
}

export interface AudioPreferences {
  voice: string;
  format: string;
  speed: number;
  instructions: string;
  sampleRate: number;
  volume: number;
  rate: number;
  pitch: number;
}

/**
 * What the story room cuts a telling to, in characters: the manuscript one
 * chapter is written from, and the chapters one reading is asked about.
 */
export interface StoryPreferences {
  splitChars: number;
  readChars: number;
}

/** Global generation defaults; a node's own parameters override these. */
export interface GenerationPreferences {
  systemPrompt: string;
  reasoningEffort: string;
  image: ImagePreferences;
  video: VideoPreferences;
  audio: AudioPreferences;
  story: StoryPreferences;
}

/**
 * Where the master key protecting the stored credentials lives. `unset` means
 * no credential has ever been stored, so no key was needed yet.
 */
export type SecretStorageTier = "keyring" | "file" | "env" | "unset";

/** The tiers a deployment can switch between: file always, keyring where the runtime has one. */
export type SecretStorageChoice = "keyring" | "file";

export interface ModelsView {
  version: number;
  revision: number;
  models: ModelView[];
  defaults: ModelDefaults;
  preferences: GenerationPreferences;
  secretStorage: SecretStorageTier;
  /** The tiers this runtime can offer for the master key. */
  secretStorageOptions?: SecretStorageChoice[];
  /** The tier a new master key would be created in. */
  secretStoragePref?: SecretStorageChoice;
}

export interface ModelDraft {
  id: string;
  category: Capability;
  protocol: string;
  url: string;
  model: string;
  displayName: string;
  /** A video model's own clip ceiling; null or omitted means none is kept. */
  maxVideoSeconds?: number | null;
  enabled: boolean;
  expectedRevision?: number | null;
  /**
   * Omit or leave blank to keep the stored credential. Clearing one is a
   * separate call, so an unrelated edit cannot cost a working key.
   */
  apiKey?: string | null;
  /**
   * The configuration a new one copies its credential from: the client never
   * sees a stored key, so a copy names where to take it from. Honoured on a
   * creation only — an edit keeps the key it has.
   */
  copyKeyFrom?: string | null;
}

export interface DefaultsPatch {
  text?: string | null;
  image?: string | null;
  audio?: string | null;
  music?: string | null;
  video?: string | null;
  asr?: string | null;
  expectedRevision?: number | null;
}

/** A group is replaced whole; a field left out keeps its stored value. */
export interface PreferencesPatch {
  systemPrompt?: string;
  reasoningEffort?: string;
  image?: ImagePreferences;
  video?: VideoPreferences;
  audio?: AudioPreferences;
  story?: StoryPreferences;
  expectedRevision?: number | null;
}

function modelPath(id: string, suffix = ""): string {
  return `/api/v1/models/${encodeURIComponent(id)}${suffix}`;
}

/**
 * One protocol entry from the converter registry. The capability it serves
 * is the key its group hangs under, not a field of its own.
 */
export interface ProtocolEntry {
  script: string;
  /** What the converter calls itself, in English. */
  displayName: string;
  /** What it calls itself in other languages, keyed by language tag. */
  labels?: Record<string, string>;
  urlExample: string;
  /** Where it sits among the protocols of its capability, ascending. */
  order?: number;
  /** Where its credential travels, as the document declared it. */
  auth?: { header: string; scheme: string };
  /**
   * What it declares about itself beyond speaking its wire shape, for
   * whichever part of the program knows that feature — a mask of its own, for
   * instance.
   */
  features?: Record<string, boolean>;
}

/** The registry's protocols: capability → protocol id → entry. */
export type ProtocolGroups = Record<string, Record<string, ProtocolEntry>>;

export interface ProtocolsResponse {
  protocols: ProtocolGroups;
}

/** Model / configuration API helpers. */
export const modelsApi = {
  list(signal?: AbortSignal): Promise<ModelsView> {
    return http.request<ModelsView>("/api/v1/models", { signal });
  },

  /** Every write answers with the whole view, so one call resyncs the store. */
  upsert(draft: ModelDraft): Promise<ModelsView> {
    return http.request<ModelsView>("/api/v1/models", {
      method: "PUT",
      body: draft,
    });
  },

  remove(id: string, revision?: number): Promise<ModelsView> {
    const query = revision === undefined ? "" : `?revision=${revision}`;
    return http.request<ModelsView>(`${modelPath(id)}${query}`, {
      method: "DELETE",
    });
  },

  setKey(id: string, apiKey: string | null): Promise<ModelsView> {
    return http.request<ModelsView>(modelPath(id, "/key"), {
      method: "POST",
      body: { apiKey },
    });
  },

  setDefaults(patch: DefaultsPatch): Promise<ModelsView> {
    return http.request<ModelsView>("/api/v1/models/defaults", {
      method: "PATCH",
      body: patch,
    });
  },

  setPreferences(patch: PreferencesPatch): Promise<ModelsView> {
    return http.request<ModelsView>("/api/v1/models/preferences", {
      method: "PATCH",
      body: patch,
    });
  },

  /**
   * Moves the master key protecting every stored credential to another
   * tier. The key itself does not change, so stored keys keep working.
   */
  setSecretStorage(storage: SecretStorageChoice): Promise<ModelsView> {
    return http.request<ModelsView>("/api/v1/system/secret-storage", {
      method: "PUT",
      body: { storage },
    });
  },

  /** Returns the available converter protocols from the server. */
  fetchProtocols(): Promise<ProtocolsResponse> {
    return http.request<ProtocolsResponse>("/api/v1/converter/protocols");
  },
};
