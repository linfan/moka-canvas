import type { Capability, ModelProtocol } from "../shared/domain";
import { http } from "./client";

/**
 * What may be disclosed about a stored credential. The server never sends
 * anything else, so there is no plaintext here to leak into state or a log.
 */
export interface ApiKeyView {
  set: boolean;
  masked: string | null;
}

/**
 * One model, configured on its own: a category, a protocol from the list that
 * category offers, the complete endpoint URL, the model name the provider
 * knows, and a display name. There is no provider grouping.
 */
export interface ModelView {
  id: string;
  category: Capability;
  protocol: ModelProtocol;
  /** The full endpoint address requests are sent to — not a base URL. */
  url: string;
  /** The model name the provider knows, sent in the body where one travels. */
  model: string;
  displayName: string;
  enabled: boolean;
  apiKey: ApiKeyView;
}

/** The default model of each category, by model configuration id. */
export type ModelDefaults = Record<Capability, string | null>;

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
}

export interface AudioPreferences {
  voice: string;
  format: string;
  speed: number;
  instructions: string;
}

/** Global generation defaults; a node's own parameters override these. */
export interface GenerationPreferences {
  systemPrompt: string;
  reasoningEffort: string;
  image: ImagePreferences;
  video: VideoPreferences;
  audio: AudioPreferences;
}

/**
 * Where the master key protecting the stored credentials lives. `unset` means
 * no credential has ever been stored, so no key was needed yet.
 */
export type SecretStorageTier = "keyring" | "file" | "env" | "unset";

export interface ModelsView {
  version: number;
  revision: number;
  models: ModelView[];
  defaults: ModelDefaults;
  preferences: GenerationPreferences;
  secretStorage: SecretStorageTier;
}

export interface ProbeReport {
  ok: boolean;
  latencyMs: number;
  error?: { code: string; message: string };
}

export interface ModelDraft {
  id: string;
  category: Capability;
  protocol: ModelProtocol;
  url: string;
  model: string;
  displayName: string;
  enabled: boolean;
  expectedRevision?: number | null;
  /**
   * Omit or leave blank to keep the stored credential. Clearing one is a
   * separate call, so an unrelated edit cannot cost a working key.
   */
  apiKey?: string | null;
}

export interface DefaultsPatch {
  text?: string | null;
  image?: string | null;
  audio?: string | null;
  video?: string | null;
  expectedRevision?: number | null;
}

/** A group is replaced whole; a field left out keeps its stored value. */
export interface PreferencesPatch {
  systemPrompt?: string;
  reasoningEffort?: string;
  image?: ImagePreferences;
  video?: VideoPreferences;
  audio?: AudioPreferences;
  expectedRevision?: number | null;
}

function modelPath(id: string, suffix = ""): string {
  return `/api/v1/models/${encodeURIComponent(id)}${suffix}`;
}

/** One protocol entry from the converter registry. */
export interface ProtocolEntry {
  capability: string;
  script: string;
  display_name: string;
  url_example: string;
}

export interface ProtocolsResponse {
  protocols: Record<string, ProtocolEntry>;
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

  /**
   * Creates a new configuration from an existing one, credential included:
   * the quick way to configure a second model at the same address.
   */
  duplicate(id: string, revision?: number): Promise<ModelsView> {
    const query = revision === undefined ? "" : `?revision=${revision}`;
    return http.request<ModelsView>(`${modelPath(id, "/duplicate")}${query}`, {
      method: "POST",
    });
  },

  /** Reports a broken model inside a successful response. */
  probe(id: string): Promise<ProbeReport> {
    return http.request<ProbeReport>(modelPath(id, "/probe"), {
      method: "POST",
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

  /** Returns the available converter protocols from the server. */
  fetchProtocols(): Promise<ProtocolsResponse> {
    return http.request<ProtocolsResponse>("/api/v1/converter/protocols");
  },
};
