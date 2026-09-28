import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CAMERA_ANGLE_LABELS,
  CAMERA_MOVE_LABELS,
  SHOT_SIZE_LABELS,
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_SHOT_SIZES,
  createKeyframe,
  currentTake,
  keyframeAt,
  slotWithoutTake,
  slotWithCurrent,
  storyMentions,
  type StoryGuess,
} from "../../../shared/domain";
import type {
  DocumentCommand,
  StoryAct,
  StoryDialogueLine,
  StoryDocument,
  StoryKeyframe,
  StoryKeyframePatch,
  StorySlot,
} from "../../../shared/domain/types";
import { assetUrl } from "../../../api/assets";
import { i18n } from "../../../shared/i18n";
import { storyKeyframePromptParts } from "../../../shared/prompts";
import { execute } from "../../editor/commands/execute";
import {
  keyframeCast,
  planKeyframeArt,
  planKeyframeVideos,
} from "../jobs/plan";
import { useStoryRun } from "../stores/storyJobStore";
import { KeyframeContentField, type MentionKind } from "./KeyframeContentField";
import { frameRatio } from "./ratios";
import { liveStory, removeOldTake, type TakeDrop } from "./removeOldTake";
import { StoryLightbox } from "./StoryLightbox";
import { StorySlotView } from "./StorySlotView";
import { useField } from "./useField";

/** The longest and shortest a shot may be, in seconds. */
const SHOT_MIN_S = 0.4;
const SHOT_MAX_S = 60;

/**
 * One act's shots, as the table a board is: framing, movement, what is shown,
 * what is said, how long it runs, and the frame drawn for it.
 *
 * A confirmed board is the reader's, so the whole table goes read-only until it
 * is unlocked again — the frames and the clips are made from what is written
 * here, and a framing quietly edited afterwards would be a board nobody agreed
 * to.
 *
 * The table is only how a board is read and edited: what a cell writes goes
 * through the command pipeline like everything else, so a shot that was
 * mis-typed is undone rather than argued with.
 */
