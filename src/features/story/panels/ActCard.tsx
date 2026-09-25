import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  actCast,
  actPlannedMs,
  currentTake,
  type StoryGuess,
} from "../../../shared/domain";
import type {
  StoryAct,
  StoryActPatch,
  StoryActSound,
  StoryDocument,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { clampSeconds, planActVideos, planKeyframeArt } from "../jobs/plan";
import { useStoryRun } from "../stores/storyJobStore";
import { KeyframeTable } from "./KeyframeTable";
import { RefPicker } from "./RefPicker";
import { StoryLightbox } from "./StoryLightbox";
import { useField } from "./useField";

/** The longest an act and a shot may be edited to, in seconds. */
const ACT_TITLE_MAX = 40;

/**
 * One act of a board: who is in it, what happens, how it sounds, and the shots
 * it is made of, one row each.
 *
 * The card is where a board is agreed to. Everything under the table — the
 * frames and the clip — is made from what is written above it, so the table is
 * read-only once the reader has confirmed it, and the pictures are not asked for
 * until it has been.
 */
export function ActCard({
  story,
  chapterId,
  act,
  index,
  guesses,
  running,
  busyKeyframes,
  videoBusy,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  /** Which act of the chapter this is, counted from zero as the room counts. */
  index: number;
  /** The cells of this act's board the reading chose rather than read. */
  guesses: StoryGuess[];
  /** Whether a batch is out for the story at all, which is when none starts. */
  running: boolean;
  busyKeyframes: Set<string>;
  /** Whether this act's own clip is being made just now. */
  videoBusy: boolean;
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState<StoryActSound>(act.sound);
  const perShot = story.shotGranularity === "keyframe";
  const locked = act.keysConfirmed;
  const clip = currentTake(act.video);

  const plannedMs = actPlannedMs(act);
  const seconds = clampSeconds(plannedMs);
  // A plan that is not the length it was asked for is worth saying out loud:
  // the reader agreed to a shot that runs 6.4 seconds and is getting five.
  const adjusted = seconds * 1000 !== plannedMs;

  const write = (patch: StoryActPatch) =>
    writeAct(story, chapterId, act, patch);
  const title = useField(act.title, (value) => {
    const name = value.trim();
    if (name !== "" && name !== act.title) write({ title: name });
  });
  const summary = useField(act.summary, (value) => {
    if (value !== act.summary) write({ summary: value });
  });

  // A reference nobody has drawn cannot travel with the prompt, which is worth
  // saying before the frames are asked for rather than after: what comes back
  // is a picture of a stranger.
  const cast = actCast(story, act);
  const references = [...cast.characters, ...cast.scenes, ...cast.props];
  const undrawn = references.filter(
    (element) => currentTake(element.main) === undefined,
  );

  const missing = act.keyframes.filter(
    (keyframe) => keyframe.art.takes.length === 0,
  );
  const drawn = act.keyframes.length - missing.length;
  const everyFrameConfirmed =
    act.keyframes.length > 0 &&
    act.keyframes.every((keyframe) => keyframe.art.confirmed);
  const filmed = act.keyframes.filter(
    (keyframe) => keyframe.video.takes.length > 0,
  ).length;
  const everyShotFilmed =
    act.keyframes.length > 0 && filmed === act.keyframes.length;
  const everyShotConfirmed =
    everyShotFilmed &&
    act.keyframes.every((keyframe) => keyframe.video.confirmed);

  const drawMissing = () => {
    const items = planKeyframeArt(
      story,
      missing.map((keyframe) => ({
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      })),
    );
    void run(story.id, "keyframeArt", items);
  };

  const filmAct = () => {
    const items = planActVideos(story, chapterId, [act.id]);
    void run(story.id, "actVideo", items);
  };

  return (
    <li className="story-act" data-testid={`story-act-${index}`}>
      <div className="story-act-head">
        <span className="story-act-index">
          {t("story:storyboard.actIndex", { index: index + 1 })}
        </span>
        <input
          aria-label={t("story:storyboard.actTitle")}
          className="story-act-title"
          data-testid={`story-act-title-${index}`}
          disabled={locked}
          maxLength={ACT_TITLE_MAX}
          onBlur={title.commit}
          onChange={(event) => title.set(event.target.value)}
          value={title.value}
        />
        <span className="story-count" data-testid={`story-act-plan-${index}`}>
          {t("story:storyboard.plan", {
            seconds: Math.round((plannedMs / 1000) * 10) / 10,
          })}
        </span>
        {adjusted && (
          <span
            className="story-clamp"
            data-testid={`story-act-clamp-${index}`}
            title={t("story:storyboard.clampHint")}
          >
            {t("story:storyboard.clamped", { seconds })}
          </span>
        )}
        <span className="story-act-state">
          {locked ? (
            <>
              <span
                className="story-chip is-on"
                data-testid={`story-act-keys-on-${index}`}
              >
                {t("story:storyboard.keysConfirmed")}
              </span>
              <button
                className="link"
                data-testid={`story-act-unlock-${index}`}
                onClick={() => write({ keysConfirmed: false })}
                type="button"
              >
                {t("story:storyboard.changeTable")}
              </button>
            </>
          ) : (
            <button
              className="story-chip story-act-confirm"
              data-testid={`story-act-keys-${index}`}
              disabled={act.keyframes.length === 0 || running}
              onClick={() => write({ keysConfirmed: true })}
              title={
                act.keyframes.length === 0
                  ? t("story:storyboard.noShots")
                  : undefined
              }
              type="button"
            >
              {t("story:storyboard.confirmTable")}
            </button>
          )}
        </span>
      </div>

      <div className="story-refs-row">
        <RefPicker
          chosen={act.characterIds}
          disabled={locked}
          elements={story.elements}
          kind="character"
          label={t("story:storyboard.characters")}
          many
          onPick={(characterIds) => write({ characterIds })}
        />
        <RefPicker
          chosen={act.sceneId === undefined ? [] : [act.sceneId]}
          disabled={locked}
          elements={story.elements}
          kind="scene"
          label={t("story:storyboard.scene")}
          many={false}
          onPick={(ids) => write({ sceneId: ids[0] ?? null })}
        />
        <RefPicker
          chosen={act.propIds}
          disabled={locked}
          elements={story.elements}
          kind="prop"
          label={t("story:storyboard.props")}
          many
          onPick={(propIds) => write({ propIds })}
        />
      </div>

      <label className="story-field-label" htmlFor={`act-summary-${index}`}>
        {t("story:storyboard.summary")}
      </label>
      <textarea
        aria-label={t("story:storyboard.summary")}
        className="story-act-summary"
        data-testid={`story-act-summary-${index}`}
        id={`act-summary-${index}`}
        maxLength={2000}
        onBlur={summary.commit}
        onChange={(event) => summary.set(event.target.value)}
        rows={3}
        value={summary.value}
      />

      <div className="story-act-sound">
        {SOUND_FIELDS.map((field) => (
          <label key={field.key}>
            <span className="story-field-label">
              {t(`story:storyboard.sound_${field.key}`)}
            </span>
            <input
              aria-label={t(`story:storyboard.sound_${field.key}`)}
              data-testid={`story-act-sound-${field.key}-${index}`}
              maxLength={200}
              onBlur={() => {
                if (sound[field.key] !== act.sound[field.key]) {
                  write({ sound });
                }
              }}
              onChange={(event) =>
                setSound({ ...sound, [field.key]: event.target.value })
              }
              value={sound[field.key]}
            />
          </label>
        ))}
      </div>

      <KeyframeTable
        act={act}
        busyKeyframes={busyKeyframes}
        chapterId={chapterId}
        guesses={guesses}
        running={running}
        story={story}
        videoBusy={videoBusy}
      />

      <div className="story-act-foot">
        <span className="story-hint" data-testid={`story-act-state-${index}`}>
          {t("story:storyboard.frames", {
            drawn,
            total: act.keyframes.length,
          })}
          {" · "}
          {perShot
            ? everyShotConfirmed
              ? t("story:storyboard.clipConfirmed")
              : t("story:storyboard.shotsFilmed", {
                  filmed,
                  total: act.keyframes.length,
                })
            : clip === undefined
              ? t("story:storyboard.noClip")
              : act.videoConfirmed
                ? t("story:storyboard.clipConfirmed")
                : t("story:storyboard.clipWaiting")}
        </span>

        {undrawn.length > 0 && (
          <span
            className="story-hint"
            data-testid={`story-act-missing-ref-${index}`}
            title={t("story:storyboard.undrawnHint")}
          >
            {undrawn.length < references.length
              ? t("story:storyboard.missingRef", {
                  names: undrawn.map((element) => element.name).join("、"),
                })
              : t("story:storyboard.noRefs")}
          </span>
        )}

        {missing.length > 0 && (
          <button
            className="primary"
            data-testid={`story-act-draw-${index}`}
            disabled={!locked || running || videoBusy}
            onClick={drawMissing}
            title={locked ? undefined : t("story:storyboard.confirmTableFirst")}
            type="button"
          >
            {t("story:storyboard.drawMissing", { count: missing.length })}
          </button>
        )}

        {act.imagesConfirmed ? (
          <>
            <span className="story-chip is-on">
              {t("story:storyboard.imagesConfirmed")}
            </span>
            <button
              className="link"
              data-testid={`story-act-images-unconfirm-${index}`}
              onClick={() => write({ imagesConfirmed: false })}
              type="button"
            >
              {t("story:storyboard.changeImages")}
            </button>
          </>
        ) : (
          <button
            data-testid={`story-act-images-confirm-${index}`}
            disabled={!everyFrameConfirmed || running || videoBusy}
            onClick={() => write({ imagesConfirmed: true })}
            title={
              everyFrameConfirmed
                ? undefined
                : t("story:storyboard.confirmEveryFrame")
            }
            type="button"
          >
            {t("story:storyboard.confirmImages")}
          </button>
        )}

        {!perShot && clip === undefined && (
          <button
            data-testid={`story-act-video-go-${index}`}
            disabled={!act.imagesConfirmed || running || videoBusy}
            onClick={filmAct}
            title={
              act.imagesConfirmed
                ? undefined
                : t("story:storyboard.confirmImagesFirst")
            }
            type="button"
          >
            {videoBusy
              ? t("story:panels.drawing")
              : t("story:storyboard.filmAct")}
          </button>
        )}

        {clip !== undefined && (
          <span className="story-act-clip">
            <button
              aria-label={t("story:storyboard.playClip")}
              className="story-act-play"
              data-testid={`story-act-video-${index}`}
              onClick={() => setPlaying(true)}
              type="button"
            >
              <video
                muted
                preload="metadata"
                src={`/api/v1/projects/current/assets/${clip.assetId}`}
              />
            </button>
            {!perShot && (
              <button
                aria-pressed={act.videoConfirmed}
                className="link"
                data-testid={`story-act-video-confirm-${index}`}
                onClick={() => write({ videoConfirmed: !act.videoConfirmed })}
                type="button"
              >
                {act.videoConfirmed
                  ? t("story:panels.confirmed")
                  : t("story:panels.confirm")}
              </button>
            )}
          </span>
        )}
      </div>

      {playing && clip !== undefined && (
        <StoryLightbox
          assetId={clip.assetId}
          label={t("story:storyboard.playClip")}
          onClose={() => setPlaying(false)}
          video
        />
      )}
    </li>
  );
}

/** The three parts of an act's sound, in the order they are written. */
const SOUND_FIELDS: Array<{ key: keyof StoryActSound }> = [
  { key: "music" },
  { key: "sfx" },
  { key: "ambience" },
];

/** One act's field, as the reader leaves it. */
function writeAct(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  patch: StoryActPatch,
): void {
  execute(i18n.t("story:history.storyboard"), [
    {
      type: "updateStoryAct",
      storyId: story.id,
      chapterId,
      actId: act.id,
      patch,
    },
  ]);
}
