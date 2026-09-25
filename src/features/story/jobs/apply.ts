/**
 * Writing a batch's answers into the story that asked for them.
 *
 * This is the one place a job's record meets the document. What it does is
 * planned first and applied once: every piece that answered is read into the
 * drafts a command takes, the drafts are merged with what the story already
 * holds, and the whole lot goes through the command pipeline as one step — so a
 * reader who does not like what came back undoes the batch, not twelve
 * drawings.
 *
 * Applying an answer twice is not two answers. A place that already keeps the
 * drawing is left as it is, a chapter that already has the words is written the
 * same words, and a batch whose answers are all already there plans no command
 * at all: nothing is pushed onto the history, and the reader is not offered an
 * undo of a step that changed nothing. That is what makes reading a job again
 * after a restart — or twice in one afternoon — safe.
 */

import { nowIso } from "../../../shared/domain/ids";
import type { DocumentCommand } from "../../../shared/domain/types";
import {
  mergeActs,
  mergeChapters,
  mergeElements,
  withTake,
  type ActDraft,
  type StoryChapterDraft,
  type StoryElementDraft,
} from "../../../shared/domain/story";
import {
  parseChapter,
  parseElements,
  parseOutline,
  parseStoryboard,
} from "../../../shared/domain/parse/story";
import { parseStoryJson } from "../../../shared/domain/parse/json";
import type {
  StoryDocument,
  StorySlot,
  StorySlotTarget,
  StoryTake,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import type { StoryJobItem, StoryJobRecord } from "../../../api/story";
import { jobKey } from "./plan";

/** What reading one batch's answers did to the story. */
export interface ApplyReport {
  /** Pieces whose answers were written into the document. */
  applied: number;
  /** Pieces that had nothing to write: still running, failed, or gone. */
  skipped: number;
  /** What could not be written, in the reader's language. */
  notes: string[];
}

/** The label one batch's answers go into the history under. */
function historyLabel(record: StoryJobRecord): string {
  return i18n.t(`story:history.apply.${record.kind}`);
}

/**
 * The story a batch was asked for, if the document still holds it.
 *
 * A story deleted while a batch was out is not an error and not a place to
 * write into: the pictures it drew are in the shelf, and the notes say the rest.
 */
function storyOf(record: StoryJobRecord): StoryDocument | undefined {
  const moka = useProjectStore.getState().moka;
  return (moka?.stories ?? []).find((story) => story.id === record.storyId);
}

/** The take a filed asset is kept as, named after the ask that drew it. */
function takeOf(record: StoryJobRecord, item: StoryJobItem): StoryTake {
  const line = item.prompt.split("\n")[0]?.trim() ?? "";
  return {
    assetId: item.assetIds?.[0] ?? "",
    jobId: record.id,
    itemId: item.id,
    ...(line === "" ? {} : { note: line.slice(0, 120) }),
    createdAt: nowIso(),
  };
}

function slotCommand(
  story: StoryDocument,
  target: StorySlotTarget,
  slot: StorySlot,
): DocumentCommand[] {
  return [{ type: "setStorySlot", storyId: story.id, target, slot }];
}

/** The slot a place holds, so a take can be added to it. */
function slotAt(
  story: StoryDocument,
  target: StorySlotTarget,
): StorySlot | undefined {
  switch (target.kind) {
    case "element": {
      const element = story.elements.find(
        (held) => held.id === target.elementId,
      );
      if (element === undefined) return undefined;
      return target.view === "main" ? element.main : element.turnaround;
    }
    case "keyframe": {
      const keyframe = story.chapters
        .find((chapter) => chapter.id === target.chapterId)
        ?.acts.find((act) => act.id === target.actId)
        ?.keyframes.find((held) => held.id === target.keyframeId);
      return keyframe?.art;
    }
    case "actVideo": {
      const act = story.chapters
        .find((chapter) => chapter.id === target.chapterId)
        ?.acts.find((held) => held.id === target.actId);
      return act?.video;
    }
    case "keyframeVideo": {
      const keyframe = story.chapters
        .find((chapter) => chapter.id === target.chapterId)
        ?.acts.find((act) => act.id === target.actId)
        ?.keyframes.find((held) => held.id === target.keyframeId);
      return keyframe?.video;
    }
  }
}

/** The place in the story a job target names, in the commands' own words. */
function slotTargetOf(item: StoryJobItem): StorySlotTarget | undefined {
  switch (item.target.kind) {
    case "elementArt":
      return {
        kind: "element",
        elementId: item.target.elementId,
        view: item.target.view,
      };
    case "keyframeArt":
      return {
        kind: "keyframe",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
        keyframeId: item.target.keyframeId,
      };
    case "actVideo":
      return {
        kind: "actVideo",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
      };
    case "keyframeVideo":
      return {
        kind: "keyframeVideo",
        chapterId: item.target.chapterId,
        actId: item.target.actId,
        keyframeId: item.target.keyframeId,
      };
    case "outline":
    case "elements":
    case "storyboard":
      return undefined;
  }
}

// -----------------------------------------------------------------------------
// The written steps
// -----------------------------------------------------------------------------

/**
 * The chapters a written answer holds, whether it answered in chapters or in
 * one chapter.
 *
 * The two shapes are the same ask at different sizes — a manuscript's part is
 * one chapter, a premise is all of them — and the batch does not have to say
 * which it was: what came back is what it is.
 */
function chaptersIn(item: StoryJobItem): StoryChapterDraft[] | undefined {
  const read = parseStoryJson(item.text ?? "");
  if (!read.ok) return undefined;
  const many = parseOutline(read.value);
  if (many.ok) return many.value;
  const one = parseChapter(read.value);
  return one.ok ? [one.value] : undefined;
}

export function applyParsedOutline(
  story: StoryDocument,
  drafts: StoryChapterDraft[],
): DocumentCommand[] {
  if (drafts.length === 0) return [];
  return [
    {
      type: "setStoryChapters",
      storyId: story.id,
      chapters: mergeChapters(story.chapters, drafts),
    },
  ];
}

export function applyParsedElements(
  story: StoryDocument,
  drafts: StoryElementDraft[],
): DocumentCommand[] {
  if (drafts.length === 0) return [];
  return [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: mergeElements(story.elements, drafts, story.chapters),
    },
  ];
}

