import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  CAPABILITY_LABELS,
  MODEL_CAPABILITIES,
  type Capability,
} from "../../shared/domain";
import { ModelsTab } from "./ModelsTab";
import {
  guidanceFor,
  useModelStore,
  type SettingsTab,
  type SettingsTopTab,
} from "./modelStore";
import { PreferencesTab } from "./PreferencesTab";
import { SystemTab } from "./SystemTab";

/** The two top-level sections: model configuration, and the system. */
const TOP_TABS: { id: SettingsTopTab; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "system", label: "System" },
];

/**
 * Model configuration and system settings.
 *
 * Reachable from the launcher as well as the editor, because a model has to
 * be set up before any project exists for it to be used from. The Model
 * section keeps a tab per category — the models that serve one kind of node
 * are listed, added, copied, tested, and defaulted together — and the System
 * section holds what is global: where the master key lives, and which
 * credentials it protects.
 */
export function SettingsDialog() {
  const { t } = useTranslation();
  const open = useModelStore((state) => state.open);
  const topTab = useModelStore((state) => state.topTab);
  const tab = useModelStore((state) => state.tab);
  const editing = useModelStore((state) => state.editing);
  const view = useModelStore((state) => state.view);
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

  // The Model section's own tabs: one per category, plus the preferences.
  const tabs: { id: SettingsTab; label: string }[] = [
    ...MODEL_CAPABILITIES.map((capability: Capability) => ({
      id: capability as SettingsTab,
      label: t(CAPABILITY_LABELS[capability]),
    })),
    { id: "preferences", label: "Preferences" },
  ];

  // A model editor carries its own Save and Cancel; a Done beside them is a
  // third way out that says nothing about the half-written form it leaves
  // behind. The footer belongs to the list, so it stays away while the
  // editor is what the tab shows — the same condition ModelsTab renders on.
  const editorOpen =
    topTab === "model" &&
    tab !== "preferences" &&
    editing !== null &&
    (editing === "new" ||
      (view?.models ?? []).some((model) => model.id === editing));

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
          {TOP_TABS.map((entry) => (
            <button
              aria-controls={`settings-panel-${entry.id}`}
              aria-selected={topTab === entry.id}
              className={topTab === entry.id ? "is-active" : ""}
              id={`settings-toptab-${entry.id}`}
              key={entry.id}
              onClick={() => useModelStore.getState().setTopTab(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>

        {topTab === "model" ? (
          <div
            aria-labelledby="settings-toptab-model"
            className="settings-panel"
            id="settings-panel-model"
            role="tabpanel"
          >
            <div
              aria-label="Model sections"
              className="settings-tabs settings-subtabs"
              role="tablist"
            >
              {tabs.map((entry) => (
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
          </div>
        ) : (
          <div
            aria-labelledby="settings-toptab-system"
            className="settings-body"
            id="settings-panel-system"
            role="tabpanel"
          >
            {loading && !loaded ? (
              <p className="settings-hint">Loading configuration…</p>
            ) : (
              <SystemTab />
            )}
          </div>
        )}

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

        {!editorOpen && (
          <div className="dialog-actions">
            <button onClick={close} type="button">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
