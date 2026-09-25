import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { StoryJobRecord } from "../../../api/story";
import {
  actVideoSettled,
  actsRegenerationCost,
  chunkWaves,
  formatDuration,
  keyframeCount,
  targetKey,
  type StoryAct,
  type StoryChapter,
  type StoryDocument,
  type StoryGuess,
  type StoryShotGranularity,
} from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StoryModelPicks } from "../components/StoryModelPicks";
import { ActCard } from "../panels/ActCard";
import { chapterGuesses } from "../jobs/apply";
import { jobKey, planKeyframeArt, planStoryboard } from "../jobs/plan";
import {
  jobProgress,
  useRunningJob,
  useStoryJobs,
  useStoryJobStore,
  useStoryRun,
} from "../stores/storyJobStore";
import { useStoryStore } from "../stores/storyStore";
import { useElapsed } from "./useElapsed";

/** How many episodes one batch is asked to board at once. */
const BOARDS_PER_ASK = 8;

/** How long a written ask runs before the reader is told it may be a while. */
const STORY_SLOW_MS = 90_000;

/**
 * The fourth step: every episode's board — its acts, their shots, and the
 * pictures and clips made from them.
 *
 * One episode is boarded at a time, because a board is the thing a reader
 * argues with: acts, framing, what is said, and how long each shot runs. The
 * table is agreed to before anything is drawn from it and the frames are agreed
 * to before anything is filmed, since each is made from the one before it — and
 * nothing is asked for in bulk without saying how many pieces it is.
 */
