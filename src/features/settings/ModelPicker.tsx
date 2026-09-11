import { useMemo } from "react";
import { CAPABILITY_LABELS, type Capability } from "../../shared/domain";
import { modelOptionsFor, useModelStore } from "./modelStore";

interface Props {
  capability: Capability;
  value: string | null;
  onChange: (reference: string | null) => void;
  disabled?: boolean;
  /** What choosing nothing is called: a node falls back to the provider's own. */
  noneLabel?: string;
}

/**
 * The model for one capability: the stored default in settings, or one node's
 * own choice.
 *
 * A stored id whose model has since been switched off or deleted is still
 * offered, rather than quietly collapsing to "no default": the setting is
 * still in force, and hiding it would leave no way to clear it.
 */
export function ModelPicker({
  capability,
  value,
  onChange,
  disabled = false,
  noneLabel = "No default",
}: Props) {
  const view = useModelStore((state) => state.view);
  const options = useMemo(
    () => modelOptionsFor(view, capability),
    [view, capability],
  );
  const orphan =
    value !== null && !options.some((option) => option.reference === value);

  return (
    <label className="dialog-field">
      <span>{CAPABILITY_LABELS[capability]}</span>
      <select
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.value)
        }
        value={value ?? ""}
      >
        <option value="">{noneLabel}</option>
        {options.map((option) => (
          <option key={option.reference} value={option.reference}>
            {option.label}
          </option>
        ))}
        {orphan && <option value={value ?? ""}>{value} (unavailable)</option>}
      </select>
    </label>
  );
}
