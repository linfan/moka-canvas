import type { ModelView } from "../../api";
import { CAPABILITY_LABELS, type Capability } from "../../shared/domain";
import { ModelEditor } from "./ModelEditor";
import { effectiveDefaultId, protocolLabel, useModelStore } from "./modelStore";
import { SecretStorageNote } from "./SecretStorageNote";

function ModelCard({
  model,
  category,
  isDefault,
}: {
  model: ModelView;
  category: Capability;
  isDefault: boolean;
}) {
  const saving = useModelStore((state) => state.saving);
  const activity = useModelStore((state) => state.activity[model.id]);
  const protocols = useModelStore((state) => state.protocols);
  const probe = activity?.probe ?? null;
  const lower = CAPABILITY_LABELS[category].toLowerCase();

  const remove = () => {
    if (
      !window.confirm(
        `Delete “${model.displayName}”? The stored key goes with it.`,
      )
    ) {
      return;
    }
    void useModelStore.getState().removeModel(model.id);
  };

  return (
    <li className={`model-card${model.enabled ? "" : " is-off"}`}>
      <div className="model-card-head">
        <strong>{model.displayName}</strong>
        <span className="model-card-tag">
          {protocolLabel(protocols, model.protocol)}
        </span>
        {!model.enabled && <span className="model-card-tag">off</span>}
        <label className="settings-check">
          <input
            aria-label={`Use ${model.displayName} as the default ${lower} model`}
            checked={isDefault}
            disabled={saving}
            onChange={(event) =>
              void useModelStore
                .getState()
                .setDefault(category, event.target.checked ? model.id : null)
            }
            type="radio"
            name={`default-${category}`}
          />
          <span>Default</span>
        </label>
      </div>
      <p className="model-card-detail">
        {model.model} · <code>{model.url}</code>
      </p>
      <p className="model-card-detail">
        {model.apiKey.set
          ? `Key ${model.apiKey.masked ?? "stored"}`
          : "No key stored"}
      </p>
      {probe && (
        <p
          className={
            probe.ok ? "model-card-probe" : "model-card-probe is-failed"
          }
          role="status"
        >
          {probe.ok
            ? `Reached in ${probe.latencyMs} ms`
            : `${probe.error?.code ?? "UNREACHABLE"}: ${probe.error?.message ?? "no answer"}`}
        </p>
      )}
      <div className="settings-row">
        <button
          disabled={saving}
          onClick={() => useModelStore.getState().editModel(model.id)}
          type="button"
        >
          Edit
        </button>
        <button
          aria-label={`Copy ${model.displayName}`}
          disabled={saving}
          onClick={() => void useModelStore.getState().duplicateModel(model.id)}
          title="Create a new configuration from this one, key included"
          type="button"
        >
          Duplicate
        </button>
        <button
          aria-label={`Test the connection to ${model.displayName}`}
          disabled={saving || activity?.probing === true || !model.apiKey.set}
          onClick={() => void useModelStore.getState().probe(model.id)}
          type="button"
        >
          {activity?.probing ? "Testing…" : "Test"}
        </button>
        <button
          className="danger"
          disabled={saving}
          onClick={remove}
          type="button"
        >
          Delete
        </button>
      </div>
    </li>
  );
}

/**
 * One category's models: what serves this kind of node, which of them is the
 * default, and the way to add, copy, test, or remove one.
 *
 * The default lives here rather than on a page of its own: it is a property of
 * the list beside it, and a picker far from the models it picks is how a
 * default ends up pointing at something nobody remembers choosing.
 */
export function ModelsTab({ category }: { category: Capability }) {
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const editing = useModelStore((state) => state.editing);
  const lower = CAPABILITY_LABELS[category].toLowerCase();

  if (editing !== null) {
    const model =
      editing === "new"
        ? null
        : (view?.models.find((entry) => entry.id === editing) ?? null);
    // A model deleted since the editor opened is not one to keep a form on.
    if (editing === "new" || model !== null) {
      return (
        <ModelEditor
          category={model?.category ?? category}
          model={model}
          onDone={() => useModelStore.getState().closeEditor()}
        />
      );
    }
  }

  const models = (view?.models ?? []).filter(
    (model) => model.category === category,
  );
  // The default nobody had to pick: the stored choice when it still serves,
  // and the first enabled model otherwise — the same fallback the server
  // resolves a generation through.
  const defaultId = effectiveDefaultId(view, category);

  return (
    <div className="settings-section">
      <div className="settings-row">
        <button
          className="primary"
          disabled={saving}
          onClick={() => useModelStore.getState().newModel(category)}
          type="button"
        >
          New {lower} model
        </button>
      </div>

      {models.length === 0 ? (
        <p className="settings-hint" data-testid={`${lower}-empty`}>
          No {lower} models yet. Add one: a complete endpoint URL, the protocol
          it speaks, and its own key.
        </p>
      ) : (
        <>
          <ul className="model-card-list">
            {models.map((model) => (
              <ModelCard
                category={category}
                isDefault={model.id === defaultId}
                key={model.id}
                model={model}
              />
            ))}
          </ul>
          {defaultId === null && (
            <p className="settings-hint" data-testid={`${lower}-gap`}>
              No enabled {lower} model: a {lower} node that names no model of
              its own will be refused. Enable one above, or add one.
            </p>
          )}
        </>
      )}

      {view && <SecretStorageNote tier={view.secretStorage} />}
    </div>
  );
}
