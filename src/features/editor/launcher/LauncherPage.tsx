import { useCallback, useEffect, useState } from "react";
import { recentApi, type RecentProject } from "../../../api";
import type { SelfCheckReport } from "../../../shared/domain";
import { useAppStore } from "../stores/appStore";
import { useProjectStore } from "../stores/projectStore";
import { MissingAssetsDialog } from "./MissingAssetsDialog";
import { ProjectDialog, type DialogMode } from "./ProjectDialog";

export function LauncherPage() {
  const mode = useAppStore((state) => state.config?.capabilities.mode ?? "web");
  const phase = useAppStore((state) => state.phase);
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [pendingCheck, setPendingCheck] = useState<SelfCheckReport | null>(null);

  const refreshRecents = useCallback(() => {
    recentApi
      .list()
      .then(setRecents)
      .catch(() => setRecents([]));
  }, []);

  useEffect(refreshRecents, [refreshRecents]);

  const enterProject = useCallback((selfCheck: SelfCheckReport) => {
    if (selfCheck.ok) {
      useAppStore.getState().setPhase("editing");
    } else {
      // Hold in "opening" until the user chooses how to proceed.
      setPendingCheck(selfCheck);
    }
  }, []);

  const cancelOpen = useCallback(() => {
    setPendingCheck(null);
    useProjectStore.getState().close();
    useAppStore.getState().setPhase("launcher");
  }, []);

  const openRecent = useCallback(
    async (path: string) => {
      useAppStore.getState().setPhase("opening");
      try {
        enterProject(await useProjectStore.getState().open(path));
      } catch (error) {
        useAppStore.getState().setPhase("launcher");
        useAppStore
          .getState()
          .pushToast(
            "error",
            error instanceof Error ? error.message : "Open failed",
          );
      }
    },
    [enterProject],
  );

  const removeRecent = useCallback(
    async (id: string) => {
      try {
        await recentApi.remove(id);
        refreshRecents();
      } catch {
        // The entry stays visible; the next refresh re-syncs.
      }
    },
    [refreshRecents],
  );

  const busy = phase === "opening" && pendingCheck === null;

  return (
    <div className="launcher">
      <header className="launcher-hero">
        <span className="brand-mark" aria-hidden="true">
          M
        </span>
        <h1>Moka Canvas</h1>
        <p>
          Local-first video workflow boards, saved as plain project folders.
        </p>
      </header>

      <section aria-label="Recent projects" className="launcher-recents">
        <h2>Recent projects</h2>
        {recents === null ? (
          <p className="launcher-empty">Loading…</p>
        ) : recents.length === 0 ? (
          <p className="launcher-empty">
            No projects yet. Create one to get started.
          </p>
        ) : (
          <ul>
            {recents.map((project) => (
              <li key={project.id}>
                <button
                  className="launcher-recent"
                  disabled={busy}
                  onClick={() => void openRecent(project.path)}
                  type="button"
                >
                  <strong>{project.name}</strong>
                  <span>{project.path}</span>
                </button>
                <button
                  aria-label={`Remove ${project.name} from recent projects`}
                  className="launcher-recent-remove"
                  onClick={() => void removeRecent(project.id)}
                  type="button"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="launcher-actions">
        <button
          disabled={busy}
          onClick={() => setDialog("create")}
          type="button"
        >
          New project
        </button>
        <button disabled={busy} onClick={() => setDialog("open")} type="button">
          Open project
        </button>
        <button
          disabled={busy}
          onClick={() => setDialog("import")}
          type="button"
        >
          Import package
        </button>
      </div>

      {busy && <p className="launcher-busy">Opening project…</p>}

      {dialog && (
        <ProjectDialog
          mode={dialog}
          nativePickers={mode === "tauri"}
          onClose={() => setDialog(null)}
          onDone={enterProject}
        />
      )}

      {pendingCheck && (
        <MissingAssetsDialog
          onCancel={cancelOpen}
          onOpenAnyway={() => {
            setPendingCheck(null);
            useAppStore.getState().setPhase("editing");
          }}
          onReportChange={setPendingCheck}
          report={pendingCheck}
        />
      )}
    </div>
  );
}
