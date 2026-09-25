/**
 * The story room's own arithmetic: how far each step has got, what a new
 * answer keeps of the old one, and which place a job is asking about.
 *
 * Nothing here reads a file, a store, or a translated word. The room's
 * interface, the job client, and the server's own bookkeeping all reason
 * about a story through these functions, so a rule written once holds
 * everywhere it is read.
 */

import { MAX_TAKES_PER_SLOT } from "./constants";
import {
  createAct,
  createChapter,
  createElement,
  createKeyframe,
} from "./factories";
import type {
  StoryAct,
  StoryActSound,
  StoryCameraAngle,
  StoryCameraMove,
  StoryChapter,
  StoryDialogueLine,
  StoryDocument,
  StoryElement,
  StoryElementKind,
  StoryKeyframe,
  StorySlot,
  StorySlotTarget,
  StoryShotSize,
  StoryTake,
} from "./types";

// -----------------------------------------------------------------------------
// Where each step has got to
// -----------------------------------------------------------------------------

export const STORY_STEPS = [
  "idea",
  "outline",
  "elements",
  "storyboard",
  "edit",
] as const;
export type StoryStep = (typeof STORY_STEPS)[number];

export type StoryStepState =
  "empty" | "working" | "ready" | "confirmed" | "failed";

/**
 * One step's place in the telling.
 *
 * `done` and `total` count what the step settles — chapters confirmed,
 * elements drawn, acts finished — so the room can say "3/12" without knowing
 * what a chapter is. A step with nothing to count carries one number or none,
 * never a sentence: the words around the numbers belong to the interface, and
 * it has the reader's language.
 */
export interface StoryStepProgress {
  step: StoryStep;
  state: StoryStepState;
  done: number;
  total: number;
}

/**
 * How far a step has got, from three answers about it: is there anything at
 * all, is all of it made, has the reader agreed to all of it.
 *
 * A step with some of its work done and some still to do is `working`, which
 * is also what a step whose work is out with a model says: the document can
 * tell what was settled, and what is being tried is the room's business.
 */
function stepState(
  empty: boolean,
  ready: boolean,
  confirmed: boolean,
): StoryStepState {
  if (empty) return "empty";
  if (confirmed) return "confirmed";
  return ready ? "ready" : "working";
}

/** How many shots an episode is boarded with. */
export function keyframeCount(chapter: StoryChapter): number {
  return chapter.acts.reduce((sum, act) => sum + act.keyframes.length, 0);
}

/** How long an act is meant to run: its shots, one after another. */
export function actPlannedMs(act: StoryAct): number {
  return act.keyframes.reduce((sum, keyframe) => sum + keyframe.durationMs, 0);
}

/** Whether every shot in an episode has its own clip. */
export function chapterHasAllKeyframeVideos(chapter: StoryChapter): boolean {
  return (
    chapter.acts.length > 0 &&
    chapter.acts.every(
      (act) =>
        act.keyframes.length > 0 &&
        act.keyframes.every((keyframe) => keyframe.video.takes.length > 0),
    )
  );
}

/** Whether every shot in an act has a frame drawn for it. */
export function actHasAllArt(act: StoryAct): boolean {
  return (
    act.keyframes.length > 0 &&
    act.keyframes.every((keyframe) => keyframe.art.takes.length > 0)
  );
}

/** Whether an act's clip has been made, at whichever granularity is in force. */
export function actHasVideo(
  act: StoryAct,
  granularity: StoryDocument["shotGranularity"],
): boolean {
  if (granularity === "keyframe") return chapterClipMade(act);
  return act.video.takes.length > 0;
}

/** Whether an act's clip is made and agreed to, at whichever granularity. */
export function actVideoSettled(
  act: StoryAct,
  granularity: StoryDocument["shotGranularity"],
): boolean {
  return actHasVideo(act, granularity) && act.videoConfirmed;
}

/** Whether every shot of an act has been filmed, which is how a clip is made. */
function chapterClipMade(act: StoryAct): boolean {
  return (
    act.keyframes.length > 0 &&
    act.keyframes.every((keyframe) => keyframe.video.takes.length > 0)
  );
}

/** Whether a character has both drawings a character is drawn with. */
function elementDrawn(element: StoryElement): boolean {
  if (element.main.takes.length === 0) return false;
  return (
    element.kind !== "character" || (element.turnaround?.takes.length ?? 0) > 0
  );
}

/** Whether a character's drawings are the ones the reader agreed to. */
function elementAgreed(element: StoryElement): boolean {
  if (!element.descriptionConfirmed || !element.main.confirmed) return false;
  return element.kind !== "character" || element.turnaround?.confirmed === true;
}

