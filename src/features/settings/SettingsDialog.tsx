import { useEffect } from "react";
import { ChannelsTab } from "./ChannelsTab";
import { DefaultsTab } from "./DefaultsTab";
import { PreferencesTab } from "./PreferencesTab";
import {
  guidanceFor,
  useProviderStore,
  type SettingsTab,
} from "./providerStore";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "channels", label: "Channels" },
  { id: "defaults", label: "Defaults" },
  { id: "preferences", label: "Preferences" },
];

/**
 * Provider configuration.
 *
 * Reachable from the launcher as well as the editor, because a channel has to
 * be set up before any project exists for it to be used from.
 */
export function SettingsDialog() {
  const open = useProviderStore((state) => state.open);
  const tab = useProviderStore((state) => state.tab);
  const error = useProviderStore((state) => state.error);
  const errorCode = useProviderStore((state) => state.errorCode);
  const loading = useProviderStore((state) => state.loading);
  const loaded = useProviderStore((state) => state.view !== null);
  const guidance = guidanceFor(errorCode);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useProviderStore.getState().closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  const close = () => useProviderStore.getState().closeSettings();

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
              onClick={() => useProviderStore.getState().setTab(entry.id)}
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
          ) : tab === "channels" ? (
            <ChannelsTab />
          ) : tab === "defaults" ? (
            <DefaultsTab />
          ) : (
            <PreferencesTab />
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
