import { useEffect } from "react";
import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";
import { ModelsTab } from "./ModelsTab";
import { guidanceFor, useModelStore, type SettingsTab } from "./modelStore";
import { PreferencesTab } from "./PreferencesTab";

const TABS: { id: SettingsTab; label: string }[] = [
  ...MODEL_CAPABILITIES.map((capability: Capability) => ({
    id: capability as SettingsTab,
    label: CAPABILITY_LABELS[capability],
  })),
  { id: "preferences", label: "Preferences" },
];

/**
 * Model configuration.
 *
 * Reachable from the launcher as well as the editor, because a model has to
 * be set up before any project exists for it to be used from. Each category
 * gets its own tab: the models that serve one kind of node are listed, added,
 * copied, tested, and defaulted together, and nothing else is mixed in.
 */
export function SettingsDialog() {
  const open = useModelStore((state) => state.open);
  const tab = useModelStore((state) => state.tab);
  const error = useModelStore((state) => state.error);
  const errorCode = useModelStore((state) => state.errorCode);
  const loading = useModelStore((state) => state.loading);
  const loaded = useModelStore((state) => state.view !== null);
  const guidance = guidanceFor(errorCode);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useModelStore.getState().closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const close = () => useModelStore.getState().closeSettings();

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        aria-labelledby="settings-title"
        aria-modal="true"
        className="dialog settings"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="settings-head">
          <h2 id="settings-title">Settings</h2>
          <button
            aria-label="Close settings"
            className="settings-close"
            onClick={close}
            type="button"
          >
            ×
          </button>
        </header>

        <div
          aria-label="Settings sections"
          className="settings-tabs"
          role="tablist"
        >
          {TABS.map((entry) => (
            <button
              aria-controls={`settings-panel-${entry.id}`}
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "is-active" : ""}
              id={`settings-tab-${entry.id}`}
              key={entry.id}
              onClick={() => useModelStore.getState().setTab(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div
          aria-labelledby={`settings-tab-${tab}`}
          className="settings-body"
          id={`settings-panel-${tab}`}
          role="tabpanel"
        >
          {loading && !loaded ? (
            <p className="settings-hint">Loading configuration…</p>
          ) : tab === "preferences" ? (
            <PreferencesTab />
          ) : (
            <ModelsTab category={tab} />
          )}
        </div>

        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        {error && guidance && (
          <p className="dialog-note" data-testid="error-guidance">
            {guidance}
          </p>
        )}

        <div className="dialog-actions">
          <button onClick={close} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
