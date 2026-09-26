import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { recentApi, type RecentProject } from "../../../api";
import type { SelfCheckReport } from "../../../shared/domain";
import { useModelStore } from "../../settings/modelStore";
import { useAppStore, type AppPhase } from "../stores/appStore";
import { useProjectStore } from "../stores/projectStore";
import { MissingAssetsDialog } from "./MissingAssetsDialog";
import { ProjectDialog, type DialogMode } from "./ProjectDialog";

/**
 * The rooms a recent project can be opened onto, in telling order.
 *
 * A row is taken to be a way into the work rather than a way into one room of
 * it, so which room is meant is answered before the project is put on — the
 * board a reader did not ask for is never built on the way past it.
 */
type Room = "story" | "canvas" | "clip";

const ROOMS: Room[] = ["story", "canvas", "clip"];

const ROOM_PHASE: Record<Room, AppPhase> = {
  story: "story",
  canvas: "editing",
  clip: "clip",
};

const ROOM_LABEL: Record<Room, string> = {
  story: "app:homeMenu.story",
  canvas: "app:homeMenu.canvas",
  clip: "app:homeMenu.clip",
};

export function LauncherPage() {
  const { t } = useTranslation();
  const mode = useAppStore((state) => state.config?.capabilities.mode ?? "web");
  const phase = useAppStore((state) => state.phase);
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  // Which row stands open over its rooms, if any.
  const [roomsFor, setRoomsFor] = useState<string | null>(null);
  const [pendingCheck, setPendingCheck] = useState<{
    report: SelfCheckReport;
    onto: AppPhase;
  } | null>(null);

  const refreshRecents = useCallback(() => {
    recentApi
      .list()
      .then(setRecents)
      .catch(() => setRecents([]));
  }, []);

  useEffect(refreshRecents, [refreshRecents]);

  const enterProject = useCallback(
    (selfCheck: SelfCheckReport, onto: AppPhase = "editing") => {
      if (selfCheck.ok) {
        useAppStore.getState().setPhase(onto);
      } else {
        // Hold in "opening" until the user chooses how to proceed.
        setPendingCheck({ report: selfCheck, onto });
      }
    },
    [],
  );

  const cancelOpen = useCallback(() => {
    setPendingCheck(null);
    useProjectStore.getState().close();
    useAppStore.getState().setPhase("launcher");
  }, []);

  const openRecent = useCallback(
    async (path: string, onto: AppPhase) => {
      useAppStore.getState().setPhase("opening");
      try {
        enterProject(await useProjectStore.getState().open(path), onto);
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
        <div className="launcher-hero-words">
          <h1>{t("app:name")}</h1>
          <p>{t("app:tagline")}</p>
        </div>
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
            {recents.map((project) => {
              const roomsOpen = roomsFor === project.id;
              return (
                <li key={project.id}>
                  <div className="launcher-recent-head">
                    <button
                      aria-expanded={roomsOpen}
                      className="launcher-recent"
                      disabled={busy}
                      onClick={() => setRoomsFor(roomsOpen ? null : project.id)}
                      type="button"
                    >
                      <strong title={project.name}>{project.name}</strong>
                      <span title={project.path}>{project.path}</span>
                    </button>
                    <button
                      aria-label={t("app:removeRecent", { name: project.name })}
                      className="launcher-recent-remove"
                      onClick={() => void removeRecent(project.id)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                  {roomsOpen && (
                    <div
                      aria-label={t("app:openRecentRooms", {
                        name: project.name,
                      })}
                      className="launcher-recent-rooms"
                      role="group"
                    >
                      {ROOMS.map((room) => (
                        <button
                          disabled={busy}
                          key={room}
                          onClick={() =>
                            void openRecent(project.path, ROOM_PHASE[room])
                          }
                          type="button"
                        >
                          {t(ROOM_LABEL[room])}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
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
            const onto = pendingCheck.onto;
            setPendingCheck(null);
            useAppStore.getState().setPhase(onto);
          }}
          onReportChange={(report) =>
            setPendingCheck((held) => (held ? { ...held, report } : held))
          }
          report={pendingCheck.report}
        />
      )}
    </div>
  );
}
