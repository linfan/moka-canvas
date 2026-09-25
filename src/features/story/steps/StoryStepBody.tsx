import { useTranslation } from "react-i18next";
import type { StoryDocument, StoryStep } from "../../../shared/domain";
import { ElementsStep } from "./ElementsStep";
import { IdeaStep } from "./IdeaStep";
import { OutlineStep } from "./OutlineStep";

/**
 * What is standing in the middle of the room: the step the reader picked.
 *
 * Each step is drawn by a component of its own, so the room's shell does not
 * have to know what an outline or a board is made of — and so that a board
 * being edited does not re-render the elements beside it. A step that has not
 * been built yet says what it will be rather than standing empty.
 */
export function StoryStepBody({
  step,
  story,
}: {
  step: StoryStep;
  story: StoryDocument;
}) {
  if (step === "idea") return <IdeaStep story={story} />;
  if (step === "outline") return <OutlineStep story={story} />;
  if (step === "elements") return <ElementsStep story={story} />;
  return <StepWaiting step={step} story={story} />;
}

function StepWaiting({
  step,
  story,
}: {
  step: StoryStep;
  story: StoryDocument;
}) {
  const { t } = useTranslation();
  return (
    <div className="story-step-scroll" data-testid={`story-step-${step}-body`}>
      <div
        className="clip-empty clip-empty-first"
        data-testid={`story-step-waiting-${step}`}
      >
        <h2>{t(`story:step.${step}`)}</h2>
        <p>{t(`story:stepHint.${step}`)}</p>
        <p className="story-step-note" data-story-id={story.id}>
          {t("story:page.stepComing")}
        </p>
      </div>
    </div>
  );
}
