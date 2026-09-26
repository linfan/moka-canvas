import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  actCast,
  actPlannedMs,
  currentTake,
  findResource,
  formatDuration,
  type StoryGuess,
} from "../../../shared/domain";
import { MAX_VIDEO_SECONDS } from "../../../shared/domain/constants";
import type {
  MokaFile,
  StoryAct,
  StoryActPatch,
  StoryActSound,
  StoryDocument,
} from "../../../shared/domain/types";
import { assetUrl } from "../../../api/assets";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  clampSeconds,
  planActMusic,
  planActVideos,
  planActVoice,
  planKeyframeArt,
} from "../jobs/plan";
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
 * until it has been. Agreeing to it, and the pictures it leads to, are one row
 * of actions under the table, in the order they are wanted.
 *
 * Every picture is an ask of its own: what this card's own painter is working
 * on is asked for once and says so, while the rest of the card — and the acts
 * beside it — go on being askable.
 */
export function ActCard({
  story,
  chapterId,
  act,
  index,
  guesses,
  boardBusy,
  busyKeyframes,
  busyClips,
  videoBusy,
  voiceBusy,
  musicBusy,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  /** Which act of the chapter this is, counted from zero as the room counts. */
  index: number;
  /** The cells of this act's board the reading chose rather than read. */
  guesses: StoryGuess[];
  /** Whether this act's own table is being written just now. */
  boardBusy: boolean;
  /** The shots of this act being drawn just now, by the shot's own name. */
  busyKeyframes: Set<string>;
  /** The shots of this act being filmed just now. */
  busyClips: Set<string>;
  /** Whether this act's own clip is being made just now. */
  videoBusy: boolean;
  /** Whether this act's lines, or its score, are being made just now. */
  voiceBusy: boolean;
  musicBusy: boolean;
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  const moka = useProjectStore((state) => state.moka);
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState<StoryActSound>(act.sound);
  const perShot = story.shotGranularity === "keyframe";
  const locked = act.keysConfirmed;
  const clip = currentTake(act.video);
  const voice = act.voice === undefined ? undefined : currentTake(act.voice);
  const music = act.music === undefined ? undefined : currentTake(act.music);

  const plannedMs = actPlannedMs(act);
  const seconds = clampSeconds(plannedMs);
  // A clip is asked for in whole seconds and no longer than one may run, so a
  // plan that is not the length it will be made at is worth saying out loud:
  // the reader agreed to a shot that runs 6.4 seconds and is getting six.
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
  // What this card's own draw button hands over: the shots still missing a
  // picture that are not already being drawn, since asking for a shot twice
  // pays for it twice. It is also what the button counts, so its number is the
  // work it would ask for — while a shot waits on its painter, the rest of the
  // missing ones go on being askable.
  const drawable = missing.filter(
    (keyframe) => !busyKeyframes.has(keyframe.id),
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
      drawable.map((keyframe) => ({
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

  const spoken = act.keyframes
    .flatMap((keyframe) => keyframe.dialogue)
    .filter((line) => line.text.trim() !== "").length;
  const hasSound =
    act.sound.music.trim() !== "" ||
    act.sound.sfx.trim() !== "" ||
    (act.sound.ambience ?? "").trim() !== "";

  const speakAct = () => {
    const items = planActVoice(story, chapterId, act.id);
    void run(story.id, "voice", items);
  };

  const scoreAct = () => {
    const items = planActMusic(story, chapterId, act.id);
    void run(story.id, "music", items);
  };

  /** Marks the take the reader is listening to as the one they settled on. */
  const confirmSound = (kind: "actVoice" | "actMusic", confirmed: boolean) => {
    const held = kind === "actVoice" ? act.voice : act.music;
    if (held === undefined) return;
    execute(i18n.t("story:history.sound"), [
      {
        type: "setStorySlot",
        storyId: story.id,
        target: { kind, chapterId, actId: act.id },
        slot: { ...held, confirmed },
      },
    ]);
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
            title={t("story:storyboard.clampHint", { max: MAX_VIDEO_SECONDS })}
          >
            {t("story:storyboard.clamped", { seconds })}
          </span>
        )}
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
        busyClips={busyClips}
        busyKeyframes={busyKeyframes}
        chapterId={chapterId}
        guesses={guesses}
        story={story}
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

        {/*
          Agreeing to the table, and the way back to it: the one thing every
          picture and every clip on this card is made from, so it is stated
          where the work that follows it is asked for.
        */}
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
              {t("story:storyboard.unconfirmTable")}
            </button>
          </>
        ) : (
          <button
            className="story-act-confirm"
            data-testid={`story-act-keys-${index}`}
            disabled={act.keyframes.length === 0 || boardBusy}
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

        {drawable.length > 0 && (
          <button
            className="primary"
            data-testid={`story-act-draw-${index}`}
            disabled={!locked}
            onClick={drawMissing}
            title={locked ? undefined : t("story:storyboard.confirmTableFirst")}
            type="button"
          >
            {t("story:storyboard.drawMissing", { count: drawable.length })}
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
              {t("story:storyboard.unconfirmImages")}
            </button>
          </>
        ) : (
          <button
            data-testid={`story-act-images-confirm-${index}`}
            disabled={!everyFrameConfirmed}
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
            disabled={!act.imagesConfirmed || videoBusy}
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

      {/*
        The sound of the act, under the pictures it belongs to: the lines read
        aloud in one voice, and the music they are spoken over. Both slots are
        optional, so the row says what a reader has not asked for yet and makes
        it one press away.
      */}
      <div className="story-sound-row" data-testid={`story-act-sound-${index}`}>
        <span className="story-field-label">{t("story:voice.rowLabel")}</span>
        <span className="story-sound-slot">
          {voice === undefined ? (
            <button
              data-testid={`story-act-voice-go-${index}`}
              disabled={spoken === 0 || voiceBusy}
              onClick={speakAct}
              title={spoken === 0 ? t("story:voice.noLines") : undefined}
              type="button"
            >
              {voiceBusy
                ? t("story:panels.drawing")
                : t("story:voice.speak", { count: spoken })}
            </button>
          ) : (
            <>
              <audio
                controls
                data-testid={`story-act-voice-${index}`}
                preload="metadata"
                src={assetUrl(voice.assetId)}
              />
              <span className="story-hint">
                {t("story:voice.take", {
                  seconds: secondsOf(moka, voice.assetId),
                })}
              </span>
              <button
                className="link"
                data-testid={`story-act-voice-again-${index}`}
                disabled={voiceBusy}
                onClick={speakAct}
                type="button"
              >
                {t("story:voice.again")}
              </button>
              <button
                aria-pressed={act.voice?.confirmed ?? false}
                className="link"
                data-testid={`story-act-voice-confirm-${index}`}
                onClick={() =>
                  confirmSound("actVoice", !(act.voice?.confirmed ?? false))
                }
                type="button"
              >
                {act.voice?.confirmed
                  ? t("story:panels.confirmed")
                  : t("story:panels.confirm")}
              </button>
            </>
          )}
        </span>
        <span className="story-sound-slot">
          {music === undefined ? (
            <button
              data-testid={`story-act-music-go-${index}`}
              disabled={!hasSound || musicBusy}
              onClick={scoreAct}
              title={hasSound ? undefined : t("story:voice.noSound")}
              type="button"
            >
              {musicBusy ? t("story:panels.drawing") : t("story:voice.score")}
            </button>
          ) : (
            <>
              <audio
                controls
                data-testid={`story-act-music-${index}`}
                preload="metadata"
                src={assetUrl(music.assetId)}
              />
              <span className="story-hint">
                {t("story:voice.take", {
                  seconds: secondsOf(moka, music.assetId),
                })}
              </span>
              <button
                className="link"
                data-testid={`story-act-music-again-${index}`}
                disabled={musicBusy}
                onClick={scoreAct}
                type="button"
              >
                {t("story:voice.again")}
              </button>
              <button
                aria-pressed={act.music?.confirmed ?? false}
                className="link"
                data-testid={`story-act-music-confirm-${index}`}
                onClick={() =>
                  confirmSound("actMusic", !(act.music?.confirmed ?? false))
                }
                type="button"
              >
                {act.music?.confirmed
                  ? t("story:panels.confirmed")
                  : t("story:panels.confirm")}
              </button>
            </>
          )}
        </span>
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

/** How long a sound file runs, as the shelf reads it back. */
function secondsOf(moka: MokaFile | null, assetId: string): string {
  const entry = moka === null ? undefined : findResource(moka, assetId);
  const durationMs = entry?.probe?.durationMs;
  return durationMs === undefined ? "—" : formatDuration(durationMs);
}

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
