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
  StoryAspect,
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

/** The fields of a shot the parser had to read a value it did not recognise into. */
export const STORY_GUESSED_FIELDS = [
  "shotSize",
  "cameraMove",
  "angle",
] as const;
export type StoryGuessedField = (typeof STORY_GUESSED_FIELDS)[number];

/**
 * One value the parser did not recognise and read as a default instead.
 *
 * Kept beside the board rather than inside it: what the document holds is the
 * board, and what a reader needs to see is which of its cells a model did not
 * really answer — a shot framed as something nobody offered is a shot whose
 * framing is the parser's word, not the telling's.
 */
export interface StoryGuess {
  /** Which shot of the act, counted from one. */
  keyframe: number;
  field: StoryGuessedField;
  /** What the answer said, which is what was not recognised. */
  from: string;
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
  /** The shots whose framing, movement or angle the parser chose. */
  guessed?: StoryGuess[];
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
 *
 * The table that comes back is the answer's own length, so a telling that was
 * re-split into fewer chapters drops the ones that were left out.
 */
export function mergeChapters(
  existing: StoryChapter[],
  proposed: StoryChapterDraft[],
): StoryChapter[] {
  return mergeChaptersAt(
    existing,
    proposed.map((draft, at) => ({ at, draft })),
    true,
  );
}

/** One chapter's new words, at the place in the table they were asked for. */
export interface ChapterWrite {
  at: number;
  draft: StoryChapterDraft;
}

/**
 * The story's chapters with answers written into the places they belong.
 *
 * A manuscript asked for one part at a time is answered one chapter at a time,
 * and each answer knows which part it is: writing them into the table in the
 * order they happen to come home would put a chapter where the answer before
 * it ended rather than where it was asked for. A place past the end of the
 * table is a chapter the telling has not reached yet — a part that came home
 * before the parts before it did — and is added there rather than left as a
 * hole, since a telling with a gap in it is not a telling.
 *
 * `whole` says the answer is the table rather than a place in it — one ask for
 * every chapter — and then the chapters it left out are dropped.
 */
export function mergeChaptersAt(
  existing: StoryChapter[],
  writes: ChapterWrite[],
  whole = false,
): StoryChapter[] {
  const table = [...existing];
  const sorted = [...writes].sort((one, other) => one.at - other.at);
  for (const { at, draft } of sorted) {
    const place = Math.min(at, table.length);
    const held = table[place];
    table[place] =
      held === undefined
        ? createChapter(draft.title, draft.synopsis)
        : {
            ...held,
            title: draft.title,
            synopsis: draft.synopsis,
            targetDurationMs: draft.targetDurationMs ?? held.targetDurationMs,
          };
  }
  if (!whole) return table;
  const length = writes.reduce(
    (deepest, write) => Math.max(deepest, write.at + 1),
    0,
  );
  return table.slice(0, length);
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
 *
 * A reading that only saw some of the chapters is a `partial` one: what it did
 * not name stays where it was, since a character who stood in the part read
 * first is not gone for being absent from the part read second. A reading of
 * the whole telling is the cast the story now has, and everything else goes.
 */
export function mergeElements(
  existing: StoryElement[],
  identified: StoryElementDraft[],
  chapters: StoryChapter[] = [],
  options: { partial?: boolean } = {},
): StoryElement[] {
  const known = new Map(
    existing.map((element) => [
      elementKey(element.kind, element.name),
      element,
    ]),
  );
  const merged = identified.map((draft) => {
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
  if (options.partial !== true) return merged;
  const named = new Set(
    identified.map((draft) => elementKey(draft.kind, draft.name)),
  );
  return [
    ...merged,
    ...existing.filter((held) => !named.has(elementKey(held.kind, held.name))),
  ];
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

/**
 * The slot a place holds once a take is the one being kept.
 *
 * Keeping is the newest take of the list, which is how every other part of the
 * room reads a place — so choosing one moves it to the end and leaves the rest
 * in the order they were drawn in.
 */
export function slotWithCurrent(slot: StorySlot, assetId: string): StorySlot {
  const chosen = slot.takes.find((held) => held.assetId === assetId);
  if (chosen === undefined) return slot;
  return {
    ...slot,
    takes: [...slot.takes.filter((held) => held.assetId !== assetId), chosen],
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
 * What the step before it has to have settled, read off that step's count.
 *
 * Settled is not the same as the step's dot being confirmed: the outline's dot
 * is confirmed only once every chapter also has a board, and boards are what
 * step four is for — a door waiting on that would be one that never opens. So
 * each step asks the one before it for the thing it actually needs, which is
 * the count that step keeps.
 */
const STEP_OPENS_AFTER: Record<
  StoryStep,
  (before: StoryStepProgress) => boolean
> = {
  /** The first step is always reachable: a premise can always be re-written. */
  idea: () => true,
  /** A premise to tell. */
  outline: (idea) => idea.done > 0,
  /** Chapters, every one of them agreed to. */
  elements: (outline) => outline.total > 0 && outline.done === outline.total,
  /** Elements, every one of them described and drawn. */
  storyboard: (elements) =>
    elements.total > 0 && elements.done === elements.total,
  /** An act with a clip the reader has settled on. */
  edit: (storyboard) => storyboard.done > 0,
};

/** Whether a step can be walked to yet. */
export function stepReachable(
  progress: Record<StoryStep, StoryStepProgress>,
  step: StoryStep,
): boolean {
  const index = STORY_STEPS.indexOf(step);
  if (index <= 0) return true;
  return STEP_OPENS_AFTER[step](progress[STORY_STEPS[index - 1]]);
}

/**
 * The frame a finished film is cut to, in pixels.
 *
 * The frame a story is told in is a proportion, and a proportion is not a size:
 * what a story asks its pictures for is a shape, while what the cutting room
 * exports is a size. This is the one place the two meet, so a story told in one
 * frame is not exported in another.
 */
export function timelineSizeForAspect(aspect: StoryAspect): {
  width: number;
  height: number;
} {
  switch (aspect) {
    case "9:16":
      return { width: 1080, height: 1920 };
    case "1:1":
      return { width: 1080, height: 1080 };
    case "4:3":
      return { width: 1440, height: 1080 };
    case "21:9":
      return { width: 2560, height: 1080 };
    default:
      return { width: 1920, height: 1080 };
  }
}

/** The shortest a premise may be and still be one. */
export const STORY_IDEA_MIN = 10;

/**
 * Whether step one has what the steps after it need.
 *
 * A premise of one line is not a premise — the outline it would be written
 * into has nothing to go on — and a manuscript is a premise of its own, since
 * the second step reads the text rather than the summary. The look and the
 * genre may be left empty; they are asked about again at every step that uses
 * them, and a story without them is drawn plainly rather than not drawn.
 */
export function ideaReady(story: StoryDocument): boolean {
  const written = story.brief.idea.trim().length >= STORY_IDEA_MIN;
  return written || story.brief.sourceAssetId !== undefined;
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

/**
 * What splitting a story again would overwrite, counted for the question that
 * is asked before it.
 *
 * A chapter keeps everything made for it as long as it stands where it stood,
 * so what a re-split costs is the words it replaces — every chapter that has a
 * synopsis — and the boards of the chapters the new telling has no room for.
 * Counting the acts that would go is why the count is asked for before the
 * split rather than after it.
 */
export function chapterRegenerationCost(
  story: StoryDocument,
  chapterCount: number = story.chapters.length,
): { chapters: number; acts: number } {
  const kept = Math.max(0, Math.min(chapterCount, story.chapters.length));
  return {
    chapters: story.chapters.filter((chapter) => chapter.synopsis.trim() !== "")
      .length,
    acts: story.chapters
      .slice(kept)
      .reduce((sum, chapter) => sum + chapter.acts.length, 0),
  };
}

/**
 * What boarding an episode again writes over.
 *
 * A board is written onto the acts in their places, so an act standing where
 * it stood keeps its frames and its clip — the words of the board are what a
 * new answer replaces. What the question is about is therefore the work that
 * would be left standing on nothing: acts the new board has no room for, and
 * the pictures and clips made for the shots inside them.
 */
export function actsRegenerationCost(chapter: StoryChapter): {
  acts: number;
  drawn: number;
  filmed: number;
} {
  return {
    acts: chapter.acts.length,
    drawn: chapter.acts.reduce(
      (sum, act) =>
        sum +
        act.keyframes.filter((keyframe) => keyframe.art.takes.length > 0)
          .length,
      0,
    ),
    filmed: chapter.acts.reduce(
      (sum, act) =>
        sum +
        (act.video.takes.length > 0 ? 1 : 0) +
        act.keyframes.filter((keyframe) => keyframe.video.takes.length > 0)
          .length,
      0,
    ),
  };
}

/**
 * A list cut into the waves a story's jobs are taken in.
 *
 * A batch may hold no more pieces than the story job client's limit allows, and
 * a telling may ask for more than that at once — sixty episodes of a
 * manuscript, eight episodes of boards at a time. The pieces are the same
 * pieces either way; what the waves decide is how many asks the telling is
 * made of, and a list that fits in one wave comes back as one.
 */
export function chunkWaves<T>(items: T[], per: number): T[][] {
  const width = Math.max(1, Math.floor(per));
  const waves: T[][] = [];
  for (let at = 0; at < items.length; at += width) {
    waves.push(items.slice(at, at + width));
  }
  return waves;
}
