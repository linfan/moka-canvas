import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import type {
  StoryAct,
  StoryDocument,
  StoryKeyframe,
} from "../../../shared/domain/types";

/**
 * A board written whole, which is how it is rearranged.
 *
 * Adding an act, moving one, taking one away: each is one write of the episode's
 * acts in the order the reader wants them, and one step of the history. A known
 * act keeps its frames and its clip through the write, since the command reads
 * the ids rather than the places.
 */
export function writeActs(
  story: StoryDocument,
  chapterId: string,
  acts: StoryAct[],
): void {
  execute(i18n.t("story:history.storyboard"), [
    { type: "setStoryActs", storyId: story.id, chapterId, acts },
  ]);
}

/** One act's shots, whole — how a shot is added to a board, moved, or taken off. */
export function writeKeyframes(
  story: StoryDocument,
  chapterId: string,
  act: StoryAct,
  keyframes: StoryKeyframe[],
): void {
  const chapter = story.chapters.find((held) => held.id === chapterId);
  writeActs(
    story,
    chapterId,
    (chapter?.acts ?? []).map((held) =>
      held.id === act.id ? { ...held, keyframes } : held,
    ),
  );
}

/** A list with one entry moved to another place in it. */
export function moved<T>(held: T[], from: number, to: number): T[] {
  const next = [...held];
  const [taken] = next.splice(from, 1);
  if (taken !== undefined) next.splice(to, 0, taken);
  return next;
}
