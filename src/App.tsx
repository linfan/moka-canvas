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

export default function App() {
  const phase = useAppStore((state) => state.phase);

  useEffect(() => {
    void useAppStore.getState().boot();
  }, []);

  return (
    <ErrorBoundary>
      {phase === "booting" && <BootScreen />}
      {phase === "error" && <BootErrorScreen />}
      {(phase === "launcher" || phase === "opening") && <LauncherPage />}
      {phase === "editing" && <EditorPage />}
      <Toasts />
    </ErrorBoundary>
  );
}
