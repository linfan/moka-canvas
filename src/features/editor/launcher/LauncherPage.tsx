import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { recentApi, type RecentProject } from "../../../api";
import type { SelfCheckReport } from "../../../shared/domain";
import { useModelStore } from "../../settings/modelStore";
import { useAppStore } from "../stores/appStore";
import { useProjectStore } from "../stores/projectStore";
import { MissingAssetsDialog } from "./MissingAssetsDialog";
import { ProjectDialog, type DialogMode } from "./ProjectDialog";

export function LauncherPage() {
  const { t } = useTranslation();
  const mode = useAppStore((state) => state.config?.capabilities.mode ?? "web");
  const phase = useAppStore((state) => state.phase);
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [pendingCheck, setPendingCheck] = useState<SelfCheckReport | null>(
    null,
  );

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
            error instanceof Error ? error.message : t("app:openFailed"),
          );
      }
    },
    [enterProject, t],
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
        {/* The same artwork the packaged app and the browser tab use. */}
        <img
          alt=""
          aria-hidden="true"
          className="brand-mark"
          src="/favicon.png"
        />
        <h1>{t("app:name")}</h1>
        <p>{t("app:tagline")}</p>
      </header>

      <section
        aria-label={t("app:recentProjects")}
        className="launcher-recents"
      >
        <h2>{t("app:recentProjects")}</h2>
        {recents === null ? (
          <p className="launcher-empty">{t("app:loading")}</p>
        ) : recents.length === 0 ? (
          <p className="launcher-empty">{t("app:noProjects")}</p>
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
                  aria-label={t("app:removeRecent", { name: project.name })}
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
          {t("app:newProject")}
        </button>
        <button disabled={busy} onClick={() => setDialog("open")} type="button">
          {t("app:openProject")}
        </button>
        <button
          disabled={busy}
          onClick={() => setDialog("import")}
          type="button"
        >
          {t("app:importProject")}
        </button>
        <button
          data-testid="launcher-settings"
          disabled={busy}
          onClick={() => useModelStore.getState().openSettings()}
          type="button"
        >
          {t("app:settings")}
        </button>
      </div>

      {busy && <p className="launcher-busy">{t("app:opening")}</p>}

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
