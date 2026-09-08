import { useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  BootErrorScreen,
  BootScreen,
} from "./features/editor/components/BootScreen";
import { Toasts } from "./features/editor/components/Toasts";
import { EditorPage } from "./features/editor/EditorPage";
import { LauncherPage } from "./features/editor/launcher/LauncherPage";
import { useAppStore } from "./features/editor/stores/appStore";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useProviderStore } from "./features/settings/providerStore";

export default function App() {
  const phase = useAppStore((state) => state.phase);

  useEffect(() => {
    void useAppStore.getState().boot();
  }, []);

  // Apart from boot on purpose: provider configuration is something the app
  // shows, not something it needs in order to start.
  useEffect(() => {
    void useProviderStore.getState().load();
  }, []);

  return (
    <ErrorBoundary>
      {phase === "booting" && <BootScreen />}
      {phase === "error" && <BootErrorScreen />}
      {(phase === "launcher" || phase === "opening") && <LauncherPage />}
      {phase === "editing" && <EditorPage />}
      <SettingsDialog />
      <Toasts />
    </ErrorBoundary>
  );
}
