import type { Capability, ProviderProtocol } from "../shared/domain";
import { http } from "./client";

/**
 * What may be disclosed about a stored credential. The server never sends
 * anything else, so there is no plaintext here to leak into state or a log.
 */
export interface ApiKeyView {
  set: boolean;
  masked: string | null;
}

export interface ChannelModel {
  id: string;
  capability: Capability;
  alias: string;
  enabled: boolean;
}

export interface ChannelView {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  models: ChannelModel[];
  apiKey: ApiKeyView;
}

/** Default model per capability, addressed as `channelId::modelId`. */
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

export interface ProvidersView {
  version: number;
  revision: number;
  channels: ChannelView[];
  defaults: ModelDefaults;
  preferences: GenerationPreferences;
  secretStorage: SecretStorageTier;
}

/** A model a channel offers, before anybody has decided what it is for. */
export interface ModelCandidate {
  id: string;
  capability: Capability | null;
}

export interface ProbeReport {
  ok: boolean;
  latencyMs: number;
  error?: { code: string; message: string };
}

export interface ChannelDraft {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  models: ChannelModel[];
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

export interface ImportChannelRequest {
  baseUrl: string;
  apiKey?: string | null;
  name?: string | null;
  protocol?: ProviderProtocol | null;
  expectedRevision?: number | null;
}

function channelPath(id: string, suffix = ""): string {
  return `/api/v1/providers/channels/${encodeURIComponent(id)}${suffix}`;
}

export const providersApi = {
  list(signal?: AbortSignal): Promise<ProvidersView> {
    return http.request<ProvidersView>("/api/v1/providers", { signal });
  },

  /** Every write answers with the whole view, so one call resyncs the store. */
  upsertChannel(draft: ChannelDraft): Promise<ProvidersView> {
    return http.request<ProvidersView>("/api/v1/providers/channels", {
      method: "PUT",
      body: draft,
    });
  },

  deleteChannel(id: string, revision?: number): Promise<ProvidersView> {
    const query = revision === undefined ? "" : `?revision=${revision}`;
    return http.request<ProvidersView>(`${channelPath(id)}${query}`, {
      method: "DELETE",
    });
  },

  setKey(id: string, apiKey: string | null): Promise<ProvidersView> {
    return http.request<ProvidersView>(channelPath(id, "/key"), {
      method: "POST",
      body: { apiKey },
    });
  },

  setDefaults(patch: DefaultsPatch): Promise<ProvidersView> {
    return http.request<ProvidersView>("/api/v1/providers/defaults", {
      method: "PATCH",
      body: patch,
    });
  },

  setPreferences(patch: PreferencesPatch): Promise<ProvidersView> {
    return http.request<ProvidersView>("/api/v1/providers/preferences", {
      method: "PATCH",
      body: patch,
    });
  },

  /** Lists what a channel offers and stores nothing. */
  fetchModels(id: string): Promise<ModelCandidate[]> {
    return http
      .request<{ models: ModelCandidate[] }>(channelPath(id, "/models"))
      .then((body) => body.models);
  },

  /**
   * Stores what the provider lists, keeping the capability, alias, and switch
   * already chosen for an identifier that is still listed.
   */
  refreshModels(id: string): Promise<ProvidersView> {
    return http.request<ProvidersView>(channelPath(id, "/models/refresh"), {
      method: "POST",
    });
  },

  /** Reports a broken channel inside a successful response. */
  probe(id: string): Promise<ProbeReport> {
    return http.request<ProbeReport>(channelPath(id, "/probe"), {
      method: "POST",
    });
  },

  importChannel(request: ImportChannelRequest): Promise<ProvidersView> {
    return http.request<ProvidersView>("/api/v1/providers/import", {
      method: "POST",
      body: request,
    });
  },
};