export function applyParsedActs(
  story: StoryDocument,
  chapterId: string,
  drafts: ActDraft[],
): DocumentCommand[] {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  if (chapter === undefined || drafts.length === 0) return [];
  return [
    {
      type: "setStoryActs",
      storyId: story.id,
      chapterId,
      acts: mergeActs(chapter.acts, drafts),
    },
  ];
}

/** What one piece of a batch asks the document to do, if anything. */
function commandsFor(
  story: StoryDocument,
  record: StoryJobRecord,
  item: StoryJobItem,
  report: ApplyReport,
): DocumentCommand[] {
  const target = slotTargetOf(item);
  if (target !== undefined) {
    const assetId = item.assetIds?.[0];
    const slot = slotAt(story, target);
    if (assetId === undefined || slot === undefined) {
      report.skipped += 1;
      report.notes.push(
        i18n.t("story:jobs.targetGone", { label: jobKey(item.target) }),
      );
      return [];
    }
    if (slot.takes.some((held) => held.assetId === assetId)) {
      // The place already keeps this drawing: reading the answer again is not
      // another take, and the batch has nothing left to write for it.
      report.skipped += 1;
      return [];
    }
    report.applied += 1;
    return slotCommand(story, target, withTake(slot, takeOf(record, item)));
  }

  switch (item.target.kind) {
    case "outline": {
      const drafts = chaptersIn(item);
      if (drafts === undefined) {
        report.notes.push(
          i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
        );
        return [];
      }
      report.applied += 1;
      return applyParsedOutline(story, drafts);
    }
    case "elements": {
      const read = parseStoryJson(item.text ?? "");
      const parsed = read.ok ? parseElements(read.value) : undefined;
      if (parsed === undefined || !parsed.ok) {
        report.notes.push(
          i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
        );
        return [];
      }
      report.applied += 1;
      return applyParsedElements(story, parsed.value);
    }
    case "storyboard": {
      const { chapterId } = item.target;
      const read = parseStoryJson(item.text ?? "");
      const chapter = story.chapters.find((held) => held.id === chapterId);
      const parsed = read.ok
        ? parseStoryboard(read.value, {
            elements: story.elements,
            targetDurationMs: chapter?.targetDurationMs ?? 0,
          })
        : undefined;
      if (parsed === undefined || !parsed.ok || chapter === undefined) {
        report.notes.push(
          i18n.t("story:jobs.unreadableAnswer", { at: item.id }),
        );
        return [];
      }
      report.applied += 1;
      return applyParsedActs(story, chapter.id, parsed.value);
    }
    default:
      return [];
  }
}

/**
 * Writes a batch's answers into the story, and answers with what it wrote.
 *
 * Only pieces that succeeded are read: a piece that failed, was cancelled, or
 * is still going has nothing to write, and the room shows why where the piece
 * is rather than in here.
 */
export function applyJobResults(record: StoryJobRecord): ApplyReport {
  const story = storyOf(record);
  if (story === undefined) {
    return {
      applied: 0,
      skipped: record.items.length,
      notes: [i18n.t("story:jobs.storyGone")],
    };
  }

  const report: ApplyReport = { applied: 0, skipped: 0, notes: [] };
  const commands: DocumentCommand[] = [];
  for (const item of record.items) {
    if (item.status !== "succeeded") {
      report.skipped += 1;
      continue;
    }
    commands.push(...commandsFor(story, record, item, report));
  }

  if (commands.length === 0) return report;
  const applied = execute(historyLabel(record), commands);
  if (applied === null) {
    // The document refused the change, which is the save conflict saying so.
    return {
      applied: 0,
      skipped: record.items.length,
      notes: [...report.notes, i18n.t("story:page.saveConflict")],
    };
  }
  return report;
}
