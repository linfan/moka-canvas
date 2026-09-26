import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  MAX_CANVAS_NAME_LENGTH,
  TIMELINE_NAME_MAX,
  type StoryDocument,
} from "../../../shared/domain";
import { useProjectStore } from "../../editor/stores/projectStore";
import { planAssembly } from "../assembly";
import { hasCanvasImport, importStoryToCanvas } from "../importCanvas";
import { importStoryToTimeline } from "../importTimeline";
import { ImportDialog } from "./ImportDialog";

/** Which room a telling is imported into. */
export type ImportTarget = "canvas" | "timeline";

/**
 * Taking the telling into the canvas or into the cutting room, from wherever it
 * has been worked on.
 *
 * The offer is one button and a question — what the thing being made is called.
 * Whether there is anything to import is read off the telling rather than
 * guessed at: a story whose steps have made nothing offers nothing, and says
 * why the button is dead rather than opening a question with no answer.
 */
export function StoryImportButton({
  story,
  target,
}: {
  story: StoryDocument;
  target: ImportTarget;
}) {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const [open, setOpen] = useState(false);
  const ready =
    target === "canvas"
      ? hasCanvasImport(story)
      : moka !== null && planAssembly(story, moka).units.length > 0;

  const run = (name: string): boolean => {
    const held = useProjectStore.getState().moka;
    if (held === null) return false;
    const made =
      target === "canvas"
        ? importStoryToCanvas(story, held, name)
        : importStoryToTimeline(story, held, name);
    return made !== null;
  };

  return (
    <>
      <button
        className="story-import"
        data-testid={`story-import-${target}`}
        disabled={!ready}
        onClick={() => setOpen(true)}
        title={ready ? undefined : t(`story:import.${target}.empty`)}
        type="button"
      >
        {t(`story:import.${target}.button`)}
      </button>
      {open && (
        <ImportDialog
          confirm={t(`story:import.${target}.title`)}
          defaultName={
            target === "canvas"
              ? story.name
              : t("story:import.timeline.name", { name: story.name })
          }
          hint={t(`story:import.${target}.hint`)}
          maxLength={
            target === "canvas" ? MAX_CANVAS_NAME_LENGTH : TIMELINE_NAME_MAX
          }
          onClose={() => setOpen(false)}
          onImport={run}
          testId={`story-import-${target}-dialog`}
          title={t(`story:import.${target}.title`)}
        />
      )}
    </>
  );
}
