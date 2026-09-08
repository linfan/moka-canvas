import { useState, type FormEvent } from "react";
import type { ChannelModel, ChannelView } from "../../api";
import {
  CAPABILITY_LABELS,
  MAX_CHANNEL_ID_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  MODEL_CAPABILITIES,
  PROVIDER_PROTOCOLS,
  type Capability,
  type ProviderProtocol,
} from "../../shared/domain";
import { useProviderStore } from "./providerStore";

/** A model row plus the identity that keeps it mounted while rows come and go. */
interface ModelRow extends ChannelModel {
  key: number;
}

interface Form {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  apiKey: string;
  models: ModelRow[];
}

let nextRowKey = 1;

function toRow(model: ChannelModel): ModelRow {
  return { ...model, key: nextRowKey++ };
}

function newRow(capability: Capability = "text"): ModelRow {
  return { id: "", capability, alias: "", enabled: true, key: nextRowKey++ };
}

function initialForm(channel: ChannelView | null): Form {
  if (!channel) {
    return {
      id: "",
      name: "",
      baseUrl: "",
      protocol: "openai",
      enabled: true,
      apiKey: "",
      models: [],
    };
  }
  return {
    id: channel.id,
    name: channel.name,
    baseUrl: channel.baseUrl,
    protocol: channel.protocol,
    enabled: channel.enabled,
    // A stored credential is never sent back to the client, so this starts
    // empty and an edit that leaves it empty keeps whatever is stored.
    apiKey: "",
    models: channel.models.map(toRow),
  };
}

interface Props {
  /** Null for a channel that does not exist yet. */
  channel: ChannelView | null;
  onDone: () => void;
}

