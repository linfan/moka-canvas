import { create } from "zustand";
import type { MokaFile, StoryDocument } from "../../../shared/domain";
import {
  STORY_STEPS,
  stepReachable,
  storyCurrentStep,
  storyProgress,
  type StoryStep,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";

/**
 * Where a reader is standing in a story: which one is open and which step of
 * it, and which of its cards are unfolded.
 *
 * None of this is the document's business. Which story is being looked at is a
 * place on this machine, remembered beside the other choices about how the app
 * is used, and everything that changes the telling itself goes through the
 * command pipeline instead.
 */
interface StoryState {
  storyId: string | null;
  step: StoryStep;
  /** Which episode step four has open; null is the first of them. */
  openChapterId: string | null;
  /** The cards unfolded in steps three and four, by element or act id. */
  expanded: string[];
  exportOpen: boolean;
  /** Whether the question a new story is opened under is standing. */
  newStoryOpen: boolean;
  /** Takes up the place a project's stories leave open. */
  adopt: (moka: MokaFile | null) => void;
  select: (storyId: string | null) => void;
  goStep: (step: StoryStep) => void;
  openChapter: (chapterId: string | null) => void;
  toggleExpanded: (id: string) => void;
  openExport: () => void;
  setExportOpen: (open: boolean) => void;
  setNewStoryOpen: (open: boolean) => void;
  /** Everything the room was holding, when the project is put down. */
  forget: () => void;
}

/** Kept on this machine, a place per project, beside the locale choice. */
const STORED_UNDER = "moka-canvas:story-place:";

interface StoredPlace {
  storyId?: unknown;
  step?: unknown;
}

/** The place this machine remembers for a project, which may be nowhere. */
export function rememberedPlace(projectId: string):
  | {
      storyId: string | null;
      /** Absent when what was kept is not one of the five steps. */
      step?: StoryStep;
    }
  | undefined {
  // Tests that do not ask for a DOM have no store to read, and want the start.
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(STORED_UNDER + projectId);
    if (!raw) return undefined;
    const kept = JSON.parse(raw) as StoredPlace;
    const step = STORY_STEPS.find((each) => each === kept.step);
    return {
      storyId: typeof kept.storyId === "string" ? kept.storyId : null,
      ...(step ? { step } : {}),
    };
  } catch {
    // A store this cannot read is one that has nothing in it.
    return undefined;
  }
}

function rememberPlace(
  projectId: string | null,
  place: { storyId: string | null; step: StoryStep },
): void {
  if (projectId === null || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      STORED_UNDER + projectId,
      JSON.stringify({ storyId: place.storyId, step: place.step }),
    );
  } catch {
    // A store that will not take it costs the remembering, not the choice.
  }
}

/**
 * Where a reader stepping into the room is put: the step they were standing
 * on, as long as the story can still be stood on it, and otherwise the work
 * that is wanted next rather than the first thing that was ever done.
 *
 * A step the story has outgrown is not a door to stand in front of — a board
 * that was undone takes the reader back to the outline it was written from.
 */
function placeFor(
  story: StoryDocument | null,
  remembered: StoryStep | undefined,
): StoryStep {
  if (!story) return "idea";
  const progress = storyProgress(story);
  if (remembered !== undefined && stepReachable(progress, remembered)) {
    return remembered;
  }
  return storyCurrentStep(progress).step;
}

export const useStoryStore = create<StoryState>()((set, get) => ({
  storyId: null,
  step: "idea",
  openChapterId: null,
  expanded: [],
  exportOpen: false,
  newStoryOpen: false,

  adopt(moka) {
    const stories = moka?.stories ?? [];
    const projectId = moka?.metadata.id ?? null;
    const held = get();
    const remembered = projectId ? rememberedPlace(projectId) : undefined;
    const wanted = held.storyId ?? remembered?.storyId ?? null;
    const found = stories.find((story) => story.id === wanted) ?? null;
    const storyId = found ? found.id : (stories[0]?.id ?? null);
    const story = found ?? stories.find((each) => each.id === storyId) ?? null;
    // A story that is no longer in the document — deleted here, or by an undo
    // — is not what the room can be looking at; the step, though, is where the
    // reader left it until the story it belonged to says otherwise.
    const step =
      held.storyId === storyId ? held.step : placeFor(story, remembered?.step);
    const openChapterId =
      story?.chapters.some((chapter) => chapter.id === held.openChapterId) ===
      true
        ? held.openChapterId
        : null;
    set({ storyId, step, openChapterId });
    rememberPlace(projectId, { storyId, step });
  },

  select(storyId) {
    const moka = useProjectStore.getState().moka;
    const story =
      (moka?.stories ?? []).find((each) => each.id === storyId) ?? null;
    // A story just chosen is opened where its work stands, not where some
    // other story's reader left off.
    const step = placeFor(story, undefined);
    set({
      storyId,
      step,
      openChapterId: story?.chapters[0]?.id ?? null,
      expanded: [],
      exportOpen: false,
    });
    rememberPlace(moka?.metadata.id ?? null, { storyId, step });
  },

  goStep(step) {
    set({ step });
    rememberPlace(useProjectStore.getState().moka?.metadata.id ?? null, {
      storyId: get().storyId,
      step,
    });
  },

  openChapter(chapterId) {
    set({ openChapterId: chapterId });
  },

  toggleExpanded(id) {
    const expanded = get().expanded;
    set({
      expanded: expanded.includes(id)
        ? expanded.filter((each) => each !== id)
        : [...expanded, id],
    });
  },

  openExport() {
    set({ exportOpen: true, step: "edit" });
    rememberPlace(useProjectStore.getState().moka?.metadata.id ?? null, {
      storyId: get().storyId,
      step: "edit",
    });
  },

  setExportOpen(exportOpen) {
    set({ exportOpen });
  },

  setNewStoryOpen(newStoryOpen) {
    set({ newStoryOpen });
  },

  forget() {
    set({
      storyId: null,
      step: "idea",
      openChapterId: null,
      expanded: [],
      exportOpen: false,
      newStoryOpen: false,
    });
  },
}));

/** The story the room is open on, or null when it is open on none. */
export function useActiveStory(): StoryDocument | null {
  const id = useStoryStore((state) => state.storyId);
  const moka = useProjectStore((state) => state.moka);
  if (id === null) return null;
  return (moka?.stories ?? []).find((story) => story.id === id) ?? null;
}
