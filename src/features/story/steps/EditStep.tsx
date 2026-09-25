import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoryDocument } from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useAppStore } from "../../editor/stores/appStore";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useModelStore } from "../../settings/modelStore";
import { saveEverything } from "../stores/storyJobStore";
import {
  assemblyCommands,
  assemblySummary,
  planAssembly,
  type AssemblyPlan,
  type AssemblyWarning,
} from "../assembly";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { FilmCard } from "../panels/FilmCard";
import { useStoryStore } from "../stores/storyStore";

/** How many warnings are listed before the rest are counted. */
const WARNINGS_SHOWN = 5;

/**
 * The fifth step: a telling's clips laid end to end, rendered, and handed over.
 *
 * The step does two things and says what it is doing at each: it assembles the
 * clips the fourth step made onto a timeline of the telling's own, and it asks
 * the server to render that timeline into one file. Neither is guessed at —
 * the plan behind the assembly is shown before it is applied, and a machine
 * that cannot render says so rather than failing when pressed.
 */
export function EditStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [withSubtitles, setWithSubtitles] = useState(true);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const plan: AssemblyPlan =
    moka === null
      ? { units: [], warnings: [], totalPlannedMs: 0 }
      : planAssembly(story, moka);
  const timeline = (moka?.timelines ?? []).find(
    (held) => held.id === story.edit.timelineId,
  );
  const spoken = story.chapters
    .flatMap((chapter) => chapter.acts)
    .flatMap((act) => act.keyframes)
    .some((keyframe) => keyframe.dialogue.length > 0);
  // A telling that has been voiced or scored brings rows of its own with it,
  // and a clip that carries its own sound is worth warning about before a
  // reader hears two scores fighting in the cutting room.
  const sounded = story.chapters.some((chapter) =>
    chapter.acts.some(
      (act) => act.voice !== undefined || act.music !== undefined,
    ),
  );
  const videoSound =
    useModelStore.getState().view?.preferences.video.generateAudio === true;
  const mine = new Set(
    (story.edit.clipByAct ?? []).map((entry) => entry.clipId),
  );
  // A timeline the reader has also worked on: what is on it and not this
  // story's, or this story's clips that somebody has since taken away.
  const foreign =
    timeline === undefined
      ? 0
      : timeline.clips.filter((clip) => !mine.has(clip.id)).length +
        (mine.size > 0
          ? [...mine].filter(
              (clipId) => !timeline.clips.some((clip) => clip.id === clipId),
            ).length
          : 0);

  const assemble = async () => {
    setBusy(true);
    setAsking(false);
    try {
      // The server holds the document the clips are laid down in, and the
      // material they are made of is filed there rather than here: what is
      // still in this window goes out first, and only then is the document read
      // back — reading it first would throw the waiting work away.
      if (!(await saveEverything())) {
        useAppStore
          .getState()
          .pushToast("error", i18n.t("story:common.stillSaving"));
        return;
      }
      await useProjectStore.getState().reload();
      const held = useProjectStore.getState().moka;
      const current =
        held === null
          ? undefined
          : (held.stories ?? []).find((each) => each.id === story.id);
      if (held === null || current === undefined) return;
      const fresh = planAssembly(current, held);
      const { commands, clipByAct } = assemblyCommands(current, held, fresh, {
        withSubtitles,
        ...(current.edit.timelineId === undefined
          ? {}
          : { timelineId: current.edit.timelineId }),
      });
      const added = commands.find((command) => command.type === "addTimeline");
      const timelineId =
        added?.type === "addTimeline"
          ? added.timeline.id
          : current.edit.timelineId;
      if (timelineId === undefined) return;
      execute(i18n.t("story:history.assemble"), [
        ...commands,
        {
          type: "setStoryEdit",
          storyId: current.id,
          patch: { timelineId, clipByAct },
        },
      ]);
      const seconds = (fresh.totalPlannedMs / 1000).toFixed(1);
      useAppStore.getState().pushToast(
        "success",
        i18n.t("story:edit.assembled", {
          count: fresh.units.length,
          seconds,
        }),
      );
    } catch (problem) {
      useAppStore
        .getState()
        .pushToast(
          "error",
          problem instanceof Error ? problem.message : String(problem),
        );
    } finally {
      setBusy(false);
    }
  };

  const pressAssemble = () => {
    if (foreign > 0) {
      setAsking(true);
      return;
    }
    void assemble();
  };

  return (
    <div className="story-step-scroll" data-testid="story-step-edit-body">
      <div className="story-step-narrow">
        <h2>{t("story:step.edit")}</h2>
        <p className="story-step-lead">{t("story:edit.lead")}</p>

        <section className="story-assembly" data-testid="story-assembly">
          <h3>{t("story:edit.assemble")}</h3>
          <p className="story-hint" data-testid="story-assembly-summary">
            {assemblySummary(story, plan)}
          </p>

          <label className="story-check">
            <input
              checked={withSubtitles}
              data-testid="story-assembly-subtitles"
              disabled={!spoken}
              onChange={(event) => setWithSubtitles(event.target.checked)}
              type="checkbox"
            />
            {t("story:edit.withSubtitles")}
          </label>
          <p className="story-hint">
            {spoken ? t("story:edit.subtitlesNote") : t("story:edit.noLines")}{" "}
            {t("story:edit.againNote")}
          </p>

          {sounded && (
            <p className="story-hint" data-testid="story-assembly-sound">
              {t("story:edit.soundNote")}
              {videoSound ? ` ${t("story:edit.ownSoundNote")}` : ""}
            </p>
          )}

          {plan.warnings.length > 0 && (
            <div
              className="story-warnings"
              data-testid="story-assembly-warnings"
            >
              <ul>
                {plan.warnings.slice(0, WARNINGS_SHOWN).map((warning, at) => (
                  <li key={at}>
                    <span>{warningLine(warning)}</span>
                    <button
                      className="link"
                      data-testid={`story-warning-go-${at}`}
                      onClick={() => goFill(warning.chapterId)}
                      type="button"
                    >
                      {t("story:edit.goFill")}
                    </button>
                  </li>
                ))}
                {plan.warnings.length > WARNINGS_SHOWN && (
                  <li className="story-hint">
                    {t("story:edit.warnings", {
                      count: plan.warnings.length - WARNINGS_SHOWN,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}

          <div className="story-step-actions">
            <button
              className="primary"
              data-testid="story-assemble"
              disabled={busy || plan.units.length === 0}
              onClick={pressAssemble}
              title={
                plan.units.length === 0
                  ? t("story:edit.nothingToAssemble")
                  : undefined
              }
              type="button"
            >
              {story.edit.timelineId === undefined
                ? t("story:edit.assemble")
                : t("story:edit.reassemble")}
            </button>
          </div>
        </section>

        <FilmCard
          onAssembleAgain={pressAssemble}
          story={story}
          timeline={timeline}
        />

        <section className="story-film-clips" data-testid="story-clips">
          <h3>{t("story:edit.clips", { count: plan.units.length })}</h3>
          <ol className="story-clip-list">
            {plan.units.map((unit, at) => (
              <li
                className="story-clip-row"
                data-testid={`story-clip-${at}`}
                key={`${unit.actId}:${unit.keyframeId ?? ""}`}
              >
                <span className="story-col-index">{at + 1}</span>
                <span>
                  {unit.keyframeId === undefined
                    ? t("story:edit.clipLine", {
                        chapter: unit.chapterIndex,
                        act: unit.actIndex,
                      })
                    : t("story:edit.clipFrameLine", {
                        chapter: unit.chapterIndex,
                        act: unit.actIndex,
                        shot: shotNumber(story, unit.keyframeId),
                      })}
                </span>
                <span className="story-count">
                  {(unit.durationMs / 1000).toFixed(1)}s
                </span>
                <span className="story-hint">
                  {unit.confirmed ? "✓" : t("story:edit.unconfirmedShort")}
                </span>
              </li>
            ))}
            {plan.units.length === 0 && (
              <li className="story-hint" data-testid="story-clips-empty">
                {t("story:edit.nothingToAssemble")}
              </li>
            )}
          </ol>
        </section>
      </div>

      {asking && (
        <ConfirmDialog
          body={t("story:edit.rebuildBody")}
          confirm={t("story:edit.rebuildConfirm")}
          onCancel={() => setAsking(false)}
          onConfirm={() => void assemble()}
          testId="rebuild-timeline"
          title={t("story:edit.rebuildTitle", { count: foreign })}
        />
      )}
    </div>
  );
}

/** Which shot of its act a shot is, counted from one. */
function shotNumber(story: StoryDocument, keyframeId: string): number {
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      const at = act.keyframes.findIndex((held) => held.id === keyframeId);
      if (at >= 0) return at + 1;
    }
  }
  return 0;
}

/** One warning, in the reader's language. */
function warningLine(warning: AssemblyWarning): string {
  return i18n.t(`story:edit.${warning.kind}`, { place: warning.place });
}

/** Standing on the step where the missing clip can be made. */
function goFill(chapterId: string): void {
  useStoryStore.getState().openChapter(chapterId);
  useStoryStore.getState().goStep("storyboard");
}