export function StoryboardStep({ story }: { story: StoryDocument }) {
  const { t } = useTranslation();
  const jobs = useStoryJobs(story.id);
  const running = useRunningJob(story.id);
  const failure = useStoryJobStore((state) => state.error);
  const elapsed = useElapsed(running?.createdAt);
  const run = useStoryRun();
  const openChapterId = useStoryStore((state) => state.openChapterId);
  const [asking, setAsking] = useState(false);
  const [granularityTo, setGranularityTo] =
    useState<StoryShotGranularity | null>(null);
  const [waves, setWaves] = useState<string[][]>([]);
  const [totalWaves, setTotalWaves] = useState(0);
  const starting = useRef(false);

  const index = Math.max(
    0,
    story.chapters.findIndex((held) => held.id === openChapterId),
  );
  const chapter: StoryChapter | undefined = story.chapters[index];
  const keys = busyKeys(jobs);
  const marks =
    chapter === undefined
      ? new Map<string, StoryGuess[]>()
      : chapterGuesses(story, chapter.id, jobs);

  const unboarded = story.chapters.filter((held) => held.acts.length === 0);
  const actsTotal = story.chapters.reduce(
    (sum, held) => sum + held.acts.length,
    0,
  );
  // Frames are only made from a table the reader has agreed to, so the count
  // of what is missing counts only the acts whose tables are settled.
  const missingFrames = story.chapters.flatMap((held) =>
    held.acts
      .filter((act) => act.keysConfirmed)
      .flatMap((act) =>
        act.keyframes
          .filter((keyframe) => keyframe.art.takes.length === 0)
          .map((keyframe) => ({
            chapterId: held.id,
            actId: act.id,
            keyframeId: keyframe.id,
          })),
      ),
  );
  const videos = countVideos(story);

  // A telling longer than one batch is boarded in waves, the next one
  // beginning when the one before it is over rather than when the reader
  // presses again.
  useEffect(() => {
    if (starting.current || running !== null || waves.length === 0) return;
    const next = waves[0];
    if (next === undefined) return;
    starting.current = true;
    void useStoryJobStore
      .getState()
      .start(story.id, "storyboard", planStoryboard(story, next))
      .then((record) => {
        setWaves((held) => (record === null ? [] : held.slice(1)));
      })
      .finally(() => {
        starting.current = false;
      });
  }, [running, waves, story]);

  const writeGranularity = (granularity: StoryShotGranularity) => {
    execute(i18n.t("story:history.storyboard"), [
      {
        type: "updateStoryGranularity",
        storyId: story.id,
        shotGranularity: granularity,
      },
    ]);
  };

  const chooseGranularity = (next: StoryShotGranularity) => {
    if (next === story.shotGranularity) return;
    if (videos > 0) {
      setGranularityTo(next);
      return;
    }
    writeGranularity(next);
  };

  const boardAll = async () => {
    const cut = chunkWaves(
      unboarded.map((held) => held.id),
      BOARDS_PER_ASK,
    );
    setTotalWaves(Math.max(1, cut.length));
    setWaves(cut.slice(1));
    const first = cut[0] ?? [];
    if (first.length === 0) return;
    await run(story.id, "storyboard", planStoryboard(story, first));
  };

  if (chapter === undefined) {
    return (
      <div
        className="story-step-scroll"
        data-testid="story-step-storyboard-body"
      >
        <div
          className="clip-empty clip-empty-first"
          data-testid="story-board-nochapters"
        >
          <h2>{t("story:step.storyboard")}</h2>
          <p>{t("story:storyboard.noChapters")}</p>
          <button
            className="primary"
            data-testid="story-board-to-outline"
            onClick={() => useStoryStore.getState().goStep("outline")}
            type="button"
          >
            {t("story:step.outline")}
          </button>
        </div>
      </div>
    );
  }

  const cost = actsRegenerationCost(chapter);

  return (
    <div className="story-step-scroll" data-testid="story-step-storyboard-body">
      <div className="story-step-wide">
        <h2>{t("story:step.storyboard")}</h2>
        <p className="story-step-lead">{t("story:storyboard.lead")}</p>
        <StoryModelPicks
          places={["text", "image", "video", "audio", "music"]}
        />

        <div className="story-chapter-strip" role="tablist">
          {story.chapters.map((held, at) => {
            const state = boardState(held, story.shotGranularity);
            return (
              <button
                aria-selected={held.id === chapter.id}
                className={`story-choice${held.id === chapter.id ? " is-on" : ""}`}
                data-testid={`story-board-chapter-${at}`}
                key={held.id}
                onClick={() => useStoryStore.getState().openChapter(held.id)}
                role="tab"
                type="button"
              >
                {at + 1}. {held.title}
                <span className="story-hint">
                  {t(state.key, state.values ?? {})}
                </span>
              </button>
            );
          })}
          <span
            aria-label={t("story:storyboard.granularity")}
            className="story-granularity"
            role="radiogroup"
          >
            {STORY_GRANULARITY_OPTIONS.map((option) => (
              <button
                aria-checked={story.shotGranularity === option}
                className={`story-choice${story.shotGranularity === option ? " is-on" : ""}`}
                data-testid={`story-granularity-${option}`}
                key={option}
                onClick={() => chooseGranularity(option)}
                role="radio"
                type="button"
              >
                {t(`story:storyboard.granularity_${option}`)}
              </button>
            ))}
          </span>
        </div>

        <div className="story-board-head">
          <span className="story-board-name">
            {t("story:storyboard.chapterAt", {
              number: index + 1,
              title: chapter.title,
            })}
          </span>
          <span className="story-count" data-testid="story-board-target">
            {t("story:storyboard.target", {
              duration: formatDuration(chapter.targetDurationMs),
            })}
          </span>
          <span className="story-hint" data-testid="story-board-settled">
            {t("story:storyboard.settled", {
              done: story.chapters
                .flatMap((held) => held.acts)
                .filter((act) => actVideoSettled(act, story.shotGranularity))
                .length,
              total: actsTotal,
            })}
          </span>
          <div className="story-step-actions">
            {chapter.acts.some(
              (act) => act.voice !== undefined || act.music !== undefined,
            ) && (
              <span className="story-hint" data-testid="story-board-sound">
                {t("story:storyboard.soundReady")}
              </span>
            )}
            <button
              className="primary"
              data-testid="story-board-generate"
              disabled={running !== null}
              onClick={() =>
                void run(
                  story.id,
                  "storyboard",
                  planStoryboard(story, [chapter.id]),
                )
              }
              type="button"
            >
              {t("story:storyboard.generate")}
            </button>
            {chapter.acts.length > 0 && (
              <button
                data-testid="story-board-regenerate"
                disabled={running !== null}
                onClick={() => setAsking(true)}
                type="button"
              >
                {t("story:storyboard.regenerate")}
              </button>
            )}
            {unboarded.length >= 2 && (
              <button
                data-testid="story-board-all"
                disabled={running !== null}
                onClick={() => void boardAll()}
                type="button"
              >
                {t("story:storyboard.generateAll", { count: unboarded.length })}
              </button>
            )}
          </div>
        </div>

        <div className="story-step-actions">
          {missingFrames.length > 0 && (
            <button
              data-testid="story-board-draw-missing"
              disabled={running !== null}
              onClick={() =>
                void run(
                  story.id,
                  "keyframeArt",
                  planKeyframeArt(story, missingFrames),
                )
              }
              type="button"
            >
              {t("story:storyboard.drawAllMissing", {
                count: missingFrames.length,
              })}
            </button>
          )}
          {totalWaves > 1 && (running !== null || waves.length > 0) && (
            <span className="story-hint" data-testid="story-board-wave">
              {t("story:outline.wave", {
                at: Math.max(1, totalWaves - waves.length),
                of: totalWaves,
              })}
            </span>
          )}
          {running !== null && (
            <span className="story-hint" data-testid="story-board-progress">
              {t("story:jobs.busy", jobProgress(running))}
            </span>
          )}
        </div>

        {failure !== null && (
          <p className="story-hint" data-testid="story-board-error">
            {failure}
          </p>
        )}

        {running !== null && (
          <div
            className="story-running"
            data-testid="story-board-running"
            role="status"
          >
            <span>
              {t("story:storyboard.writing")} · {formatDuration(elapsed)}
            </span>
            {elapsed >= STORY_SLOW_MS && (
              <span className="story-hint">{t("story:outline.slow")}</span>
            )}
            <button
              className="link"
              data-testid="story-board-cancel"
              onClick={() =>
                void useStoryJobStore.getState().cancel(running.id)
              }
              type="button"
            >
              {t("story:outline.cancel")}
            </button>
          </div>
        )}

        {chapter.acts.length === 0 ? (
          <div className="clip-empty" data-testid="story-board-empty">
            <p>{t("story:storyboard.empty")}</p>
            <div className="story-step-actions">
              <button
                className="primary"
                data-testid="story-board-empty-generate"
                disabled={running !== null}
                onClick={() =>
                  void run(
                    story.id,
                    "storyboard",
                    planStoryboard(story, [chapter.id]),
                  )
                }
                type="button"
              >
                {t("story:storyboard.generate")}
              </button>
            </div>
          </div>
        ) : (
          <ol className="story-acts">
            {chapter.acts.map((act, at) => {
              const busy = busyIn(keys, chapter.id, act);
              return (
                <ActCard
                  act={act}
                  busyKeyframes={busy.frames}
                  chapterId={chapter.id}
                  guesses={marks.get(act.id) ?? []}
                  index={at}
                  key={act.id}
                  musicBusy={busy.music}
                  running={running !== null}
                  story={story}
                  videoBusy={busy.video}
                  voiceBusy={busy.voice}
                />
              );
            })}
          </ol>
        )}
      </div>

      {asking && (
        <ConfirmDialog
          body={t("story:storyboard.regenerateBody", {
            acts: cost.acts,
            drawn: cost.drawn,
            filmed: cost.filmed,
          })}
          confirm={t("story:storyboard.regenerateConfirm")}
          note={t("story:storyboard.regenerateNote")}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void run(
              story.id,
              "storyboard",
              planStoryboard(story, [chapter.id]),
            );
          }}
          testId="regenerate-board"
          title={t("story:storyboard.regenerateTitle", { number: index + 1 })}
        />
      )}
      {granularityTo !== null && (
        <ConfirmDialog
          body={t("story:storyboard.granularityBody", {
            count: videos,
            from: t(`story:storyboard.granularity_${story.shotGranularity}`),
            to: t(`story:storyboard.granularity_${granularityTo}`),
          })}
          confirm={t("story:storyboard.granularityConfirm")}
          note={t("story:storyboard.granularityNote")}
          onCancel={() => setGranularityTo(null)}
          onConfirm={() => {
            writeGranularity(granularityTo);
            setGranularityTo(null);
          }}
          testId="change-granularity"
          title={t("story:storyboard.granularityTitle")}
        />
      )}
    </div>
  );
}

