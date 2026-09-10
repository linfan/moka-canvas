import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChannelModel, ChannelView } from "../../api";
import {
  MAX_CHANNEL_ID_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  PROVIDER_PROTOCOLS,
  type Capability,
  type ProviderProtocol,
} from "../../shared/domain";
import { CandidateList } from "./CandidateList";
import { coverageOf, firstMissing } from "./coverage";
import { CoverageChips } from "./CoverageChips";
import { newRow, toRow, type ModelRow } from "./modelRow";
import { ModelRows } from "./ModelRows";
import { useProviderStore } from "./providerStore";
import { SecretStorageNote } from "./SecretStorageNote";

interface Form {
  id: string;
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  apiKey: string;
  models: ModelRow[];
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
  const secretStorage = useProviderStore(
    (state) => state.view?.secretStorage ?? null,
  );
  const activity = useProviderStore(
    (state) => state.activity[channel?.id ?? ""],
  );
  const [form, setForm] = useState<Form>(() => initialForm(channel));
  const listing = activity?.listing === true;
  const candidates = activity?.candidates ?? null;
  const listingError = activity?.listingError ?? null;

  /**
   * Asks the provider what it offers the moment there is something to ask
   * with, rather than leaving that to be discovered as a button.
   *
   * Only for a channel with a stored credential and no models: that is the
   * state a quick import lands in, and the alternative to asking is a channel
   * that looks configured and can serve nothing. Once for each channel, so
   * re-rendering the form does not keep dialling out.
   */
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    const id = channel?.id;
    if (
      id === undefined ||
      channel === null ||
      channel.models.length > 0 ||
      !channel.apiKey.set ||
      askedFor.current === id
    ) {
      return;
    }
    askedFor.current = id;
    void useProviderStore.getState().listModels(id);
  }, [channel]);

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

  const addModels = (ids: string[], capability: Capability) =>
    editModels((models) => [
      ...models,
      ...ids
        .filter((id) => !models.some((model) => model.id === id))
        .map((id) => ({ ...newRow(capability), id })),
    ]);

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

      {secretStorage && <SecretStorageNote tier={secretStorage} />}

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
        <p className="settings-hint">
          A model serves the nodes of its own kind: an image model cannot be
          pointed at a text node, and the run is refused if it is.
        </p>
        {form.models.length === 0 ? (
          <p className="settings-hint" data-testid="models-gap">
            No models yet, so no node can use this channel.
          </p>
        ) : (
          <CoverageChips models={form.models} />
        )}
        <ModelRows
          models={form.models}
          onEdit={editModel}
          onRemove={removeModel}
        />

        <div className="settings-row">
          <button
            onClick={() =>
              addModel(newRow(firstMissing(coverageOf(form.models))))
            }
            title="A model serves the nodes of its own kind; the row starts on a kind this channel has nothing for yet"
            type="button"
          >
            Add model
          </button>
          {channel ? (
            <button
              aria-label={`Ask ${channel.name} which models it offers`}
              disabled={saving || listing}
              onClick={() =>
                void useProviderStore.getState().listModels(channel.id)
              }
              title="Asks the provider what it offers and lists it here to choose from, without changing anything stored"
              type="button"
            >
              {listing ? "Listing…" : "List from provider"}
            </button>
          ) : (
            <span className="settings-hint">
              Save the channel and its key first — listing asks the provider
              what it offers.
            </span>
          )}
        </div>

        {listingError && (
          <p className="dialog-error" data-testid="listing-error" role="alert">
            {listingError}
          </p>
        )}

        {candidates !== null && candidates.length > 0 && (
          <CandidateList
            added={new Set(form.models.map((model) => model.id))}
            candidates={candidates}
            disabled={saving}
            onAdopt={addModels}
          />
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
