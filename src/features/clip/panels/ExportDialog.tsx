import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { filesystemApi } from "../../../api";
import type { TimelineDocument } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { formatDuration } from "../../editor/canvas/mediaCards";
import { askSavePath, fileSafeName } from "../../editor/launcher/savePath";
import { useProjectStore } from "../../editor/stores/projectStore";
import { clipApi } from "../api";
import type { ClipCapabilities } from "../api";
import { useClipStore } from "../stores/clipStore";
import { useExportStore } from "../stores/exportStore";

/** How often a running render is looked at, in milliseconds. */
const POLL_MS = 700;

/**
 * Rendering a timeline to a file, and saying what happened.
 *
 * Three states and one machine: asking, waiting, and an answer. The work is
 * the server's from the moment it is asked for — closing this dialog does not
 * cancel a render, and reopening it picks the handle back up — so nothing here
 * decides anything about the render, it only reports.
 *
 * Where the file goes is the reader's to say, asked once per export: the
 * render writes the path it was told and nowhere else.
 *
 * What the machine can do is read once per opening and shown as it stands: a
 * machine without a renderer is not a broken dialog, it is a dialog that says
 * so and offers nothing to press.
 */
export function ExportDialog() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const task = useExportStore((state) => state.task);
  const error = useExportStore((state) => state.error);
  const [capabilities, setCapabilities] = useState<ClipCapabilities | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const timeline =
    (moka?.timelines ?? []).find((held) => held.id === activeTimelineId) ??
    null;
  const close = () => useExportStore.getState().setOpen(false);

  // What this machine can do, asked once each time the dialog is opened: the
  // answer cannot change while the process runs.
  useEffect(() => {
    let live = true;
    clipApi
      .capabilities()
      .then((answer) => live && setCapabilities(answer))
      .catch((problem: Error) =>
        live ? useExportStore.getState().setError(problem.message) : undefined,
      );
    return () => {
      live = false;
    };
  }, []);

  // Picking a render back up: the handle was kept in the store, so a dialog
  // that was closed over a running render comes back to it rather than
  // starting a second one.
  useEffect(() => {
    const remembered = useExportStore.getState().task;
    if (!remembered || remembered.timelineId !== timeline?.id) return;
    if (remembered.status !== "queued" && remembered.status !== "running") {
      return;
    }
    let live = true;
    clipApi
      .status(remembered.id)
      .then((next) => {
        if (live) useExportStore.getState().setTask(next);
      })
      .catch(() => {
        // A handle the server does not know is a render that died with a
        // restart; the dialog goes back to asking.
        if (live) useExportStore.getState().setTask(null);
      });
    return () => {
      live = false;
    };
  }, [timeline?.id]);

  // Polling while a render is live, and only then.
  const live = task?.status === "queued" || task?.status === "running";
  useEffect(() => {
    if (!task || !live) return;
    const id = task.id;
    const timer = window.setInterval(() => {
      clipApi
        .status(id)
        .then((next) => useExportStore.getState().setTask(next))
        .catch((problem: Error) =>
          useExportStore.getState().setError(problem.message),
        );
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [task?.id, live, task]);

  // The artifact is written by the server to the path the reader chose, and
  // this dialog only reports what the task says about it: there is nothing in
  // the project to read back.
  const savedTo = task?.status === "done" ? task.savedTo : undefined;

  if (!timeline) return null;
  const worded = timeline.clips.some((clip) => clip.kind === "text");
  const totalMs = timeline.clips.reduce(
    (end, clip) => Math.max(end, clip.startMs + clip.durationMs),
    0,
  );
  // Three ways the one button cannot be pressed, each with its own reason.
  const blocked = !capabilities?.available
    ? (capabilities?.reason ?? t("clip:exportDialog.notAvailable"))
    : timeline.clips.length === 0
      ? t("clip:exportDialog.nothingToRender")
      : worded && !capabilities.ass
        ? t("clip:exportDialog.noAss")
        : null;

  const start = async () => {
    setBusy(true);
    useExportStore.getState().setError(null);
    try {
      // A retry of a render that failed or was stopped goes where that render
      // was going; a new export starts by asking, as does one after a finished
      // render — a file that is already there is not quietly written over.
      const held = useExportStore.getState();
      const again = held.task !== null && held.task.status !== "done";
      let destination = again ? held.destination : null;
      if (destination === null) {
        destination = await askSavePath({
          title: t("clip:exportDialog.saveTitle"),
          defaultName: `${fileSafeName(timeline.name)}.mp4`,
          extensions: ["mp4"],
        });
        if (destination === null) return;
        useExportStore.getState().setDestination(destination);
      }
      const started = await clipApi.start(timeline.id, destination);
      useExportStore.getState().setTask(started);
    } catch (problem) {
      useExportStore
        .getState()
        .setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!task) return;
    setBusy(true);
    try {
      const stopped = await clipApi.cancel(task.id);
      useExportStore.getState().setTask(stopped);
    } catch (problem) {
      useExportStore
        .getState()
        .setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  const states = summary(timeline, totalMs);
  // What the dialog says went wrong: a refusal to start, or a render that
  // ended badly, which is the message the server wrote down.
  const problem =
    error ??
    (task && !live && task.status !== "done" ? task.message : undefined);

  return (
    <div
      aria-label={t("clip:exportDialog.title")}
      aria-modal="true"
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="dialog"
    >
      <div className="dialog clip-export-dialog">
        <h2>{t("clip:exportDialog.title")}</h2>
        <p className="dialog-note">{states}</p>
        <p
          className="clip-export-capability"
          data-testid="clip-export-capability"
        >
          {capabilities === null
            ? t("clip:exportDialog.looking")
            : capabilities.available
              ? `ffmpeg ${capabilities.version ?? t("clip:exportDialog.unknown")} · ${capabilities.path ?? ""}`
              : (capabilities.reason ?? t("clip:exportDialog.notAvailable"))}
        </p>

        {live && task ? (
          <div className="clip-export-progress">
            <div
              aria-label={t("clip:exportDialog.progress")}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={Math.round(task.progress01 * 100)}
              className="clip-export-bar"
              role="progressbar"
            >
              <span
                style={{ width: `${Math.round(task.progress01 * 100)}%` }}
              />
            </div>
            <p className="clip-export-percent">
              {`${Math.round(task.progress01 * 100)}%`}
            </p>
          </div>
        ) : null}

        {savedTo !== undefined ? (
          <p className="clip-export-done" data-testid="clip-export-done">
            {t("clip:exportDialog.saved", { path: savedTo })}
          </p>
        ) : null}

        {problem ? (
          <p className="clip-export-error" role="alert">
            {problem}
          </p>
        ) : null}

        <div className="dialog-actions">
          {live ? (
            <button disabled={busy} onClick={() => void cancel()} type="button">
              {t("clip:common.cancel")}
            </button>
          ) : (
            <button onClick={close} type="button">
              {task?.status === "done"
                ? t("clip:exportDialog.done")
                : t("clip:exportDialog.close")}
            </button>
          )}
          {savedTo !== undefined ? (
            <button
              data-testid="clip-export-reveal"
              onClick={() => void reveal(savedTo)}
              type="button"
            >
              {t("clip:exportDialog.reveal")}
            </button>
          ) : null}
          {!live && task?.status !== "done" ? (
            <button
              className="primary"
              disabled={busy || blocked !== null}
              onClick={() => void start()}
              title={blocked ?? undefined}
              type="button"
            >
              {task?.status === "failed" || task?.status === "cancelled"
                ? t("clip:exportDialog.tryAgain")
                : t("clip:exportDialog.title")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Opens the finished file in this machine's file manager, and says so when it
 * cannot rather than failing silently.
 */
async function reveal(path: string) {
  try {
    await filesystemApi.reveal(path);
  } catch (problem) {
    useExportStore
      .getState()
      .setError(problem instanceof Error ? problem.message : String(problem));
  }
}

/** The one line the dialog says about the cut, before anything is pressed. */
function summary(timeline: TimelineDocument, totalMs: number): string {
  const { width, height, fps } = timeline.settings;
  const clips = timeline.clips.length;
  const noun = i18n.t(
    clips === 1 ? "clip:common.clipOne" : "clip:common.clipMany",
  );
  return `${timeline.name} · ${width}×${height} · ${fps} fps · ${formatDuration(
    totalMs,
  )} · ${clips} ${noun}`;
}
