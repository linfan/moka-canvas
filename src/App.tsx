import { lazy, Suspense, useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  BootErrorScreen,
  BootScreen,
  PageLoading,
} from "./features/editor/components/BootScreen";
import { Toasts } from "./features/editor/components/Toasts";
import { LauncherPage } from "./features/editor/launcher/LauncherPage";
import { useAppStore } from "./features/editor/stores/appStore";
import { SettingsDialog } from "./features/settings/SettingsDialog";
import { useModelStore } from "./features/settings/modelStore";

// The board, the cutting room, and the story room are the heaviest rooms of
// the app, and none of them is where it starts: each arrives as a chunk of its
// own instead of weighing down the entry bundle the launcher actually needs.
const EditorPage = lazy(() =>
  import("./features/editor/EditorPage").then((module) => ({
    default: module.EditorPage,
  })),
);
const ClipPage = lazy(() =>
  import("./features/clip/ClipPage").then((module) => ({
    default: module.ClipPage,
  })),
);
const StoryPage = lazy(() =>
  import("./features/story/StoryPage").then((module) => ({
    default: module.StoryPage,
  })),
);

export default function App() {
  const phase = useAppStore((state) => state.phase);

  useEffect(() => {
    void useAppStore.getState().boot();
  }, []);

  // The app draws its own context menus, so the browser/webview default one
  // must never appear on top of them (web and desktop behave the same here).
  useEffect(() => {
    const suppress = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);

  // Apart from boot on purpose: model configuration is something the app
  // shows, not something it needs in order to start.
  useEffect(() => {
    void useModelStore.getState().load();
  }, []);

  // A room the reader is about to enter is fetched while they are still in the
  // room before it — the launcher leads to the board, the board to the cutting
  // room, and the cutting room to the story room — so the step between rooms
  // stays a step rather than a wait.
  useEffect(() => {
    if (phase === "launcher") {
      void import("./features/editor/EditorPage");
    }
    if (phase === "editing") {
      void import("./features/clip/ClipPage");
    }
    if (phase === "clip") {
      void import("./features/story/StoryPage");
    }
  }, [phase]);

  return (
    <ErrorBoundary>
      {phase === "booting" && <BootScreen />}
      {phase === "error" && <BootErrorScreen />}
      {(phase === "launcher" || phase === "opening") && <LauncherPage />}
      <Suspense fallback={<PageLoading />}>
        {phase === "editing" && <EditorPage />}
        {phase === "clip" && <ClipPage />}
        {phase === "story" && <StoryPage />}
      </Suspense>
      <SettingsDialog />
      <Toasts />
    </ErrorBoundary>
  );
}
