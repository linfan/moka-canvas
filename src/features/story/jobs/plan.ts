/**
 * What a step of the story room is asked for, as a batch of pieces.
 *
 * The room's buttons know what they are about — this chapter, these drawings,
 * this act — and nothing about how a model is asked: which picture of a
 * character travels with which line of the prompt, how long a clip is allowed
 * to be, what a shot with no drawing of its own leaves out. That knowing lives
 * here, in one place per step, so a prompt written into a button is not a thing
 * that can happen.
 *
 * Everything is planned from the document as it stands now rather than from
 * what a job record says was asked before: a retry is a new ask with today's
 * words and today's references, which is the only way a batch re-sent after a
 * description was edited comes back matching the description.
 */

import type {
  StoryJobInput,
  StoryJobItemDraft,
  StoryTarget,
} from "../../../api/story";
import { MAX_VIDEO_SECONDS } from "../../../shared/domain/constants";
import {
  STORY_CAMERA_ANGLES,
  STORY_CAMERA_MOVES,
  STORY_SHOT_SIZES,
} from "../../../shared/domain/types";
import {
  actCast,
  actAt,
  actPlannedMs,
  currentTake,
  elementOf,
  keyframeAt,
  targetKey,
} from "../../../shared/domain/story";
import type { SourceChunk } from "../../../shared/domain/storySource";
import type { StoryElement } from "../../../shared/domain";
import type {
  StoryAct,
  StoryAspect,
  StoryDialogueLine,
  StoryDocument,
} from "../../../shared/domain/types";
import {
  storyActMusicPrompt,
  storyActVideoPrompt,
  storyActVoicePrompt,
  storyElementMainPrompt,
  storyElementTurnaroundPrompt,
  storyElementsPrompt,
  storyKeyframePrompt,
  storyKeyframeVideoPrompt,
  storyOutlinePrompt,
  storySplitPrompt,
  storyStoryboardPrompt,
  storySystemPrompt,
  type StoryFacts,
  type StoryLook,
} from "../../../shared/prompts";
import { i18n } from "../../../shared/i18n";
import { useModelStore } from "../../settings/modelStore";

/**
 * The name a piece is known by, which is also how its answer is recognised
 * when it is applied.
 *
 * A slot's own name wherever the piece is for a slot, so an answer that comes
 * home twice lands in the same place twice; the steps that produce words rather
 * than pictures are named after what they write, and a manuscript's parts are
 * numbered because each part is a chapter's ask.
 */
export function jobKey(target: StoryTarget): string {
  switch (target.kind) {
    case "outline":
      return "outline";
    case "elements":
      return "elements";
    case "storyboard":
      return `storyboard:${target.chapterId}`;
    case "elementArt":
      return targetKey({
        kind: "element",
        elementId: target.elementId,
        view: target.view,
      });
    case "keyframeArt":
      return targetKey({
        kind: "keyframe",
        chapterId: target.chapterId,
        actId: target.actId,
        keyframeId: target.keyframeId,
      });
    case "actVideo":
      return targetKey({
        kind: "actVideo",
        chapterId: target.chapterId,
        actId: target.actId,
      });
    case "keyframeVideo":
      return targetKey({
        kind: "keyframeVideo",
        chapterId: target.chapterId,
        actId: target.actId,
        keyframeId: target.keyframeId,
      });
    case "voice":
      return targetKey({
        kind: "actVoice",
        chapterId: target.chapterId,
        actId: target.actId,
      });
    case "music":
      return targetKey({
        kind: "actMusic",
        chapterId: target.chapterId,
        actId: target.actId,
      });
  }
}

/** The drawing size closest to the frame a story is cut to. */
export function imageSizeForAspect(aspect: StoryAspect): string {
  switch (aspect) {
    case "9:16":
      return "1024x1536";
    case "1:1":
      return "1024x1024";
    default:
      return "1536x1024";
  }
}

/**
 * How many seconds a clip is asked for: what the story plans for it, rounded to
 * seconds, never less than one and never past the ceiling the video settings
 * allow. Asking for longer than the deployment can film would come back cut
 * without saying so.
 */
export function clampSeconds(
  ms: number,
  ceiling: number = MAX_VIDEO_SECONDS,
): number {
  return Math.min(ceiling, Math.max(1, Math.round(ms / 1000)));
}

