import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CAPABILITY_LABELS, type Capability } from "../../shared/domain";
import { modelOptionsFor, useModelStore } from "./modelStore";

interface Props {
  capability: Capability;
  value: string | null;
  onChange: (reference: string | null) => void;
  disabled?: boolean;
  /** What choosing nothing is called: a node falls back to the provider's own. */
  noneLabel?: string;
  /**
   * What the field is called here, when the capability's own name is not what
   * this place calls it: a telling's score and its voice are both asked of an
   * audio model, and the two are not the same thing to ask for.
   */
  label?: string;
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
  noneLabel,
  label,
}: Props) {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const options = useMemo(
    () => modelOptionsFor(view, capability),
    [view, capability],
  );
  const orphan =
    value !== null && !options.some((option) => option.reference === value);

  return (
    <label className="dialog-field">
      <span>{label ?? t(CAPABILITY_LABELS[capability])}</span>
      <select
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.value)
        }
        value={value ?? ""}
      >
        <option value="">{noneLabel ?? t("settings:picker.none")}</option>
        {options.map((option) => (
          <option key={option.reference} value={option.reference}>
            {option.label}
          </option>
        ))}
        {orphan && (
          <option value={value ?? ""}>
            {t("settings:picker.unavailable", { value: value ?? "" })}
          </option>
        )}
      </select>
    </label>
  );
}
