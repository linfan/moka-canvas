import { useCallback, useMemo, useState } from "react";
import type { ModelDraft, ModelView, ProtocolGroups } from "../../api";
import {
  CAPABILITY_LABELS,
  MAX_MODEL_ID_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  type Capability,
} from "../../shared/domain";
import {
  protocolChoices,
  protocolLabel,
  protocolUrlExample,
  useModelStore,
} from "./modelStore";
import { uniqueModelId } from "./modelId";

interface Props {
  /** The stored configuration being edited, or null for a new one. */
  model: ModelView | null;
  /** The configuration a new one is a copy of, or null for a plain new one. */
  copySource?: ModelView | null;
  /** The category a new configuration starts on. */
  category: Capability;
  onDone: () => void;
}

interface FormState {
  id: string;
  /** Whether the identifier was typed, or is still the suggested one. */
  idTouched: boolean;
  /** A protocol id from the converter registry, or a built-in name. */
  protocol: string;
  url: string;
  model: string;
  displayName: string;
  enabled: boolean;
  apiKey: string;
}

function initialForm(
  model: ModelView | null,
  copySource: ModelView | null,
  category: Capability,
  protocols: ProtocolGroups | null,
): FormState {
  if (model === null && copySource !== null) {
    // A copy starts from the source's fields, including the protocol it may
    // alone speak; the identifier is left to the suggestion, which follows
    // the display name the way a plain new model's does.
    return {
      id: "",
      idTouched: false,
      protocol: copySource.protocol,
      url: copySource.url,
      model: copySource.model,
      displayName: `${copySource.displayName} (copy)`.slice(
        0,
        MAX_MODEL_NAME_LENGTH,
      ),
      enabled: copySource.enabled,
      apiKey: "",
    };
  }
  if (model === null) {
    const choice = protocolChoices(protocols, category)[0];
    return {
      id: "",
      idTouched: false,
      protocol: choice.id,
      url: choice.urlExample,
      model: "",
      displayName: "",
      enabled: true,
      apiKey: "",
    };
  }
  return {
    id: model.id,
    idTouched: true,
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
 *
 * The identifier is the one field nobody has to think about: it is suggested
 * from the display name and can be overwritten, because what it does — stay
 * the reference a node holds — matters more than what it reads as.
 */
export function ModelEditor({
  model,
  copySource = null,
  category,
  onDone,
}: Props) {
  const saving = useModelStore((state) => state.saving);
  const view = useModelStore((state) => state.view);
  const protocols = useModelStore((state) => state.protocols);
  const [form, setForm] = useState<FormState>(() =>
    initialForm(model, copySource, category, protocols),
  );

  const edit = (patch: Partial<FormState>) =>
    setForm((state) => ({ ...state, ...patch }));

  /**
   * What the protocol picker offers. A stored configuration whose script
   * has since left the registry still gets a line, so the form names what
   * is saved instead of silently falling back to another shape.
   */
  const choices = useMemo(() => {
    const offered = protocolChoices(protocols, category);
    const storedMissing =
      form.protocol !== "" &&
      !offered.some((choice) => choice.id === form.protocol);
    return storedMissing
      ? [
          {
            id: form.protocol,
            label: protocolLabel(protocols, form.protocol),
            urlExample: protocolUrlExample(protocols, form.protocol),
          },
          ...offered,
        ]
      : offered;
  }, [protocols, category, form.protocol]);

  const chooseProtocol = (protocol: string) => {
    // A form still carrying the example of the previous shape adopts the
    // new one; an address somebody typed is theirs to keep.
    const previousExample = protocolUrlExample(protocols, form.protocol);
    const nextExample = protocolUrlExample(protocols, protocol);
    const url =
      form.url.trim() === "" || form.url.trim() === previousExample
        ? nextExample
        : form.url;
    edit({ protocol, url });
  };

  /** Whether a stored configuration already answers to an identifier. */
  const isTaken = useCallback(
    (candidate: string) =>
      (view?.models ?? []).some(
        (entry) => entry.id.toLowerCase() === candidate.toLowerCase(),
      ),
    [view],
  );

  /**
   * The identifier this form will save.
   *
   * A new configuration is handed one derived from its display name, which
   * follows the name as it is typed — writing an identifier is optional,
   * having one is not. Typing one takes over, and clearing the field hands it
   * back to the suggestion rather than saving nothing. An existing
   * configuration's identifier is the one its nodes already store.
   */
  const identifier = useMemo(() => {
    if (model !== null) return model.id;
    if (form.idTouched) return form.id.trim();
    return uniqueModelId(form.displayName, isTaken);
  }, [model, form.idTouched, form.id, form.displayName, isTaken]);

  const chooseId = (typed: string) => {
    if (typed.trim() === "") {
      edit({ id: "", idTouched: false });
      return;
    }
    edit({ id: typed, idTouched: true });
  };

  const idTaken = model === null && isTaken(identifier);
  const idShaped = !/\s/.test(identifier);
  const idProblem = idTaken
    ? "Another model already uses this identifier."
    : idShaped
      ? null
      : "An identifier cannot contain spaces.";
  const urlShaped = /^https?:\/\/\S+$/.test(form.url.trim());
  const canSave =
    !saving &&
    !idTaken &&
    idShaped &&
    form.displayName.trim() !== "" &&
    form.model.trim() !== "" &&
    urlShaped;

  const save = async () => {
    const draft: ModelDraft = {
      id: identifier,
      category,
      protocol: form.protocol,
      url: form.url.trim(),
      model: form.model.trim(),
      displayName: form.displayName.trim(),
      enabled: form.enabled,
    };
    // A blank key field keeps whatever is stored; typing one replaces it.
    // Clearing is its own button, so saving an unrelated edit cannot cost a
    // working key. A copy names its source instead: the client never sees
    // the key, so the server takes it from the configuration being copied.
    if (form.apiKey.trim() !== "") {
      draft.apiKey = form.apiKey.trim();
    } else if (model === null && copySource !== null) {
      draft.copyKeyFrom = copySource.id;
    }
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
        {model !== null
          ? // The category went out of the form as a field of its own; the
            // heading is where an editor says which kind of model this is,
            // because the protocol choices below follow from it.
            `Edit “${model.displayName}” · ${CAPABILITY_LABELS[category].toLowerCase()}`
          : copySource !== null
            ? `Copy “${copySource.displayName}” · ${CAPABILITY_LABELS[category].toLowerCase()}`
            : `New ${CAPABILITY_LABELS[category].toLowerCase()} model`}
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
          onChange={(event) => chooseId(event.target.value)}
          title={
            model !== null
              ? "Nodes reference this identifier, so it cannot change; duplicate the model to create a variant"
              : undefined
          }
          value={identifier}
        />
      </label>
      {model === null && (
        <p className="settings-hint">
          Suggested from the display name, and yours to overwrite — clearing it
          asks for a new suggestion. Nodes store it, so it cannot change once
          the model is saved.
        </p>
      )}
      {idProblem && (
        <p className="settings-hint" role="alert">
          {idProblem}
        </p>
      )}

      <label className="dialog-field">
        <span>Protocol</span>
        <select
          aria-label="Protocol"
          onChange={(event) => chooseProtocol(event.target.value)}
          value={form.protocol}
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>

      <label className="dialog-field">
        <span>URL</span>
        <input
          aria-label="Endpoint URL"
          onChange={(event) => edit({ url: event.target.value })}
          placeholder={protocolUrlExample(protocols, form.protocol)}
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
              : copySource?.apiKey.set
                ? `Copied from “${copySource.displayName}” — leave blank to keep`
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