/** The two ways a board's clips may be made, in the order the room shows them. */
const STORY_GRANULARITY_OPTIONS: StoryShotGranularity[] = ["act", "keyframe"];

/** What an episode's chip says about how far its board has got. */
function boardState(
  chapter: StoryChapter,
  granularity: StoryShotGranularity,
): { key: string; values?: Record<string, number> } {
  if (chapter.acts.length === 0) return { key: "story:storyboard.chipEmpty" };
  if (chapter.acts.every((act) => actVideoSettled(act, granularity))) {
    return { key: "story:storyboard.chipFilmed" };
  }
  const drawn = chapter.acts.reduce(
    (sum, act) =>
      sum +
      act.keyframes.filter((keyframe) => keyframe.art.takes.length > 0).length,
    0,
  );
  if (drawn > 0) {
    return {
      key: "story:storyboard.chipFrames",
      values: { drawn, total: keyframeCount(chapter) },
    };
  }
  return {
    key: "story:storyboard.chipBoarded",
    values: { acts: chapter.acts.length },
  };
}

/** How many clips a story holds, wherever they were made. */
function countVideos(story: StoryDocument): number {
  return story.chapters
    .flatMap((chapter) => chapter.acts)
    .reduce(
      (sum, act) =>
        sum +
        (act.video.takes.length > 0 ? 1 : 0) +
        act.keyframes.filter((keyframe) => keyframe.video.takes.length > 0)
          .length,
      0,
    );
}

