import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { StoryStep } from "../../../shared/domain";

/**
 * A step's name, with whatever acts on the whole step beside it.
 *
 * The name comes from the step's own key, so a step renamed in one language is
 * renamed wherever it is read; the action is the caller's and stands at the far
 * end of the row, where a thing that acts on the whole step belongs rather than
 * among the controls of one of its parts.
 */
export function StepHeading({
  step,
  action,
}: {
  step: StoryStep;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="story-step-heading">
      <h2>{t(`story:step.${step}`)}</h2>
      {action}
    </div>
  );
}