/**
 * The five steps' progress through one story, read from the document alone.
 *
 * A step that is waiting on a job is not something a document can say — what
 * is being tried is not what was settled — so the room lays its own failures
 * and spinners over these answers rather than asking for them here.
 */
export function storyProgress(
  story: StoryDocument,
): Record<StoryStep, StoryStepProgress> {
  const chapters = story.chapters;
  const acts = chapters.flatMap((chapter) => chapter.acts);
  const granularity = story.shotGranularity;

  const ideaDone = story.brief.idea.trim().length > 0;

  const confirmedChapters = chapters.filter(
    (chapter) => chapter.synopsisConfirmed,
  ).length;
  const everyChapterConfirmed =
    chapters.length > 0 && confirmedChapters === chapters.length;
  const everyChapterBoarded =
    everyChapterConfirmed &&
    chapters.every((chapter) => chapter.acts.length > 0);

  const elements = story.elements;
  const settledElements = elements.filter(elementAgreed).length;
  const everyElementDrawn = elements.length > 0 && elements.every(elementDrawn);

  const settledActs = acts.filter((act) =>
    actVideoSettled(act, granularity),
  ).length;
  const everyActBoarded = acts.length > 0 && acts.every(actHasAllArt);

  return {
    idea: {
      step: "idea",
      state: ideaDone ? "confirmed" : "empty",
      done: ideaDone ? 1 : 0,
      total: 1,
    },
    outline: {
      step: "outline",
      state: stepState(
        chapters.length === 0,
        everyChapterConfirmed,
        everyChapterConfirmed && everyChapterBoarded,
      ),
      done: confirmedChapters,
      total: chapters.length,
    },
    elements: {
      step: "elements",
      state: stepState(
        elements.length === 0,
        everyElementDrawn,
        elements.length > 0 && settledElements === elements.length,
      ),
      done: settledElements,
      total: elements.length,
    },
    storyboard: {
      step: "storyboard",
      state: stepState(
        acts.length === 0,
        everyActBoarded,
        acts.length > 0 && settledActs === acts.length,
      ),
      done: settledActs,
      total: acts.length,
    },
    edit: {
      step: "edit",
      state: story.edit.film
        ? "confirmed"
        : story.edit.timelineId
          ? "ready"
          : "empty",
      done: story.edit.film ? 1 : 0,
      total: 1,
    },
  };
}

// -----------------------------------------------------------------------------
// What the parsers hand over
// -----------------------------------------------------------------------------

/** An outline's chapter, before it meets the story it will become. */
export interface StoryChapterDraft {
  title: string;
  synopsis: string;
  targetDurationMs?: number;
}

/** An identified element, before it meets the elements already known. */
export interface StoryElementDraft {
  kind: StoryElementKind;
  name: string;
  description: string;
  /** Where the outline put this, counted in chapters; resolved by the caller. */
  chapterIndexes?: number[];
}

/** A shot as the board was written, before it meets the board on file. */
export interface KeyframeDraft {
  shotSize: StoryShotSize;
  cameraMove: StoryCameraMove;
  angle: StoryCameraAngle;
  content: string;
  dialogue: Array<{
    speaker: string;
    text: string;
    tone?: string;
    characterId?: string;
  }>;
  durationMs: number;
}

/**
 * An act as the board was written.
 *
 * The cast arrives already resolved to element ids: a name the parser could
 * not match against the elements on file is not in these lists, because a
 * reference nobody can draw is not a reference.
 */
export interface ActDraft {
  title: string;
  summary: string;
  characters: string[];
  scene?: string;
  props: string[];
  sound: StoryActSound;
  keyframes: KeyframeDraft[];
}

// -----------------------------------------------------------------------------
// Merging an answer into what is already there
// -----------------------------------------------------------------------------

/**
 * An outline's chapters against the story's own.
 *
 * A chapter is matched to the one in its place — an outline is read in order,
 * and a chapter is the same chapter when it stands where it stood. A matched
 * chapter keeps everything that was made for it and takes only the new words:
 * a board survives a re-write of the outline it was made from.
 */
export function mergeChapters(
  existing: StoryChapter[],
  proposed: StoryChapterDraft[],
): StoryChapter[] {
  return proposed.map((draft, index) => {
    const held = existing[index];
    if (!held) return createChapter(draft.title, draft.synopsis);
    return {
      ...held,
      title: draft.title,
      synopsis: draft.synopsis,
      targetDurationMs: draft.targetDurationMs ?? held.targetDurationMs,
    };
  });
}