/** The places a batch is working on right now, by the name a place is known by. */
function busyKeys(jobs: StoryJobRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    for (const item of job.items) {
      if (item.status === "queued" || item.status === "running") {
        keys.add(jobKey(item.target));
      }
    }
  }
  return keys;
}

/** Which of an act's shots are being drawn, and whether its clip is. */
function busyIn(
  keys: Set<string>,
  chapterId: string,
  act: StoryAct,
): { frames: Set<string>; video: boolean; voice: boolean; music: boolean } {
  const frames = new Set<string>();
  let video = keys.has(
    targetKey({ kind: "actVideo", chapterId, actId: act.id }),
  );
  const voice = keys.has(
    targetKey({ kind: "actVoice", chapterId, actId: act.id }),
  );
  const music = keys.has(
    targetKey({ kind: "actMusic", chapterId, actId: act.id }),
  );
  for (const keyframe of act.keyframes) {
    if (
      keys.has(
        targetKey({
          kind: "keyframe",
          chapterId,
          actId: act.id,
          keyframeId: keyframe.id,
        }),
      )
    ) {
      frames.add(keyframe.id);
    }
    if (
      keys.has(
        targetKey({
          kind: "keyframeVideo",
          chapterId,
          actId: act.id,
          keyframeId: keyframe.id,
        }),
      )
    ) {
      video = true;
    }
  }
  return { frames, video, voice, music };
}