export function KeyframeTable({
  story,
  chapterId,
  act,
  guesses,
  busyKeyframes,
  busyClips,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  /** The cells whose framing the reading chose rather than read. */
  guesses: StoryGuess[];
  /** The shots being drawn just now, by the place's own name. */
  busyKeyframes: Set<string>;
  /** The shots being filmed just now, by the place's own name. */
  busyClips: Set<string>;
}) {
  const { t } = useTranslation();
  const [dialogueAt, setDialogueAt] = useState<string | null>(null);
  const locked = act.keysConfirmed;
  const perShot = story.shotGranularity === "keyframe";

  const addShot = () => {
    writeActs(story, chapterId, act.id, [
      ...act.keyframes,
      createKeyframe(act.keyframes.length),
    ]);
  };

  return (
    <div className="story-table-wrap">
      <table className="story-table" data-testid="story-table">
        <thead>
          <tr>
            <th className="story-col-index">#</th>
            <th>{t("story:storyboard.shotSize")}</th>
            <th>{t("story:storyboard.cameraMove")}</th>
            <th>{t("story:storyboard.angle")}</th>
            <th>{t("story:storyboard.content")}</th>
            <th>{t("story:storyboard.dialogue")}</th>
            <th>{t("story:storyboard.duration")}</th>
            <th>{t("story:storyboard.frame")}</th>
            {perShot && <th>{t("story:storyboard.clip")}</th>}
            <th>{t("story:storyboard.rowActions")}</th>
          </tr>
        </thead>
        <tbody>
          {act.keyframes.map((keyframe, index) => (
            <KeyframeRow
              act={act}
              busy={busyKeyframes.has(keyframe.id)}
              clipBusy={busyClips.has(keyframe.id)}
              chapterId={chapterId}
              dialogueOpen={dialogueAt === keyframe.id}
              guesses={guesses.filter((guess) => guess.keyframe === index + 1)}
              index={index}
              key={keyframe.id}
              keyframe={keyframe}
              locked={locked}
              onDialogue={() =>
                setDialogueAt(dialogueAt === keyframe.id ? null : keyframe.id)
              }
              perShot={perShot}
              story={story}
            />
          ))}
        </tbody>
        {!locked && (
          <tfoot>
            <tr>
              <td colSpan={perShot ? 10 : 9}>
                <button
                  className="link"
                  data-testid="story-kf-add"
                  onClick={addShot}
                  type="button"
                >
                  {t("story:storyboard.addShot")}
                </button>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** One shot of the table, and the row the lines of its dialogue are edited in. */
function KeyframeRow({
  story,
  chapterId,
  act,
  keyframe,
  index,
  guesses,
  locked,
  perShot,
  busy,
  clipBusy,
  dialogueOpen,
  onDialogue,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  keyframe: StoryKeyframe;
  index: number;
  guesses: StoryGuess[];
  locked: boolean;
  perShot: boolean;
  busy: boolean;
  /** Whether this shot's own clip is being made just now. */
  clipBusy: boolean;
  dialogueOpen: boolean;
  onDialogue: () => void;
}) {
  const { t } = useTranslation();
  const run = useStoryRun();
  const at = index + 1;
  const cell = (name: string) => t("story:storyboard.cell", { at, name });
  const clip = currentTake(keyframe.video);
  const given = (field: StoryGuess["field"]) =>
    guesses.find((guess) => guess.field === field);

  const write = (patch: StoryKeyframePatch) =>
    writeKeyframe(story, chapterId, act, keyframe.id, patch);

  const draw = () => {
    const [item] = planKeyframeArt(story, [
      { chapterId, actId: act.id, keyframeId: keyframe.id },
    ]);
    if (item !== undefined) void run(story.id, "keyframeArt", [item]);
  };

  const film = () => {
    const [item] = planKeyframeVideos(story, chapterId, act.id, [keyframe.id]);
    if (item !== undefined) void run(story.id, "keyframeVideo", [item]);
  };

  const remove = () =>
    writeActs(
      story,
      chapterId,
      act.id,
      act.keyframes.filter((each) => each.id !== keyframe.id),
    );

  return (
    <>
      <tr data-testid={`story-kf-${index}`}>
        <td className="story-col-index">{at}</td>
        <Cell guessed={given("shotSize")} index={index} testId="size">
          <select
            aria-label={cell(t("story:storyboard.shotSize"))}
            data-testid={`story-kf-size-${index}`}
            disabled={locked}
            onChange={(event) =>
              write({
                shotSize: event.target.value as StoryKeyframe["shotSize"],
              })
            }
            value={keyframe.shotSize}
          >
            {STORY_SHOT_SIZES.map((each) => (
              <option key={each} value={each}>
                {t(SHOT_SIZE_LABELS[each])}
              </option>
            ))}
          </select>
        </Cell>
        <Cell guessed={given("cameraMove")} index={index} testId="move">
          <select
            aria-label={cell(t("story:storyboard.cameraMove"))}
            data-testid={`story-kf-move-${index}`}
            disabled={locked}
            onChange={(event) =>
              write({
                cameraMove: event.target.value as StoryKeyframe["cameraMove"],
              })
            }
            value={keyframe.cameraMove}
          >
            {STORY_CAMERA_MOVES.map((each) => (
              <option key={each} value={each}>
                {t(CAMERA_MOVE_LABELS[each])}
              </option>
            ))}
          </select>
        </Cell>
        <Cell guessed={given("angle")} index={index} testId="angle">
          <select
            aria-label={cell(t("story:storyboard.angle"))}
            data-testid={`story-kf-angle-${index}`}
            disabled={locked}
            onChange={(event) =>
              write({ angle: event.target.value as StoryKeyframe["angle"] })
            }
            value={keyframe.angle}
          >
            {STORY_CAMERA_ANGLES.map((each) => (
              <option key={each} value={each}>
                {t(CAMERA_ANGLE_LABELS[each])}
              </option>
            ))}
          </select>
        </Cell>
        <td className="story-col-content">
          <KeyframePromptCell
            act={act}
            chapterId={chapterId}
            index={index}
            keyframe={keyframe}
            locked={locked}
            story={story}
            write={write}
          />
        </td>
        <td>
          <button
            aria-expanded={dialogueOpen}
            aria-label={cell(t("story:storyboard.dialogue"))}
            className="story-dialogue-toggle"
            data-testid={`story-kf-dialogue-${index}`}
            disabled={locked}
            onClick={onDialogue}
            type="button"
          >
            {keyframe.dialogue.length === 0
              ? t("story:storyboard.noLines")
              : t("story:storyboard.lines", {
                  count: keyframe.dialogue.length,
                })}
          </button>
        </td>
        <td>
          <input
            aria-label={cell(t("story:storyboard.duration"))}
            className="story-kf-seconds"
            data-testid={`story-kf-seconds-${index}`}
            disabled={locked}
            max={SHOT_MAX_S}
            min={SHOT_MIN_S}
            onChange={(event) => {
              const seconds = Number(event.target.value);
              if (!Number.isFinite(seconds)) return;
              const ms = Math.round(
                Math.min(SHOT_MAX_S, Math.max(SHOT_MIN_S, seconds)) * 1000,
              );
              write({ durationMs: ms });
            }}
            step={0.1}
            type="number"
            value={Math.round((keyframe.durationMs / 1000) * 10) / 10}
          />
        </td>
        <td className="story-col-frame">
          <StorySlotView
            busy={busy}
            canGenerate={act.keysConfirmed}
            disabledReason={
              act.keysConfirmed
                ? undefined
                : t("story:storyboard.confirmTableFirst")
            }
            label={t("story:storyboard.frame")}
            onChoose={(assetId) =>
              keepFrame(story, chapterId, act, keyframe, assetId)
            }
            onConfirm={() => agreeToFrame(story, chapterId, act, keyframe)}
            onGenerate={draw}
            onRemove={(assetId) =>
              removeOldTake(assetId, () =>
                dropFrame(story, chapterId, act, keyframe, assetId),
              )
            }
            ratio={frameRatio(story)}
            slot={keyframe.art}
            testId={`story-kf-slot-${index}`}
          />
        </td>
        {perShot && (
          <td>
            {clip === undefined ? (
              <button
                className="link"
                data-testid={`story-kf-video-${index}`}
                disabled={!act.imagesConfirmed || clipBusy}
                onClick={film}
                title={
                  act.imagesConfirmed
                    ? undefined
                    : t("story:storyboard.confirmImagesFirst")
                }
                type="button"
              >
                {clipBusy
                  ? t("story:panels.drawing")
                  : t("story:storyboard.film")}
              </button>
            ) : (
              <span className="story-kf-clip">
                <video
                  muted
                  preload="metadata"
                  src={`/api/v1/projects/current/assets/${clip.assetIds[0]}`}
                />
                {/*
                  The shot is filmed once, but not only once: a take the reader
                  does not like is asked over from the row that holds it.
                */}
                <button
                  className="link"
                  data-testid={`story-kf-video-again-${index}`}
                  disabled={!act.imagesConfirmed || clipBusy}
                  onClick={film}
                  title={
                    act.imagesConfirmed
                      ? undefined
                      : t("story:storyboard.confirmImagesFirst")
                  }
                  type="button"
                >
                  {clipBusy
                    ? t("story:panels.drawing")
                    : t("story:voice.again")}
                </button>
                <button
                  aria-pressed={keyframe.video.confirmed}
                  className="link"
                  data-testid={`story-kf-video-confirm-${index}`}
                  onClick={() =>
                    writeClip(story, chapterId, act, keyframe, {
                      ...keyframe.video,
                      confirmed: !keyframe.video.confirmed,
                    })
                  }
                  type="button"
                >
                  {keyframe.video.confirmed
                    ? t("story:panels.confirmed")
                    : t("story:panels.confirm")}
                </button>
              </span>
            )}
          </td>
        )}
        <td>
          <button
            aria-label={cell(t("story:storyboard.removeShot"))}
            className="story-kf-remove"
            data-testid={`story-kf-remove-${index}`}
            disabled={locked}
            onClick={remove}
            type="button"
          >
            ✕
          </button>
        </td>
      </tr>
      {dialogueOpen && (
        <tr className="story-dialogue-row">
          <td colSpan={perShot ? 10 : 9}>
            <DialogueEditor
              lines={keyframe.dialogue}
              locked={locked}
              onDone={(dialogue) => {
                onDialogue();
                write({ dialogue });
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The 画面内容 cell: the ask exactly as it will be made, with the shot's own
 * words edited in place and the pictures they name beneath them.
 *
 * The template's sentences stand around the words as the muted scaffolding
 * they are, and the words between them are the only part a reader owns. Every
 * `name` mention in them is a picture the ask travels with, in the order the
 * names first appear, so what is read here is what the model is sent — and the
 * thumbnails under it are the pictures that ride along: the ones the story's
 * limit left behind stand dimmed among them.
 */
function KeyframePromptCell({
  story,
  chapterId,
  act,
  keyframe,
  locked,
  index,
  write,
}: {
  story: StoryDocument;
  chapterId: string;
  act: StoryAct;
  keyframe: StoryKeyframe;
  locked: boolean;
  index: number;
  write: (patch: StoryKeyframePatch) => void;
}) {
  const { t } = useTranslation();
  const [zoomed, setZoomed] = useState<{
    assetIds: string[];
    label: string;
  } | null>(null);
  const content = useField(keyframe.content, (value) => {
    if (value !== keyframe.content) write({ content: value });
  });
  const chapterTitle =
    story.chapters.find((held) => held.id === chapterId)?.title ?? "";
  const cast = keyframeCast(story, content.value);
  // The same words the plan will send, read apart: the fixed scaffolding is
  // the muted part, and the hole it was written around is the field below.
  const parts = storyKeyframePromptParts({
    aspect: story.brief.aspect,
    style: story.brief.style,
    chapter: { title: chapterTitle },
    act: { summary: act.summary },
    keyframe: {
      content: content.value,
      shotSize: keyframe.shotSize,
      cameraMove: keyframe.cameraMove,
      angle: keyframe.angle,
    },
    cast: cast.carried.map(({ element }) => ({
      name: element.name,
      description: element.description,
    })),
  });

  return (
    <>
      <div className="story-prompt" data-testid={`story-kf-prompt-${index}`}>
        <span className="story-prompt-scaffold">{parts.before}</span>
        <KeyframeContentField
          kinds={mentionKinds(story, cast, content.value)}
          label={t("story:storyboard.content")}
          locked={locked}
          onChange={content.set}
          onCommit={content.commit}
          testId={`story-kf-content-${index}`}
          value={content.value}
        />
        <span className="story-prompt-scaffold">{parts.after}</span>
      </div>
      {(cast.carried.length > 0 || cast.beyond.length > 0) && (
        <div className="story-ref-strip" data-testid={`story-kf-refs-${index}`}>
          {cast.carried.map(({ element, assetId }, at) => (
            <button
              aria-label={t("story:storyboard.enlargeRef", {
                name: element.name,
              })}
              className="story-ref-thumb"
              data-testid={`story-kf-ref-${index}-${at}`}
              key={element.id}
              onClick={() =>
                setZoomed({ assetIds: [assetId], label: element.name })
              }
              title={t("story:storyboard.mentionCarried", {
                name: element.name,
              })}
              type="button"
            >
              <img alt={element.name} src={assetUrl(assetId)} />
            </button>
          ))}
          {cast.beyond.map(({ element, assetId }, at) => (
            <button
              aria-label={t("story:storyboard.notCarried", {
                name: element.name,
              })}
              className="story-ref-thumb is-beyond"
              data-testid={`story-kf-ref-beyond-${index}-${at}`}
              key={element.id}
              onClick={() =>
                setZoomed({ assetIds: [assetId], label: element.name })
              }
              title={t("story:storyboard.notCarried", { name: element.name })}
              type="button"
            >
              <img alt={element.name} src={assetUrl(assetId)} />
            </button>
          ))}
        </div>
      )}
      {zoomed !== null && (
        <StoryLightbox
          assetIds={zoomed.assetIds}
          label={zoomed.label}
          onClose={() => setZoomed(null)}
        />
      )}
    </>
  );
}

/** How each name the words mention stands in this frame's ask. */
function mentionKinds(
  story: StoryDocument,
  cast: ReturnType<typeof keyframeCast>,
  content: string,
): Record<string, MentionKind> {
  const carried = new Set(cast.carried.map(({ element }) => element.name));
  const beyond = new Set(cast.beyond.map(({ element }) => element.name));
  const known = new Set(story.elements.map((element) => element.name));
  const kinds: Record<string, MentionKind> = {};
  for (const { name } of storyMentions(content)) {
    if (kinds[name] !== undefined) continue;
    if (carried.has(name)) kinds[name] = "carried";
    else if (beyond.has(name)) kinds[name] = "beyond";
    else if (known.has(name)) kinds[name] = "undrawn";
    else kinds[name] = "unknown";
  }
  return kinds;
}

/**
 * One cell of the table, with the mark that says the parser chose its value.
 *
 * A shot framed as something nobody offered is a shot whose framing is the
 * parser's word rather than the telling's, and the reader can only see that if
 * the cell says so — the answer's own words are in the mark's title.
 */
function Cell({
  children,
  guessed,
  index,
  testId,
}: {
  children: React.ReactNode;
  guessed: StoryGuess | undefined;
  index: number;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <td>
      {children}
      {guessed !== undefined && (
        <span
          aria-label={t("story:storyboard.guessed", { from: guessed.from })}
          className="story-guessed"
          data-testid={`story-guessed-${testId}-${index}`}
          title={t("story:storyboard.guessed", { from: guessed.from })}
        >
          ●
        </span>
      )}
    </td>
  );
}

/**
 * The lines a shot is said in, as a list the reader edits.
 *
 * The lines are held here while the editor is open and written when it is
 * closed, so editing four lines of a shot is one step of the history rather
 * than one per keystroke.
 */
function DialogueEditor({
  lines,
  locked,
  onDone,
}: {
  lines: StoryDialogueLine[];
  locked: boolean;
  onDone: (lines: StoryDialogueLine[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(lines);

  return (
    <div className="story-dialogue" data-testid="story-dialogue">
      {draft.length === 0 && (
        <p className="story-hint">{t("story:storyboard.noDialogue")}</p>
      )}
      {draft.map((line, index) => (
        <div className="story-dialogue-line" key={index}>
          <input
            aria-label={t("story:storyboard.speaker")}
            data-testid={`story-line-speaker-${index}`}
            disabled={locked}
            maxLength={40}
            onChange={(event) =>
              setDraft(
                draft.map((held, at) =>
                  at === index
                    ? { ...held, speaker: event.target.value }
                    : held,
                ),
              )
            }
            placeholder={t("story:storyboard.offScreen")}
            value={line.speaker}
          />
          <input
            aria-label={t("story:storyboard.line")}
            data-testid={`story-line-text-${index}`}
            disabled={locked}
            maxLength={500}
            onChange={(event) =>
              setDraft(
                draft.map((held, at) =>
                  at === index ? { ...held, text: event.target.value } : held,
                ),
              )
            }
            value={line.text}
          />
          <input
            aria-label={t("story:storyboard.tone")}
            data-testid={`story-line-tone-${index}`}
            disabled={locked}
            maxLength={60}
            onChange={(event) =>
              setDraft(
                draft.map((held, at) =>
                  at === index ? { ...held, tone: event.target.value } : held,
                ),
              )
            }
            value={line.tone ?? ""}
          />
          <button
            aria-label={t("story:storyboard.removeLine")}
            className="link"
            data-testid={`story-line-remove-${index}`}
            disabled={locked}
            onClick={() => setDraft(draft.filter((_held, at) => at !== index))}
            type="button"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="story-step-actions">
        <button
          className="link"
          data-testid="story-line-add"
          disabled={locked}
          onClick={() => setDraft([...draft, { speaker: "", text: "" }])}
          type="button"
        >
          {t("story:storyboard.addLine")}
        </button>
        <button
          className="primary"
          data-testid="story-line-done"
          onClick={() => onDone(draft)}
          type="button"
        >
          {t("story:storyboard.linesDone")}
        </button>
      </div>
    </div>
  );
}

/** A shot's words, written as one step of the history. */
function writeKeyframe(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframeId: string,
  patch: StoryKeyframePatch,
): void {
  execute(i18n.t("story:history.storyboard"), [
    {
      type: "updateStoryKeyframe",
      storyId: story.id,
      chapterId,
      actId: act.id,
      keyframeId,
      patch,
    },
  ]);
}

/** An act's shots, whole — how a shot is added to a board or taken off it. */
function writeActs(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  keyframes: StoryKeyframe[],
): void {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  execute(i18n.t("story:history.storyboard"), [
    {
      type: "setStoryActs",
      storyId: story.id,
      chapterId,
      acts: (chapter?.acts ?? []).map((held) =>
        held.id === actId ? { ...held, keyframes } : held,
      ),
    },
  ]);
}

/**
 * One frame agreed to, or the agreement taken back.
 *
 * An act's frames are agreed to as a set, and the act itself goes with them:
 * the frame that completes the set agrees to the act, and a frame taken back
 * takes the act's agreement away. Confirming the frames one by one therefore
 * reaches the same place as the act's own button reaches in one press.
 */
function agreeToFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
): void {
  const confirmed = !keyframe.art.confirmed;
  const commands: DocumentCommand[] = [
    {
      type: "setStorySlot",
      storyId: story.id,
      target: {
        kind: "keyframe",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      },
      slot: { ...keyframe.art, confirmed },
    },
  ];
  const everyOtherFrameConfirmed = act.keyframes.every(
    (held) => held.id === keyframe.id || held.art.confirmed,
  );
  if (confirmed && everyOtherFrameConfirmed && !act.imagesConfirmed) {
    commands.push({
      type: "updateStoryAct",
      storyId: story.id,
      chapterId,
      actId: act.id,
      patch: { imagesConfirmed: true },
    });
  }
  if (!confirmed && act.imagesConfirmed) {
    commands.push({
      type: "updateStoryAct",
      storyId: story.id,
      chapterId,
      actId: act.id,
      patch: { imagesConfirmed: false },
    });
  }
  execute(i18n.t("story:history.storyboard"), commands);
}

/** One shot's frame, whole, as the reader leaves it. */
function writeFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  slot: StorySlot,
) {
  return execute(i18n.t("story:history.storyboard"), [
    {
      type: "setStorySlot",
      storyId: story.id,
      target: {
        kind: "keyframe",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      },
      slot,
    },
  ]);
}

/**
 * One shot's old drawing dropped from its place, as the live document holds
 * that place: a slot is written whole, so a slot read off the table's render
 * would put back whatever a job landed while the picks dialog stood open.
 */
function dropFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  assetId: string,
): TakeDrop {
  const live = liveStory(story.id);
  const frame =
    live === undefined
      ? undefined
      : keyframeAt(live, {
          chapterId,
          actId: act.id,
          keyframeId: keyframe.id,
        });
  if (live === undefined || frame === undefined) return "gone";
  const without = slotWithoutTake(frame.art, assetId);
  if (without === frame.art) return "gone";
  return writeFrame(live, chapterId, act, frame, without) === null
    ? "refused"
    : "dropped";
}

/** One shot's own clip, whole, as the reader leaves it. */
function writeClip(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  slot: StorySlot,
): void {
  execute(i18n.t("story:history.storyboard"), [
    {
      type: "setStorySlot",
      storyId: story.id,
      target: {
        kind: "keyframeVideo",
        chapterId,
        actId: act.id,
        keyframeId: keyframe.id,
      },
      slot,
    },
  ]);
}

/** Keeps the frame a reader picked, letting the older ones go on being there. */
function keepFrame(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframe: StoryKeyframe,
  assetId: string,
): void {
  writeFrame(
    story,
    chapterId,
    act,
    keyframe,
    slotWithCurrent(keyframe.art, assetId),
  );
}
