import { useTranslation } from "react-i18next";
import type { Capability } from "../../../shared/domain";
import { ModelPicker } from "../../settings/ModelPicker";
import {
  STORY_ASK_PLACES,
  useStoryModels,
  type StoryAskPlace,
} from "../stores/storyModels";

/**
 * Which capability a place is asked of.
 *
 * A score is composed by an audio model — the same capability as the voice,
 * and a different model in a deployment that keeps both — so the score's
 * picker offers audio models under the name of what they make here.
 */
const CAPABILITY_OF_PLACE: Record<StoryAskPlace, Capability> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
  music: "audio",
};

/**
 * The models the buttons below will ask.
 *
 * One picker per kind of work the step does, standing between the words that
 * say what the step is for and the buttons that ask for it: which model answers
 * is settled before the ask rather than discovered after it. Nothing picked is
 * the deployment's default, and the pickers are kept per place — a telling's
 * score is not its voice, even when one model does both.
 */
export function StoryModelPicks({ places }: { places: StoryAskPlace[] }) {
  const { t } = useTranslation();
  const choices = useStoryModels((state) => state.choices);

  return (
    <div
      aria-label={t("story:models.label")}
      className="story-models"
      data-testid="story-models"
      role="group"
    >
      <span className="story-hint">{t("story:models.label")}</span>
      {STORY_ASK_PLACES.filter((place) => places.includes(place)).map(
        (place) => (
          <div
            className="story-model"
            data-testid={`story-model-${place}`}
            key={place}
          >
            <ModelPicker
              capability={CAPABILITY_OF_PLACE[place]}
              label={t(`story:models.${place}`)}
              noneLabel={
                place === "music"
                  ? t("story:models.musicDefault")
                  : t("story:models.default")
              }
              onChange={(reference) =>
                useStoryModels.getState().choose(place, reference)
              }
              value={choices[place] ?? null}
            />
          </div>
        ),
      )}
    </div>
  );
}
