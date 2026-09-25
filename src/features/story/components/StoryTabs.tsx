import { useTranslation } from "react-i18next";
import {
  MAX_STORIES_PER_PROJECT,
  storyCurrentStep,
  storyProgress,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useStoryStore } from "../stores/storyStore";

/**
 * The stories this project tells, a tab each.
 *
 * All of them, in the order the document keeps them, as the cutting room's
 * strip shows every cut: a project tells a handful of stories and they are all
 * worth a tab, so the strip is the list itself and there is no second memory of
 * what is open to keep. Turning a tab over is what a tab does here; renaming a
 * story and taking it away stay in the column beside the room, where every row
 * also says how far the telling has got.
 */
export function StoryTabs() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeId = useStoryStore((state) => state.storyId);
  const stories = moka?.stories ?? [];
  const full = stories.length >= MAX_STORIES_PER_PROJECT;
  if (stories.length === 0) return null;

  return (
    <nav aria-label={t("story:tabs.list")} className="story-bar-tabs">
      {stories.map((story) => {
        const current = storyCurrentStep(storyProgress(story));
        const active = story.id === activeId;
        return (
          <span
            className={active ? "story-bar-tab is-active" : "story-bar-tab"}
            key={story.id}
          >
            <button
              data-testid={`story-tab-${story.name}`}
              onClick={() => useStoryStore.getState().select(story.id)}
              title={`${t(`story:step.${current.step}`)}${
                current.total > 1 ? ` · ${current.done}/${current.total}` : ""
              }`}
              type="button"
            >
              {story.name}
            </button>
          </span>
        );
      })}
      <button
        aria-label={t("story:tabs.add")}
        className="story-bar-tab-add"
        data-testid="story-tab-add"
        disabled={full}
        onClick={() => useStoryStore.getState().setNewStoryOpen(true)}
        title={
          full
            ? t("story:side.limit", { max: MAX_STORIES_PER_PROJECT })
            : t("story:tabs.addHint")
        }
        type="button"
      >
        +
      </button>
    </nav>
  );
}