export function ChannelEditor({ channel, onDone }: Props) {
  const saving = useProviderStore((state) => state.saving);
  const activity = useProviderStore(
    (state) => state.activity[channel?.id ?? ""],
  );
  const [form, setForm] = useState<Form>(() => initialForm(channel));

  const edit = (patch: Partial<Form>) =>
    setForm((state) => ({ ...state, ...patch }));

  const editModels = (next: (models: ModelRow[]) => ModelRow[]) =>
    setForm((state) => ({ ...state, models: next(state.models) }));

  const editModel = (key: number, patch: Partial<ChannelModel>) =>
    editModels((models) =>
      models.map((model) =>
        model.key === key ? { ...model, ...patch } : model,
      ),
    );

  const addModel = (row: ModelRow) => editModels((models) => [...models, row]);

  const removeModel = (key: number) =>
    editModels((models) => models.filter((model) => model.key !== key));

  const ready =
    !saving &&
    form.id.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.baseUrl.trim().length > 0 &&
    form.models.every((model) => model.id.trim().length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const saved = await useProviderStore.getState().saveChannel({
      id: form.id.trim(),
      name: form.name.trim(),
      baseUrl: form.baseUrl.trim(),
      protocol: form.protocol,
      enabled: form.enabled,
      models: form.models.map((model) => ({
        id: model.id.trim(),
        capability: model.capability,
        alias: model.alias.trim(),
        enabled: model.enabled,
      })),
      apiKey: form.apiKey.trim() || null,
    });
    if (saved) onDone();
  };

  /**
   * Adopts a listed model into the form rather than into the configuration:
   * what each model is for is the decision being made here, so a capability
   * nobody could guess lands on the row for the user to correct.
   */
  const adopt = (id: string, capability: Capability | null) => {
    if (form.models.some((model) => model.id === id)) return;
    addModel({ ...newRow(capability ?? "text"), id });
  };

  return (
    <form className="settings-section" onSubmit={(event) => void submit(event)}>
      <h3 className="settings-heading">
        {channel ? `Edit ${channel.name}` : "New channel"}
      </h3>

      <label className="dialog-field">
        <span>Identifier</span>
        <input
          disabled={channel !== null}
          maxLength={MAX_CHANNEL_ID_LENGTH}
          onChange={(event) => edit({ id: event.target.value })}
          placeholder="example"
          title={
            channel !== null
              ? "A channel keeps the identifier it was created with"
              : "No spaces, and no “::” — that separates a channel from a model"
          }
          value={form.id}
        />
      </label>

      <label className="dialog-field">
        <span>Name</span>
        <input
          maxLength={MAX_CHANNEL_NAME_LENGTH}
          onChange={(event) => edit({ name: event.target.value })}
          placeholder="Example Inc"
          value={form.name}
        />
      </label>

      <label className="dialog-field">
        <span>Base URL</span>
        <input
          onChange={(event) => edit({ baseUrl: event.target.value })}
          placeholder="https://api.example.com/v1"
          type="url"
          value={form.baseUrl}
        />
      </label>

      <div className="settings-columns">
        <label className="dialog-field">
          <span>Protocol</span>
          <select
            onChange={(event) =>
              edit({ protocol: event.target.value as ProviderProtocol })
            }
            value={form.protocol}
          >
            {PROVIDER_PROTOCOLS.map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocol}
              </option>
            ))}
          </select>
        </label>

        <label className="dialog-field">
          <span>API key</span>
          <input
            onChange={(event) => edit({ apiKey: event.target.value })}
            placeholder={
              channel?.apiKey.set
                ? `Stored (${channel.apiKey.masked ?? "set"})`
                : "Not stored"
            }
            title={
              channel?.apiKey.set
                ? "Leave empty to keep the stored key"
                : undefined
            }
            type="password"
            value={form.apiKey}
          />
        </label>
      </div>

      <label className="settings-check">
        <input
          checked={form.enabled}
          onChange={(event) => edit({ enabled: event.target.checked })}
          type="checkbox"
        />
        <span>Available to nodes</span>
      </label>

      <section aria-label="Models" className="settings-section">
        <h3 className="settings-heading">Models</h3>
        {form.models.length === 0 && (
          <p className="settings-hint">
            No models yet, so nothing can be pointed at this channel.
          </p>
        )}
        <ul className="model-list">
          {form.models.map((model, position) => (
            <li className="model-row" key={model.key}>
              <input
                aria-label={`Model ${position + 1} identifier`}
                maxLength={MAX_CHANNEL_ID_LENGTH}
                onChange={(event) =>
                  editModel(model.key, { id: event.target.value })
                }
                placeholder="model-id"
                value={model.id}
              />
              <select
                aria-label={`Model ${position + 1} capability`}
                onChange={(event) =>
                  editModel(model.key, {
                    capability: event.target.value as Capability,
                  })
                }
                value={model.capability}
              >
                {MODEL_CAPABILITIES.map((capability) => (
                  <option key={capability} value={capability}>
                    {CAPABILITY_LABELS[capability]}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Model ${position + 1} display name`}
                onChange={(event) =>
                  editModel(model.key, { alias: event.target.value })
                }
                placeholder="Shown as"
                value={model.alias}
              />
              <label className="settings-check">
                <input
                  aria-label={`Model ${position + 1} is available`}
                  checked={model.enabled}
                  onChange={(event) =>
                    editModel(model.key, { enabled: event.target.checked })
                  }
                  type="checkbox"
                />
                <span>On</span>
              </label>
              <button
                aria-label={`Remove model ${model.id || position + 1}`}
                className="settings-close"
                onClick={() => removeModel(model.key)}
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="settings-row">
          <button onClick={() => addModel(newRow())} type="button">
            Add model
          </button>
          {channel ? (
            <button
              aria-label={`Ask ${channel.name} which models it offers`}
              disabled={saving || activity?.listing === true}
              onClick={() =>
                void useProviderStore.getState().listModels(channel.id)
              }
              type="button"
            >
              {activity?.listing ? "Listing…" : "List from provider"}
            </button>
          ) : (
            <span className="settings-hint">
              Save the channel and its key first — listing asks the provider
              what it offers.
            </span>
          )}
        </div>

        {activity?.candidates && activity.candidates.length > 0 && (
          <ul
            aria-label="Models offered by the provider"
            className="model-list"
          >
            {activity.candidates.map((candidate) => (
              <li className="model-row" key={candidate.id}>
                <span className="candidate-id">{candidate.id}</span>
                {candidate.capability && (
                  <span className="channel-tag">
                    {CAPABILITY_LABELS[candidate.capability]}
                  </span>
                )}
                <button
                  aria-label={`Add ${candidate.id} to this channel`}
                  disabled={saving}
                  onClick={() => adopt(candidate.id, candidate.capability)}
                  type="button"
                >
                  +
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="dialog-actions">
        <button disabled={saving} onClick={onDone} type="button">
          Cancel
        </button>
        <button className="primary" disabled={!ready} type="submit">
          {saving ? "Saving…" : "Save channel"}
        </button>
      </div>
    </form>
  );
}
