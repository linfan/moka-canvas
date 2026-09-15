import { PageTopBar } from "../../editor/panels/PageTopBar";
import { TimelineTabs } from "./TimelineTabs";

interface ClipTopBarProps {
  /** Going home from the cutting room, which puts the project down first. */
  onHome: () => void;
}

/**
 * The cutting room's bar: the shared one, with the timeline tabs where the
 * board tabs stand and one export under the button.
 *
 * Video export runs on the backend's ffmpeg and the pipeline to it is not here
 * yet, so the item is offered and says why it cannot be chosen rather than
 * being left out: a reader looking for it learns where it will be, and package
 * 12 turns the disabled row into the real dialog.
 */
export function ClipTopBar({ onHome }: ClipTopBarProps) {
  return (
    <PageTopBar
      current="clip"
      exportItems={
        <button
          disabled
          role="menuitem"
          title="Video export runs through the backend's ffmpeg — not available until that pipeline arrives"
          type="button"
        >
          Export video…
        </button>
      }
      onHome={onHome}
      tabs={<TimelineTabs />}
    />
  );
}
