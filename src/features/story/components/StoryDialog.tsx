import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  STORY_NAME_MAX,
  createStory,
  nextStoryName,
} from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useStoryStore } from "../stores/storyStore";

/**
 * The question a new story is opened under: what it is called.
 *
 * Nothing else is asked here. The premise, the running time, the frame, and
 * the look are all set in the first step of the room, where the story they
 * belong to is standing in front of the reader — asking them again here would
 * be asking the same questions twice.
 */
export function StoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [name, setName] = useState(() =>
    moka ? nextStoryName(moka) : t("story:dialog.defaultName", { n: 1 }),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const story = createStory(trimmed);
    // A command the document refuses — the story limit, a conflict — toasts
    // its reason and leaves the dialog standing, since the ask is still the
    // reader's and throwing it away would be losing their words for them.
    const done = execute(t("story:history.create"), [
      { type: "addStory", story },
    ]);
    if (!done) return;
    useStoryStore.getState().select(story.id);
    useStoryStore.getState().goStep("idea");
    onClose();
  };

  return (
    <div
      aria-label={t("story:dialog.newTitle")}
      aria-modal="true"
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <form className="dialog" onSubmit={submit}>
        <h2>{t("story:dialog.newTitle")}</h2>
        <label className="dialog-field">
          <span>{t("story:dialog.name")}</span>
          <input
            autoFocus
            data-testid="story-name"
            maxLength={STORY_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            {t("story:dialog.cancel")}
          </button>
          <button
            className="primary"
            data-testid="story-create"
            disabled={name.trim().length === 0}
            type="submit"
          >
            {t("story:dialog.create")}
          </button>
        </div>
      </form>
    </div>
  );
}