/** The name two elements are the same by: kind, and the name without its airs. */
function elementKey(kind: StoryElementKind, name: string): string {
  return `${kind}:${name.trim().toLowerCase()}`;
}

/**
 * An identification's elements against the story's own.
 *
 * Matching is by kind and name rather than by place, because reading a story
 * does not reorder its cast the way an outline's chapters are ordered: a
 * character is the same character under another description, and the pictures
 * already drawn of them belong to the reader, not to the model.
 *
 * `chapters` resolves the draft's chapter numbers into the story's chapter
 * ids; a number naming no chapter is dropped rather than guessed at.
 */
export function mergeElements(
  existing: StoryElement[],
  identified: StoryElementDraft[],
  chapters: StoryChapter[] = [],
): StoryElement[] {
  const known = new Map(
    existing.map((element) => [
      elementKey(element.kind, element.name),
      element,
    ]),
  );
  return identified.map((draft) => {
    const held = known.get(elementKey(draft.kind, draft.name));
    const chapterIds = (draft.chapterIndexes ?? [])
      .map((index) => chapters[index]?.id)
      .filter((id): id is string => id !== undefined);
    if (!held)
      return createElement(
        draft.kind,
        draft.name,
        draft.description,
        chapterIds,
      );
    return {
      ...held,
      name: draft.name,
      description: draft.description,
      chapterIds: chapterIds.length > 0 ? chapterIds : held.chapterIds,
    };
  });
}

/**
 * A board's acts against the acts already on file.
 *
 * An act is matched to the one in its place, and a shot to the shot in its
 * place within it: re-boarding an episode that already has frames keeps them,
 * so asking the model for the words again does not throw away the pictures
 * the reader has already looked at. What a new board brings is what a board
 * is — the words, the cast, the sound.
 */
export function mergeActs(
  existing: StoryAct[],
  proposed: ActDraft[],
): StoryAct[] {
  return proposed.map((draft, index) => {
    const held = existing[index];
    const keyframes = mergeKeyframes(held?.keyframes ?? [], draft.keyframes);
    if (!held) {
      return {
        ...createAct(draft.title, draft.summary),
        characterIds: draft.characters,
        ...(draft.scene !== undefined ? { sceneId: draft.scene } : {}),
        propIds: draft.props,
        sound: draft.sound,
        keyframes,
      };
    }
    return {
      ...held,
      title: draft.title,
      summary: draft.summary,
      characterIds: draft.characters,
      sceneId: draft.scene,
      propIds: draft.props,
      sound: draft.sound,
      keyframes,
    };
  });
}

/** A board's shots against the shots already on file, paired by place. */
function mergeKeyframes(
  existing: StoryKeyframe[],
  proposed: KeyframeDraft[],
): StoryKeyframe[] {
  return proposed.map((draft, index) => {
    const held = existing[index];
    const dialogue: StoryDialogueLine[] = draft.dialogue.map((line) => ({
      ...(line.characterId !== undefined
        ? { characterId: line.characterId }
        : {}),
      speaker: line.speaker,
      text: line.text,
      ...(line.tone !== undefined ? { tone: line.tone } : {}),
    }));
    if (!held) {
      return {
        ...createKeyframe(index, draft.shotSize, draft.cameraMove, draft.angle),
        content: draft.content,
        dialogue,
        durationMs: draft.durationMs,
      };
    }
    return {
      ...held,
      shotSize: draft.shotSize,
      cameraMove: draft.cameraMove,
      angle: draft.angle,
      content: draft.content,
      dialogue,
      durationMs: draft.durationMs,
    };
  });
}

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

/** The take a place is using, which is the newest one kept. */
export function currentTake(slot: StorySlot): StoryTake | undefined {
  return slot.takes[slot.takes.length - 1];
}

/**
 * A place with this take added.
 *
 * A take already kept is not kept twice, however many times a job's answer is
 * applied: the same drawing filed at the same place is the same drawing, and
 * the room reads a job's answer more than once. The oldest take is let go
 * when the place is full, since what a reader is choosing between is recent
 * work.
 */
export function withTake(
  slot: StorySlot,
  take: StoryTake,
  max: number = MAX_TAKES_PER_SLOT,
): StorySlot {
  if (slot.takes.some((kept) => kept.assetId === take.assetId)) return slot;
  const takes = [...slot.takes, take];
  return {
    ...slot,
    takes: takes.length > max ? takes.slice(takes.length - max) : takes,
  };
}

/** The element an id names, if the story still holds it. */
export function elementOf(
  story: StoryDocument,
  id: string,
): StoryElement | undefined {
  return story.elements.find((element) => element.id === id);
}

