import { useTranslation } from "react-i18next";
import { PageTopBar } from "../../editor/panels/PageTopBar";
import { useStoryStore } from "../stores/storyStore";

interface StoryTopBarProps {
  /** Going home from the story room, which puts the project down first. */
  onHome: () => void;
}

/**
 * The story room's bar: the shared one, and no tabs in the middle.
 *
 * The column beside the room is already the list of stories, so a strip of
 * them across the bar would say the same thing twice in two places. What the
 * room is working on is named in the head of the stage instead, where the
 * settings it rests on are said beside it.
 */
export function StoryTopBar({ onHome }: StoryTopBarProps) {
  const { t } = useTranslation();
  return (
    <PageTopBar
      current="story"
      exportItems={
        <button
          data-testid="story-export-film"
          onClick={() => useStoryStore.getState().openExport()}
          role="menuitem"
          type="button"
        >
          {t("story:topBar.exportFilm")}
        </button>
      }
      onHome={onHome}
    />
  );
}
