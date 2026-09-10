import { useEffect, useState } from "react";
import type { DefaultsPatch, ModelDefaults } from "../../api";
import { CAPABILITY_LABELS, MODEL_CAPABILITIES } from "../../shared/domain";
import { ModelPicker } from "./ModelPicker";
import { modelOptionsFor, useProviderStore } from "./providerStore";

const UNSET: ModelDefaults = {
  text: null,
  image: null,
  audio: null,
  video: null,
};

/**
 * Which model each capability reaches for when a node does not name one.
 *
 * Only the capabilities that actually moved are sent, so choosing an image
 * model cannot clobber a text default that changed underneath the form.
 *
 * Each capability also says what it is missing. A default left unset is not a
 * neutral choice: a node of that kind left on "Provider default" is refused at
 * run time, which reads as a provider failing rather than as a setting nobody
 * made — so the gap is named here, next to the control that closes it.
 */
export function DefaultsTab() {
  const view = useProviderStore((state) => state.view);
  const saving = useProviderStore((state) => state.saving);
  const [draft, setDraft] = useState<ModelDefaults>(UNSET);

  // Adopt whatever is stored whenever it changes, including after this form's
  // own save answers with a fresh view.
  useEffect(() => {
    if (view) setDraft({ ...view.defaults });
  }, [view]);

  if (!view) return <p className="settings-hint">Loading configuration…</p>;

  if (view.channels.length === 0) {
    return (
      <div className="settings-section">
        <p className="settings-hint">
          No channels are configured yet, so there is nothing to choose from.
        </p>
        <div className="settings-row">
          <button
            onClick={() => useProviderStore.getState().setTab("channels")}
            type="button"
          >
            Add a channel
          </button>
        </div>
      </div>
    );
  }

  const patch: DefaultsPatch = {};
  for (const capability of MODEL_CAPABILITIES) {
    if (draft[capability] !== view.defaults[capability]) {
      patch[capability] = draft[capability];
    }
  }
  const changed = Object.keys(patch).length > 0;

  return (
    <div className="settings-section">
      <p className="settings-hint">
        Used when a node does not name a model of its own.
      </p>
      <div className="settings-columns">
        {MODEL_CAPABILITIES.map((capability) => {
          const label = CAPABILITY_LABELS[capability];
          const lower = label.toLowerCase();
          const options = modelOptionsFor(view, capability);
          const chosen = draft[capability];
          return (
            <div className="default-row" key={capability}>
              <ModelPicker
                capability={capability}
                disabled={saving}
                noneLabel={
                  options.length > 0 && chosen === null
                    ? "Not set — nodes will be refused"
                    : "No default"
                }
                onChange={(reference: string | null) =>
                  setDraft((state) => ({ ...state, [capability]: reference }))
                }
                value={chosen}
              />

              {options.length === 0 ? (
                <p className="settings-hint" data-testid={`${lower}-gap`}>
                  No {lower} model in any enabled channel.
                  <button
                    disabled={saving}
                    onClick={() =>
                      useProviderStore
                        .getState()
                        .openChannelForCapability(capability)
                    }
                    type="button"
                  >
                    Configure {lower} models
                  </button>
                </p>
              ) : chosen === null ? (
                <p className="settings-hint" data-testid={`${lower}-gap`}>
                  {options.length} {lower} model
                  {options.length === 1 ? "" : "s"} available and none of them
                  is the default.
                  {options.length === 1 && (
                    <button
                      disabled={saving}
                      onClick={() =>
                        setDraft((state) => ({
                          ...state,
                          [capability]: options[0].reference,
                        }))
                      }
                      type="button"
                    >
                      Use {options[0].label}
                    </button>
                  )}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="dialog-actions">
        <button
          className="primary"
          disabled={saving || !changed}
          onClick={() => void useProviderStore.getState().saveDefaults(patch)}
          type="button"
        >
          {saving ? "Saving…" : "Save defaults"}
        </button>
      </div>
    </div>
  );
}