/**
 * The act's cast, as the story holds it: the elements that are still there,
 * and the ids of the references that are not.
 *
 * A drawing is asked for with what is there, and the room says out loud what
 * it could not find rather than quietly prompting with a character who was
 * taken out of the story.
 */
export function actCast(
  story: StoryDocument,
  act: StoryAct,
): {
  characters: StoryElement[];
  scenes: StoryElement[];
  props: StoryElement[];
  missing: string[];
} {
  const byId = new Map(story.elements.map((element) => [element.id, element]));
  const missing: string[] = [];
  const pick = (ids: string[]): StoryElement[] =>
    ids.flatMap((id) => {
      const element = byId.get(id);
      if (element) return [element];
      missing.push(id);
      return [];
    });
  const characters = pick(act.characterIds);
  const scenes = pick(act.sceneId === undefined ? [] : [act.sceneId]);
  const props = pick(act.propIds);
  return { characters, scenes, props, missing };
}

/**
 * The name a place is known by while work is out on it.
 *
 * It is written from the target alone, so the room's "is this being drawn
 * just now" and a job's "which place is this item for" are the same answer
 * without either of them having to read the document.
 */
export function targetKey(target: StorySlotTarget): string {
  switch (target.kind) {
    case "element":
      return `element:${target.view}:${target.elementId}`;
    case "keyframe":
      return `keyframe:${target.chapterId}:${target.actId}:${target.keyframeId}`;
    case "actVideo":
      return `actVideo:${target.chapterId}:${target.actId}`;
    case "keyframeVideo":
      return `keyframeVideo:${target.chapterId}:${target.actId}:${target.keyframeId}`;
  }
}

/** The act a target names, if the story still holds it. */
export function actAt(
  story: StoryDocument,
  chapterId: string,
  actId: string,
): StoryAct | undefined {
  return story.chapters
    .find((chapter) => chapter.id === chapterId)
    ?.acts.find((act) => act.id === actId);
}

/** The shot a target names, if the story still holds it. */
export function keyframeAt(
  story: StoryDocument,
  target: { chapterId: string; actId: string; keyframeId: string },
): StoryKeyframe | undefined {
  return actAt(story, target.chapterId, target.actId)?.keyframes.find(
    (keyframe) => keyframe.id === target.keyframeId,
  );
}

// -----------------------------------------------------------------------------
// What a reader is shown
// -----------------------------------------------------------------------------

/**
 * The step a story is standing on: the first one that is not settled, which is
 * the one whose work is wanted next.
 *
 * A story every step of which is settled reads as standing on its last step,
 * since that is where the finished film is.
 */
export function storyCurrentStep(
  progress: Record<StoryStep, StoryStepProgress>,
): StoryStepProgress {
  for (const step of STORY_STEPS) {
    const held = progress[step];
    if (held.state !== "confirmed") return held;
  }
  return progress[STORY_STEPS[STORY_STEPS.length - 1]];
}

/**
 * Whether a step can be walked to yet.
 *
 * Each step is offered only once the one before it has been settled: a board
 * is written from the outline that was agreed to, and a drawing is made of a
 * character who was described. The first step is always reachable, since a
 * premise can always be re-written.
 */
export function stepReachable(
  progress: Record<StoryStep, StoryStepProgress>,
  step: StoryStep,
): boolean {
  const index = STORY_STEPS.indexOf(step);
  if (index <= 0) return true;
  const before = progress[STORY_STEPS[index - 1]];
  return before.state === "confirmed";
}

/** A running time a reader can read: `mm:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * What deleting a story would stop referring to, counted for the question that
 * is asked before it.
 *
 * Nothing is deleted by it: the drawings and the clips stay in the shelf, and
 * the timeline it assembled stays in the cutting room. What the count says is
 * how much of the telling stops pointing at them.
 */
export function storyDeleteCost(story: StoryDocument): {
  chapters: number;
  acts: number;
  pictures: number;
  videos: number;
} {
  let acts = 0;
  let pictures = story.elements.reduce(
    (sum, element) =>
      sum + element.main.takes.length + (element.turnaround?.takes.length ?? 0),
    0,
  );
  let videos = 0;
  for (const chapter of story.chapters) {
    for (const act of chapter.acts) {
      acts += 1;
      videos += act.video.takes.length;
      for (const keyframe of act.keyframes) {
        pictures += keyframe.art.takes.length;
        videos += keyframe.video.takes.length;
      }
    }
  }
  if (story.edit.film) videos += 1;
  return { chapters: story.chapters.length, acts, pictures, videos };
}
