import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { assetUrl, assetsApi } from "../../../api/assets";
import { isApiError } from "../../../api/client";
import { findResource } from "../../../shared/domain";
import type {
  StoryDocument,
  TimelineDocument,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { errorText } from "../../../api/client";
import { formatDuration } from "../../../shared/domain/story";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { saveTrouble, useProjectStore } from "../../editor/stores/projectStore";
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
 * here decides anything about the artifact — it asks, it watches, and it writes
 * down what came back. The film is an asset like any other, which is why it can
 * be played here, opened in the cutting room, or found on the shelf.
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

  // The artifact is filed by the server, so a finished render is read back out
  // of the document rather than guessed at: the file it became is what the step
  // shows, and what the next opening of the room finds. The story is watched by
  // its id rather than by the object, because a read replaces the document
  // whole: an effect watching the object would run again on the read it had
  // just made, and the write inside that read would be cancelled by the
  // successor the read began — a read that feeds itself, and a film never
  // written down.
  const done =
    task?.status === "done" && task.assetId !== undefined ? task : undefined;
  useEffect(() => {
    if (done === undefined || done.assetId === film?.assetIds[0]) return;
    let alive = true;
    void useProjectStore
      .getState()
      .reload()
      .then((adopted) => {
        if (!alive) return;
        if (!adopted) {
          // The same as the catch below, with the work still on its way as
          // the reason: the film is made and filed, but the shelf was not
          // read back, so it is not written down here yet.
          const blocked = saveTrouble();
          useAppStore
            .getState()
            .pushToast("error", blocked.message, undefined, blocked.detail);
          return;
        }
        const assetId = done.assetId;
        if (assetId === undefined) return;
        const held = useProjectStore.getState().moka;
        const name =
          held === null
            ? assetId
            : (findResource(held, assetId)?.name ?? assetId);
        execute(i18n.t("story:history.assemble"), [
          {
            type: "setStoryEdit",
            storyId: story.id,
            patch: {
              film: {
                assetIds: [assetId],
                jobId: done.id,
                itemId: "export",
                note: name,
                createdAt: new Date().toISOString(),
              },
            },
          },
        ]);
        useAppStore
          .getState()
          .pushToast("success", i18n.t("story:edit.filmReady"), {
            label: i18n.t("story:edit.openInClip"),
            go: () => openInCuttingRoom(story.id),
          });
      })
      .catch((problem: unknown) => {
        // The film is made and filed, but this room could not read the shelf
        // back, so it is not written down here yet. Said rather than passed
        // over: a reader who does not see the notice and finds no film will
        // look for it in the wrong place.
        const trouble = errorText(problem);
        useAppStore
          .getState()
          .pushToast("error", trouble.message, undefined, trouble.detail);
      });
    return () => {
      alive = false;
    };
  }, [done, film?.assetIds, story.id]);

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
      const started = await clipApi.start(timeline.id);
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
              onClick={() => openInCuttingRoom(story.id, true)}
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
            onClick={() => void openInCuttingRoom(story.id)}
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
 * of. The telling is read again after that flush, for the same reason and for
 * the toast that offers this way over: it holds the telling from the moment
 * the offer was made, which the room may have written to since. A save that
 * cannot land keeps the reader where they are rather than walking away from
 * work.
 */
async function openInCuttingRoom(
  storyId: string,
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
  const story = (after.moka?.stories ?? []).find((held) => held.id === storyId);
  if (story?.edit.timelineId === undefined) return;
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