/**
 * The longest a clip may be asked for, as the video settings say.
 *
 * Read at the moment a plan is made rather than held, since the setting is a
 * preference of the machine and a batch planned before it changed is a batch
 * already sent.
 */
function videoCeiling(): number {
  const seconds = useModelStore.getState().view?.preferences.video.seconds;
  return typeof seconds === "number" && seconds > 0
    ? seconds
    : MAX_VIDEO_SECONDS;
}

/**
 * A clip's parameters: how long it runs, in what shape, and the machine's own
 * answers about sound and a watermark.
 *
 * The story decides the first two — a clip is as long as the story planned and
 * as wide as the story is told — and the preferences decide the rest, since
 * whether a provider writes sound into its clip is not a thing a telling has
 * an opinion about.
 */
function videoParams(
  ratio: StoryAspect,
  seconds: number,
): Record<string, unknown> {
  const video = useModelStore.getState().view?.preferences.video;
  return {
    seconds,
    ratio,
    ...(video?.resolution ? { resolution: video.resolution } : {}),
    generateAudio: video?.generateAudio ?? false,
    watermark: video?.watermark ?? false,
  };
}

function factsOf(story: StoryDocument): StoryFacts {
  return {
    aspect: story.brief.aspect,
    genre: story.brief.genre,
    style: story.brief.style,
    totalDurationMs: story.brief.totalDurationMs,
  };
}

function lookOf(story: StoryDocument): StoryLook {
  return { aspect: story.brief.aspect, style: story.brief.style };
}

// -----------------------------------------------------------------------------
// Step two and three: the words
// -----------------------------------------------------------------------------

/**
 * The outline: either the premise written into chapters, or a manuscript's
 * parts written into them one at a time.
 *
 * A part is not a chapter yet when it is sent — what comes back is — so the
 * pieces are numbered and applied in order, which is the order the manuscript
 * was read in.
 */
