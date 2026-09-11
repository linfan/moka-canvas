import { useState } from "react";
import type { ModelDraft, ModelView } from "../../api";
import {
  CAPABILITY_LABELS,
  MAX_MODEL_ID_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  PROTOCOLS_BY_CATEGORY,
  PROTOCOL_LABELS,
  PROTOCOL_URL_EXAMPLES,
  type Capability,
  type ModelProtocol,
} from "../../shared/domain";
import { useModelStore } from "./modelStore";

interface Props {
  /** The stored configuration being edited, or null for a new one. */
  model: ModelView | null;
  /** The category a new configuration starts on. */
  category: Capability;
  onDone: () => void;
}

interface FormState {
  id: string;
  protocol: ModelProtocol;
  url: string;
  model: string;
  displayName: string;
  enabled: boolean;
  apiKey: string;
}

function initialForm(model: ModelView | null, category: Capability): FormState {
  if (model === null) {
    const protocol = PROTOCOLS_BY_CATEGORY[category][0];
    return {
      id: "",
      protocol,
      url: PROTOCOL_URL_EXAMPLES[protocol],
      model: "",
      displayName: "",
      enabled: true,
      apiKey: "",
    };
  }
  return {
    id: model.id,
    protocol: model.protocol,
    url: model.url,
    model: model.model,
    displayName: model.displayName,
    enabled: model.enabled,
    apiKey: "",
  };
}

/**
 * One model configuration, written out in full.
 *
 * There is no provider to inherit from: the address is the complete endpoint,
 * the protocol says what shape arrives there, and the key belongs to this
 * model alone. A copy of another configuration is a starting point rather
 * than a relationship — duplicating carries the fields and the key, and the
 * two can then diverge without touching each other.
 */
export function ModelEditor({ model, category, onDone }: Props) {
  const saving = useModelStore((state) => state.saving);
  const view = useModelStore((state) => state.view);
  const [form, setForm] = useState<FormState>(() =>
    initialForm(model, category),
  );

  const edit = (patch: Partial<FormState>) =>
    setForm((state) => ({ ...state, ...patch }));

  const protocols = PROTOCOLS_BY_CATEGORY[category];

  const chooseProtocol = (protocol: ModelProtocol) => {
    // A form still carrying the example of the previous shape adopts the
    // new one; an address somebody typed is theirs to keep.
    const previousExample = PROTOCOL_URL_EXAMPLES[form.protocol];
    const url =
      form.url.trim() === "" || form.url.trim() === previousExample
        ? PROTOCOL_URL_EXAMPLES[protocol]
        : form.url;
    edit({ protocol, url });
  };

  const id = form.id.trim();
  const idTaken =
    model === null &&
    (view?.models ?? []).some(
      (entry) => entry.id.toLowerCase() === id.toLowerCase(),
    );
  const urlShaped = /^https?:\/\/\S+$/.test(form.url.trim());
  const canSave =
    !saving &&
    id !== "" &&
    !idTaken &&
    form.displayName.trim() !== "" &&
    form.model.trim() !== "" &&
    urlShaped;

  const save = async () => {
    const draft: ModelDraft = {
      id,
      category,
      protocol: form.protocol,
      url: form.url.trim(),
      model: form.model.trim(),
      displayName: form.displayName.trim(),
      enabled: form.enabled,
    };
    // A blank key field keeps whatever is stored; typing one replaces it.
    // Clearing is its own button, so saving an unrelated edit cannot cost a
    // working key.
    if (form.apiKey.trim() !== "") draft.apiKey = form.apiKey.trim();
    const saved = await useModelStore.getState().saveModel(draft);
    if (saved) onDone();
  };

  const clearKey = async () => {
    if (model === null) return;
    if (!window.confirm(`Clear the stored key of “${model.displayName}”?`)) {
      return;
    }
    await useModelStore.getState().setKey(model.id, null);
    onDone();
  };

  return (
    <div className="settings-section">
      <h3 className="settings-heading">
        {model === null
          ? `New ${CAPABILITY_LABELS[category].toLowerCase()} model`
          : `Edit “${model.displayName}”`}
      </h3>

      <label className="dialog-field">
        <span>Display name</span>
        <input
          aria-label="Display name"
          autoFocus
          maxLength={MAX_MODEL_NAME_LENGTH}
          onChange={(event) => edit({ displayName: event.target.value })}
          placeholder="What the pickers show"
          value={form.displayName}
        />
      </label>

      <label className="dialog-field">
        <span>Identifier</span>
        <input
          aria-label="Model identifier"
          disabled={model !== null}
          maxLength={MAX_MODEL_ID_LENGTH}
          onChange={(event) => edit({ id: event.target.value })}
          placeholder="lowercase-id"
          title={
            model !== null
              ? "Nodes reference this identifier, so it cannot change; duplicate the model to create a variant"
              : undefined
          }
          value={form.id}
        />
      </label>
      {idTaken && (
        <p className="settings-hint" role="alert">
          Another model already uses this identifier.
        </p>
      )}

      <label className="dialog-field">
        <span>Category</span>
        <input
          aria-label="Category"
          disabled
          value={CAPABILITY_LABELS[category]}
        />
      </label>

      <label className="dialog-field">
        <span>Protocol</span>
        <select
          aria-label="Protocol"
          onChange={(event) =>
            chooseProtocol(event.target.value as ModelProtocol)
          }
          value={form.protocol}
        >
          {protocols.map((protocol) => (
            <option key={protocol} value={protocol}>
              {PROTOCOL_LABELS[protocol]}
            </option>
          ))}
        </select>
      </label>

      <label className="dialog-field">
        <span>URL</span>
        <input
          aria-label="Endpoint URL"
          onChange={(event) => edit({ url: event.target.value })}
          placeholder={PROTOCOL_URL_EXAMPLES[form.protocol]}
          value={form.url}
        />
      </label>
      <p className="settings-hint">
        The complete endpoint address requests are sent to — not a base URL.
        {urlShaped ? "" : " It has to start with http:// or https://."}
      </p>

      <label className="dialog-field">
        <span>Model name</span>
        <input
          aria-label="Model name"
          maxLength={MAX_MODEL_NAME_LENGTH}
          onChange={(event) => edit({ model: event.target.value })}
          placeholder="The name the provider knows"
          value={form.model}
        />
      </label>

      <label className="dialog-field">
        <span>API key</span>
        <input
          aria-label="API key"
          onChange={(event) => edit({ apiKey: event.target.value })}
          placeholder={
            model?.apiKey.set
              ? `Stored (${model.apiKey.masked ?? "key"}) — leave blank to keep`
              : "sk-…"
          }
          type="password"
          value={form.apiKey}
        />
      </label>
      {model !== null && model.apiKey.set && (
        <div className="settings-row">
          <button disabled={saving} onClick={clearKey} type="button">
            Clear the stored key
          </button>
        </div>
      )}

      <label className="settings-check">
        <input
          aria-label="Model is available"
          checked={form.enabled}
          onChange={(event) => edit({ enabled: event.target.checked })}
          type="checkbox"
        />
        <span>Available to nodes</span>
      </label>

      <div className="dialog-actions">
        <button
          className="primary"
          disabled={!canSave}
          onClick={() => void save()}
          type="button"
        >
          {saving ? "Saving…" : "Save model"}
        </button>
        <button disabled={saving} onClick={onDone} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
