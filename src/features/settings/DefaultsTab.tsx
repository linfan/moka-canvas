import { useEffect, useState } from "react";
import type { DefaultsPatch, ModelDefaults } from "../../api";
import { MODEL_CAPABILITIES } from "../../shared/domain";
import { ModelPicker } from "./ModelPicker";
import { useProviderStore } from "./providerStore";

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
        {MODEL_CAPABILITIES.map((capability) => (
          <ModelPicker
            capability={capability}
            disabled={saving}
            key={capability}
            onChange={(reference: string | null) =>
              setDraft((state) => ({ ...state, [capability]: reference }))
            }
            value={draft[capability]}
          />
        ))}
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