export function planOutline(
  story: StoryDocument,
  options: {
    mode: "expand" | "split";
    chapters: number;
    chunks?: SourceChunk[];
  },
): StoryJobItemDraft[] {
  if (options.mode === "split") {
    const chunks = options.chunks ?? [];
    return chunks.map((chunk, index) => ({
      id: `outline:${index + 1}`,
      target: { kind: "outline" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storySplitPrompt({
        // The heading the manuscript itself wrote for this part travels with
        // it: a chapter is asked for by the name it was written under.
        text:
          chunk.title === undefined
            ? chunk.text
            : `${chunk.title}\n${chunk.text}`,
        index: index + 1,
        total: chunks.length,
        genre: story.brief.genre,
        style: story.brief.style,
      }),
    }));
  }
  return [
    {
      id: "outline",
      target: { kind: "outline" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storyOutlinePrompt({
        ...factsOf(story),
        idea: story.brief.idea,
        chapters: options.chapters,
      }),
    },
  ];
}

/**
 * The characters, places and things the chapters are made of.
 *
 * One ask for the whole telling wherever it fits, and otherwise a part of the
 * chapters at a time — a long telling's synopses are more than one prompt may
 * carry. A part is numbered the way a manuscript's parts are, and what it
 * names is read into the cast beside what earlier parts found rather than in
 * place of it.
 */
export function planElements(
  story: StoryDocument,
  options: { chapterIds?: string[]; part?: number; total?: number } = {},
): StoryJobItemDraft[] {
  const asked =
    options.chapterIds === undefined
      ? story.chapters
      : story.chapters.filter((chapter) =>
          options.chapterIds?.includes(chapter.id),
        );
  return [
    {
      id: options.part === undefined ? "elements" : `elements:${options.part}`,
      target: { kind: "elements" },
      capability: "text",
      system: storySystemPrompt(),
      prompt: storyElementsPrompt({
        chapters: asked.map((chapter) => ({
          title: chapter.title,
          synopsis: chapter.synopsis,
        })),
        genre: story.brief.genre,
        style: story.brief.style,
        ...(options.part === undefined
          ? {}
          : { part: options.part, total: options.total }),
      }),
    },
  ];
}

/** The board of one or more episodes, one ask each. */
export function planStoryboard(
  story: StoryDocument,
  chapterIds: string[],
): StoryJobItemDraft[] {
  const facts = factsOf(story);
  return chapterIds.flatMap((chapterId) => {
    const number = story.chapters.findIndex((held) => held.id === chapterId);
    const chapter = story.chapters[number];
    if (chapter === undefined) return [];
    const target: StoryTarget = { kind: "storyboard", chapterId };
    return [
      {
        id: jobKey(target),
        target,
        capability: "text",
        system: storySystemPrompt(),
        prompt: storyStoryboardPrompt({
          ...facts,
          number: number + 1,
          chapter: { title: chapter.title, synopsis: chapter.synopsis },
          targetDurationMs: chapter.targetDurationMs,
          elements: story.elements.map((element) => ({
            kind: element.kind,
            name: element.name,
            description: element.description,
          })),
          shotSizes: STORY_SHOT_SIZES,
          cameraMoves: STORY_CAMERA_MOVES,
          angles: STORY_CAMERA_ANGLES,
        }),
      },
    ];
  });
}

// -----------------------------------------------------------------------------
// Step three and four: the drawings
// -----------------------------------------------------------------------------

/**
 * A character, a place or a thing, drawn on its own.
 *
 * A character's turn-around is drawn from the picture already on file, so it is
 * not planned at all while that picture is missing: four views of a face nobody
 * has drawn is four different people.
 */
export function planElementArt(
  story: StoryDocument,
  targets: Array<{ elementId: string; view: "main" | "turnaround" }>,
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const size = imageSizeForAspect(story.brief.aspect);
  return targets.flatMap(({ elementId, view }) => {
    const element = elementOf(story, elementId);
    if (element === undefined) return [];
    const main = currentTake(element.main);
    if (view === "turnaround" && main === undefined) return [];
    const target: StoryTarget = { kind: "elementArt", elementId, view };
    return [
      {
        id: jobKey(target),
        target,
        capability: "image",
        prompt:
          view === "turnaround"
            ? storyElementTurnaroundPrompt({
                ...look,
                name: element.name,
                description: element.description,
              })
            : storyElementMainPrompt({
                ...look,
                kind: element.kind,
                name: element.name,
                description: element.description,
              }),
        // A main picture is drawn from its description alone: handing the
        // previous one over would ask for the drawing that is being replaced.
        // A turn-around is the other way round — four views of the character
        // who was already drawn, from the picture that drew them.
        inputs:
          view === "turnaround" && main !== undefined
            ? [{ role: "reference", assetId: main.assetId }]
            : [],
        params: { size },
      },
    ];
  });
}

/**
 * The cast of an act that has been drawn, in the order a picture is prompted
 * with them: the characters, then the place, then the things.
 *
 * The order is the contract between the numbered references in the prompt and
 * the pictures that travel with it, so it is decided once, here.
 */
function drawnCast(
  story: StoryDocument,
  act: StoryAct,
): Array<{ element: StoryElement; assetId: string }> {
  const { characters, scenes, props } = actCast(story, act);
  return [...characters, ...scenes, ...props].flatMap((element) => {
    const take = currentTake(element.main);
    return take === undefined ? [] : [{ element, assetId: take.assetId }];
  });
}

/** One frame of a board, drawn with the cast that stands in it. */
export function planKeyframeArt(
  story: StoryDocument,
  targets: Array<{ chapterId: string; actId: string; keyframeId: string }>,
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const size = imageSizeForAspect(story.brief.aspect);
  return targets.flatMap(({ chapterId, actId, keyframeId }) => {
    const chapter = story.chapters.find((held) => held.id === chapterId);
    const act = actAt(story, chapterId, actId);
    const keyframe =
      act === undefined
        ? undefined
        : act.keyframes.find((held) => held.id === keyframeId);
    if (chapter === undefined || act === undefined || keyframe === undefined)
      return [];
    const cast = drawnCast(story, act);
    const target: StoryTarget = {
      kind: "keyframeArt",
      chapterId,
      actId,
      keyframeId,
    };
    return [
      {
        id: jobKey(target),
        target,
        capability: "image",
        prompt: storyKeyframePrompt({
          ...look,
          chapter: { title: chapter.title },
          act: { summary: act.summary },
          keyframe: {
            content: keyframe.content,
            shotSize: keyframe.shotSize,
            cameraMove: keyframe.cameraMove,
            angle: keyframe.angle,
          },
          cast: cast.map(({ element }) => ({
            name: element.name,
            description: element.description,
          })),
        }),
        inputs: cast.map(({ assetId }) => ({
          role: "reference" as const,
          assetId,
        })),
        params: { size },
      },
    ];
  });
}

// -----------------------------------------------------------------------------
// Step four: the clips
// -----------------------------------------------------------------------------

/** One act filmed whole, moving between the drawings its shots were given. */
export function planActVideos(
  story: StoryDocument,
  chapterId: string,
  actIds: string[],
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const ceiling = videoCeiling();
  return actIds.flatMap((actId) => {
    const act = actAt(story, chapterId, actId);
    if (act === undefined || act.keyframes.length === 0) return [];
    const drawn = act.keyframes.flatMap((keyframe) => {
      const take = currentTake(keyframe.art);
      return take === undefined
        ? []
        : [{ content: keyframe.content, assetId: take.assetId }];
    });
    if (drawn.length === 0) return [];
    const first = drawn[0];
    const last = drawn[drawn.length - 1];
    const between = drawn.slice(1, -1);
    const seconds = clampSeconds(actPlannedMs(act), ceiling);
    const target: StoryTarget = { kind: "actVideo", chapterId, actId };
    const inputs: StoryJobInput[] = [
      { role: "firstFrame", assetId: first.assetId },
    ];
    if (drawn.length > 1) {
      inputs.push({ role: "lastFrame", assetId: last.assetId });
    }
    for (const frame of between) {
      inputs.push({ role: "reference", assetId: frame.assetId });
    }
    return [
      {
        id: jobKey(target),
        target,
        capability: "video",
        prompt: storyActVideoPrompt({
          ...look,
          title: act.title,
          summary: act.summary,
          first: first.content,
          last: last.content,
          middle: between.map((frame) => frame.content).join("; "),
          seconds,
        }),
        inputs,
        params: videoParams(story.brief.aspect, seconds),
      },
    ];
  });
}

/** One shot filmed, starting from its own drawing and ending on the next. */
export function planKeyframeVideos(
  story: StoryDocument,
  chapterId: string,
  actId: string,
  keyframeIds: string[],
): StoryJobItemDraft[] {
  const look = lookOf(story);
  const ceiling = videoCeiling();
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  return keyframeIds.flatMap((keyframeId) => {
    const keyframe = keyframeAt(story, { chapterId, actId, keyframeId });
    if (keyframe === undefined) return [];
    const frame = currentTake(keyframe.art);
    if (frame === undefined) return [];
    const position = act.keyframes.indexOf(keyframe);
    const after = act.keyframes[position + 1] ?? keyframe;
    const lastFrame = currentTake(after.art)?.assetId;
    const seconds = clampSeconds(keyframe.durationMs, ceiling);
    const target: StoryTarget = {
      kind: "keyframeVideo",
      chapterId,
      actId,
      keyframeId,
    };
    const inputs: StoryJobInput[] = [
      { role: "firstFrame", assetId: frame.assetId },
    ];
    if (lastFrame !== undefined && lastFrame !== frame.assetId) {
      inputs.push({ role: "lastFrame", assetId: lastFrame });
    }
    return [
      {
        id: jobKey(target),
        target,
        capability: "video",
        prompt: storyKeyframeVideoPrompt({
          ...look,
          title: keyframe.title,
          content: keyframe.content,
          seconds,
        }),
        inputs,
        params: videoParams(story.brief.aspect, seconds),
      },
    ];
  });
}

// -----------------------------------------------------------------------------
// The sound of an act
// -----------------------------------------------------------------------------

/**
 * An act's lines read aloud, as one piece in one voice.
 *
 * One ask for the whole act rather than one a line, because a voice that
 * changed halfway through an act is not a voice: the lines of every shot are
 * flattened in board order, and a line with no words in it is not read.
 */
export function planActVoice(
  story: StoryDocument,
  chapterId: string,
  actId: string,
): StoryJobItemDraft[] {
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  const lines = act.keyframes
    .flatMap((keyframe) => keyframe.dialogue)
    .map((line) => spokenLine(line))
    .filter((line) => line !== "");
  if (lines.length === 0) return [];
  const target: StoryTarget = { kind: "voice", chapterId, actId };
  return [
    {
      id: jobKey(target),
      target,
      capability: "audio",
      prompt: storyActVoicePrompt({
        ...lookOf(story),
        genre: story.brief.genre,
        title: act.title,
        summary: act.summary,
        lines,
      }),
      inputs: [],
      params: voiceParams(story),
    },
  ];
}

/**
 * An act's music and sound, as one piece under the whole act.
 *
 * The three descriptions the board holds are asked for together, since music
 * that arrived as three files would be three things a reader has to mix; an
 * act with nothing said about its sound has nothing to ask for.
 */
export function planActMusic(
  story: StoryDocument,
  chapterId: string,
  actId: string,
): StoryJobItemDraft[] {
  const act = actAt(story, chapterId, actId);
  if (act === undefined) return [];
  const music = act.sound.music.trim();
  const sfx = act.sound.sfx.trim();
  const ambience = (act.sound.ambience ?? "").trim();
  if (music === "" && sfx === "" && ambience === "") return [];
  const seconds = clampSeconds(actPlannedMs(act), audioCeiling());
  const target: StoryTarget = { kind: "music", chapterId, actId };
  return [
    {
      id: jobKey(target),
      target,
      capability: "audio",
      prompt: storyActMusicPrompt({
        ...lookOf(story),
        genre: story.brief.genre,
        title: act.title,
        summary: act.summary,
        music,
        sfx,
        ambience,
        seconds,
      }),
      inputs: [],
      // The score plays under the lines rather than being sung over them, so a
      // service that can write words for a song is told not to; a voice model
      // asked for music ignores the flag.
      params: { music: true, instrumental: true, ...audioParams() },
    },
  ];
}

/** One line of dialogue as it is read aloud, with the tone in brackets. */
function spokenLine(line: StoryDialogueLine): string {
  const words = line.text.trim();
  if (words === "") return "";
  const speaker = line.speaker.trim();
  const said = speaker === "" ? words : `${speaker}：${words}`;
  const tone = (line.tone ?? "").trim();
  return tone === "" ? said : `${said}（${tone}）`;
}

/**
 * What a read-aloud ask is carried with: the machine's own voice, and the
 * acting direction the telling gives it.
 *
 * The direction rides in `instructions` because that is the parameter a
 * speech model reads as how to say something; a protocol that has never heard
 * of it drops it rather than failing, which is the gateway's standing rule.
 */
function voiceParams(story: StoryDocument): Record<string, unknown> {
  return {
    ...audioParams(),
    instructions: i18n.t("story:voice.instructions", {
      genre: story.brief.genre,
      style: story.brief.style,
    }),
  };
}

/** The format and pace this machine's audio settings ask for. */
function audioParams(): Record<string, unknown> {
  const audio = useModelStore.getState().view?.preferences.audio;
  return {
    ...(audio?.voice ? { voice: audio.voice } : {}),
    ...(audio?.format ? { format: audio.format } : {}),
    ...(audio?.speed ? { speed: audio.speed } : {}),
  };
}

/**
 * The longest a piece of sound may be asked for. Sound has no ceiling of its
 * own in the settings — a score is as long as the act it sits under — so this
 * is the same one clips are filmed with rather than a second number.
 */
function audioCeiling(): number {
  return videoCeiling();
}

// -----------------------------------------------------------------------------
// Asking again for what did not come back
// -----------------------------------------------------------------------------

/**
 * The pieces that would make these places again, planned from the story as it
 * stands now.
 *
 * This is what a retry is: not the old ask sent twice, but the ask today's
 * document would make. A description that was edited between the two, a
 * reference that has since been redrawn, a chapter that moved — all of them
 * belong to the new ask, and none of them were in the old one.
 */
export function itemsForTargets(
  story: StoryDocument,
  targets: StoryTarget[],
): StoryJobItemDraft[] {
  return targets.flatMap((target) => {
    switch (target.kind) {
      case "outline":
        return planOutline(story, {
          mode: "expand",
          chapters: Math.max(1, story.chapters.length),
        });
      case "elements":
        return planElements(story);
      case "storyboard":
        return planStoryboard(story, [target.chapterId]);
      case "elementArt":
        return planElementArt(story, [
          { elementId: target.elementId, view: target.view },
        ]);
      case "keyframeArt":
        return planKeyframeArt(story, [target]);
      case "actVideo":
        return planActVideos(story, target.chapterId, [target.actId]);
      case "keyframeVideo":
        return planKeyframeVideos(story, target.chapterId, target.actId, [
          target.keyframeId,
        ]);
      case "voice":
        return planActVoice(story, target.chapterId, target.actId);
      case "music":
        return planActMusic(story, target.chapterId, target.actId);
    }
  });
}
