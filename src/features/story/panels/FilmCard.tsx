import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { assetUrl, assetsApi } from "../../../api/assets";
import { isApiError } from "../../../api/client";
import { findResource } from "../../../shared/domain";
import type {
  StoryDocument,
  TimelineDocument,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { formatDuration } from "../../../shared/domain/story";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { clipApi, type ClipCapabilities } from "../../clip/api";
import { useClipStore } from "../../clip/stores/clipStore";
import { useExportStore } from "../../clip/stores/exportStore";
import { useStoryExportStore } from "../stores/storyExportStore";

/** How often a running render is looked at, in milliseconds. */
const POLL_MS = 700;

/**
 * The finished film: what rendering the telling produced, and the one button
 * that makes it.
 *
 * Rendering is the server's work from the moment it is asked for, so nothing
 * here decides anything about the artifact — it asks where the file should
 * land, it watches, and it says where the file went. The render is not filed
 * among the project's assets: the reader chose a path, and that path is the
 * only place the film lives.
 */
export function FilmCard({
  story,
  timeline,
  onAssembleAgain,
}: {
  story: StoryDocument;
  /** The timeline the telling was laid down on, if the document still has it. */
  timeline: TimelineDocument | undefined;
  onAssembleAgain: () => void;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const task = useStoryExportStore((state) => state.task);
  const error = useStoryExportStore((state) => state.error);
  const [capabilities, setCapabilities] = useState<ClipCapabilities | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const live = task?.status === "queued" || task?.status === "running";
  const film = story.edit.film;

  // What this machine can do, asked once: the answer cannot change while the
  // process runs, and a machine without a renderer is not a broken step — it is
  // a step that says so and offers nothing to press.
  useEffect(() => {
    let alive = true;
    clipApi
      .capabilities()
      .then((answer) => {
        if (alive) setCapabilities(answer);
      })
      .catch((problem: Error) => {
        if (alive) useStoryExportStore.getState().setError(problem.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  // A finished render has nowhere to be filed — the file is the reader's, at
  // the path they chose — so all that is left to do is say so, once, and offer
  // the way into the cutting room where the same telling can be worked on.
  const done = task?.status === "done" ? task : undefined;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (done === undefined || announced.current === done.id) return;
    announced.current = done.id;
    useAppStore
      .getState()
      .pushToast("success", i18n.t("story:edit.filmReady"), {
        label: i18n.t("story:edit.openInClip"),
        go: () => openInCuttingRoom(story),
      });
  }, [done, story]);

  // Polling while a render is live, and only then.
  useEffect(() => {
    if (task === null || !live) return;
    const id = task.id;
    const timer = window.setInterval(() => {
      clipApi
        .status(id)
        .then((next) => useStoryExportStore.getState().setTask(next))
        .catch((problem: Error) =>
          useStoryExportStore.getState().setError(problem.message),
        );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [task?.id, live, task]);

  const start = async () => {
    if (timeline === undefined) return;
    setBusy(true);
    useStoryExportStore.getState().setError(null);
    try {
      // A retry of a render that failed or was stopped goes where that render
      // was going; a fresh export starts by asking, since a render that made
      // its film already has a file that must not be quietly written over.
      const held = useStoryExportStore.getState();
      const again = held.task !== null && held.task.status !== "done";
      const destination = again
        ? held.destination
        : await askSavePath({
            title: t("story:edit.saveTitle"),
            defaultName: `${fileSafeName(timeline.name)}.mp4`,
            extensions: ["mp4"],
          });
      if (destination === null) return;
      useStoryExportStore.getState().setDestination(destination);
      const started = await clipApi.start(timeline.id, destination);
      useStoryExportStore.getState().setTask(started);
    } catch (problem) {
      useStoryExportStore
        .getState()
        .setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (task === null) return;
    setBusy(true);
    try {
      const stopped = await clipApi.cancel(task.id);
      useStoryExportStore.getState().setTask(stopped);
    } catch (problem) {
      useStoryExportStore
        .getState()
        .setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const blocked =
    timeline === undefined
      ? t("story:edit.noTimeline")
      : !capabilities?.available
        ? (capabilities?.reason ?? t("story:edit.noFfmpeg"))
        : timeline.clips.length === 0
          ? t("story:edit.nothingToRender")
          : null;
  const resource =
    film === undefined || moka === null
      ? undefined
      : findResource(moka, film.assetIds[0]);
  const problem =
    error ??
    (task !== null && !live && task.status !== "done"
      ? task.message
      : undefined);
  const refused = isApiError(error, "BUSY");

  return (
    <section className="story-film-card" data-testid="story-film">
      <h3>{t("story:edit.film")}</h3>

      {/* What this machine can do, in words rather than in a button's title:
          a reader whose host cannot render should read why without hovering. */}
      {capabilities !== null && !capabilities.available && (
        <p className="story-hint" data-testid="story-film-capability">
          {capabilities.reason ?? t("story:edit.noFfmpeg")}
        </p>
      )}

      {film === undefined ? (
        <p className="story-hint" data-testid="story-film-none">
          {t("story:edit.noFilm")}
        </p>
      ) : (
        <>
          <video
            className="story-film-video"
            controls
            data-testid="story-film-video"
            preload="metadata"
            src={assetUrl(film.assetIds[0])}
          />
          <p className="story-hint" data-testid="story-film-line">
            {t("story:edit.filmLine", {
              name: resource?.name ?? film.assetIds[0],
              duration: formatDuration(resource?.probe?.durationMs ?? 0),
              size:
                resource?.probe?.width === undefined
                  ? ""
                  : `${resource.probe.width}×${resource.probe.height ?? ""}`,
            })}
          </p>
        </>
      )}

      {done?.savedTo !== undefined && (
        <p className="story-hint" data-testid="story-film-saved">
          {t("story:edit.filmSaved", { path: done.savedTo })}
        </p>
      )}

      {live && task !== null && (
        <div className="clip-export-progress" data-testid="story-film-progress">
          <div
            aria-label={t("story:edit.exporting")}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(task.progress01 * 100)}
            className="clip-export-bar"
            role="progressbar"
          >
            <span style={{ width: `${Math.round(task.progress01 * 100)}%` }} />
          </div>
          <p className="clip-export-percent">
            {`${Math.round(task.progress01 * 100)}%`}
          </p>
        </div>
      )}

      {problem !== undefined && (
        <p className="story-hint" data-testid="story-film-error" role="alert">
          {problem}
          {refused && (
            <button
              className="link"
              data-testid="story-film-watch"
              onClick={() => openInCuttingRoom(story, true)}
              type="button"
            >
              {t("story:edit.watchExport")}
            </button>
          )}
        </p>
      )}

      <div className="story-step-actions">
        {live ? (
          <button
            data-testid="story-film-cancel"
            disabled={busy}
            onClick={() => void cancel()}
            type="button"
          >
            {t("story:panels.cancel")}
          </button>
        ) : (
          <button
            className="primary"
            data-testid="story-film-export"
            disabled={busy || blocked !== null}
            onClick={() => void start()}
            title={blocked ?? undefined}
            type="button"
          >
            {film === undefined
              ? t("story:edit.export")
              : t("story:edit.exportAgain")}
          </button>
        )}
        {/* The way into the cutting room is the timeline's, not the film's: a
            cut that has only been assembled is exactly the one a reader wants
            to go on working on. */}
        {timeline !== undefined && (
          <button
            data-testid="story-film-open"
            onClick={() => void openInCuttingRoom(story)}
            type="button"
          >
            {t("story:edit.openInClip")}
          </button>
        )}
        {film !== undefined && (
          <button
            data-testid="story-film-reveal"
            onClick={() => void reveal(film.assetIds[0])}
            type="button"
          >
            {t("story:edit.reveal")}
          </button>
        )}
        <button
          className="link"
          data-testid="story-film-reassemble"
          onClick={onAssembleAgain}
          type="button"
        >
          {t("story:edit.reassemble")}
        </button>
      </div>
    </section>
  );
}

/**
 * Leaves the story room for the cutting room, with this telling's timeline open.
 *
 * The project is flushed first: a film is exported from the timeline the server
 * holds, and one that is still in this window is a timeline it has never heard
 * of. A save that cannot land keeps the reader where they are rather than
 * walking away from work.
 */
async function openInCuttingRoom(
  story: StoryDocument,
  withExportDialog = false,
): Promise<void> {
  const project = useProjectStore.getState();
  await project.flush();
  const after = useProjectStore.getState();
  if (after.pending.length > 0 || after.saveStatus === "conflicted") {
    useAppStore
      .getState()
      .pushToast(
        "error",
        after.saveStatus === "conflicted"
          ? i18n.t("story:page.saveConflict")
          : (after.saveError ?? i18n.t("story:page.saveFailed")),
      );
    return;
  }
  if (story.edit.timelineId === undefined) return;
  useClipStore.getState().setActiveTimeline(story.edit.timelineId);
  useAppStore.getState().setPhase("clip");
  if (withExportDialog) {
    useExportStore.getState().setOpen(true);
    useExportStore.getState().setTask(null);
  }
}

/** Opens the film in this machine's file manager, saying so when it cannot. */
async function reveal(assetId: string): Promise<void> {
  try {
    await assetsApi.reveal(assetId);
  } catch (problem) {
    useAppStore
      .getState()
      .pushToast(
        "error",
        problem instanceof Error ? problem.message : String(problem),
      );
  }
}
