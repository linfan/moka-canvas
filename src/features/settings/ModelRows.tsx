import type { ChannelModel } from "../../api";
import {
  CAPABILITY_LABELS,
  MAX_CHANNEL_ID_LENGTH,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";
import type { ModelRow } from "./modelRow";

/**
 * The models a channel will carry, as rows to be corrected.
 *
 * Shared by the editor and by the wizard that adds a provider, because the two
 * ask the same question — what is this model for — and a row that answered it
 * differently in one place would be a row nobody could trust in the other.
 */
export function ModelRows({
  models,
  onEdit,
  onRemove,
}: {
  models: ModelRow[];
  onEdit: (key: number, patch: Partial<ChannelModel>) => void;
  onRemove: (key: number) => void;
}) {
  return (
    <ul className="model-list">
      {models.map((model, position) => (
        <li className="model-row" key={model.key}>
          <input
            aria-label={`Model ${position + 1} identifier`}
            maxLength={MAX_CHANNEL_ID_LENGTH}
            onChange={(event) => onEdit(model.key, { id: event.target.value })}
            placeholder="model-id"
            value={model.id}
          />
          <select
            aria-label={`Model ${position + 1} capability`}
            onChange={(event) =>
              onEdit(model.key, {
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
              onEdit(model.key, { alias: event.target.value })
            }
            placeholder="Shown as"
            value={model.alias}
          />
          <label className="settings-check">
            <input
              aria-label={`Model ${position + 1} is available`}
              checked={model.enabled}
              onChange={(event) =>
                onEdit(model.key, { enabled: event.target.checked })
              }
              type="checkbox"
            />
            <span>On</span>
          </label>
          <button
            aria-label={`Remove model ${model.id || position + 1}`}
            className="settings-close"
            onClick={() => onRemove(model.key)}
            type="button"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
