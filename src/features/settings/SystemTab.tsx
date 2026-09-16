import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SecretStorageChoice } from "../../api";
import { CAPABILITY_LABELS } from "../../shared/domain";
import { useModelStore } from "./modelStore";
import { SecretStorageNote } from "./SecretStorageNote";

const CHOICE_LABELS: Record<SecretStorageChoice, string> = {
  file: "File — a master.key inside the metadata directory",
  keyring: "Keyring — the operating system's keychain",
};

/**
 * What is global: where the master key protecting the stored credentials
 * lives, and which credentials exist.
 *
 * The tier is a choice only desktop macOS and Windows builds can make — a
 * server has no keychain to ask, so it keeps the file tier (or the exported
 * MOKA_METADATA_KEY, which always wins and cannot be moved from here).
 * Switching moves the same master key between its homes: stored credentials
 * keep opening, because the key that seals them does not change.
 */
export function SystemTab() {
  const { t } = useTranslation();
  const view = useModelStore((state) => state.view);
  const saving = useModelStore((state) => state.saving);
  const [managing, setManaging] = useState(false);

  if (!view) {
    return <p className="settings-hint">Loading configuration…</p>;
  }

  const options = view.secretStorageOptions ?? ["file"];
  const current = view.secretStorage;
  // The radio shows the tier that holds the key; before any key exists it
  // shows the tier the first one would be created in.
  const selected: SecretStorageChoice =
    current === "file" || current === "keyring"
      ? current
      : (view.secretStoragePref ?? "file");
  const envLocked = current === "env";
  const switchable = !envLocked && options.length > 1;

  const storedKeys = view.models.filter((model) => model.apiKey.set);

  const switchTo = (choice: SecretStorageChoice) => {
    if (choice === selected) return;
    const verdict = window.confirm(
      choice === "keyring"
        ? "Move the master key into the OS keychain? Stored API keys keep working; the master.key file is removed."
        : "Move the master key into a file in the metadata directory? Stored API keys keep working; the keychain entry is removed.",
    );
    if (!verdict) return;
    void useModelStore.getState().setSecretStorage(choice);
  };

  const removeKey = (id: string, displayName: string) => {
    if (
      !window.confirm(
        `Delete the stored key of “${displayName}”? The model configuration stays; requests will fail until a new key is entered.`,
      )
    ) {
      return;
    }
    void useModelStore.getState().setKey(id, null);
  };

  return (
    <div className="settings-section">
      <h3 className="settings-heading">API key storage</h3>
      <SecretStorageNote tier={current} />
      {options.map((choice) => (
        <label className="settings-check" key={choice}>
          <input
            aria-label={CHOICE_LABELS[choice]}
            checked={selected === choice}
            disabled={saving || !switchable}
            name="secret-storage"
            onChange={() => switchTo(choice)}
            type="radio"
            value={choice}
          />
          <span>{CHOICE_LABELS[choice]}</span>
        </label>
      ))}
      {envLocked && (
        <p className="settings-hint">
          MOKA_METADATA_KEY is set; the exported key takes precedence and cannot
          be moved from here.
        </p>
      )}
      {!switchable && !envLocked && options.length < 2 && (
        <p className="settings-hint">
          The OS keychain is not available in this runtime, so the file tier is
          the only choice.
        </p>
      )}

      <h3 className="settings-heading">Stored keys</h3>
      <div className="settings-row">
        <button
          disabled={saving}
          onClick={() => setManaging((open) => !open)}
          type="button"
        >
          {managing
            ? "Hide stored keys"
            : storedKeys.length === 0
              ? "Manage keys"
              : `Manage keys (${storedKeys.length})`}
        </button>
      </div>
      {managing &&
        (storedKeys.length === 0 ? (
          <p className="settings-hint">No API keys are stored.</p>
        ) : (
          <ul className="key-list">
            {storedKeys.map((model) => (
              <li key={model.id}>
                <div className="key-list-info">
                  <span className="key-list-name">{model.displayName}</span>
                  <span className="settings-hint">
                    {t(CAPABILITY_LABELS[model.category]).toLowerCase()} ·{" "}
                    {model.id}
                    {view.defaults[model.category] === model.id
                      ? " · category default"
                      : ""}
                  </span>
                  <span className="settings-hint">
                    {model.apiKey.masked ?? "key"}
                    {model.apiKey.rotatedAt
                      ? ` · rotated ${model.apiKey.rotatedAt.slice(0, 10)}`
                      : ""}
                  </span>
                </div>
                <button
                  disabled={saving}
                  onClick={() => removeKey(model.id, model.displayName)}
                  type="button"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
