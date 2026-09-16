import { useTranslation } from "react-i18next";
import { PageTopBar } from "../../editor/panels/PageTopBar";
import { useExportStore } from "../stores/exportStore";
import { TimelineTabs } from "./TimelineTabs";

interface ClipTopBarProps {
  /** Going home from the cutting room, which puts the project down first. */
  onHome: () => void;
}

/**
 * The cutting room's bar: the shared one, with the timeline tabs where the
 * board tabs stand and two exports under the button.
 *
 * "Export video…" renders the cut through the machine's own ffmpeg and files
 * the file into the project; "Export project" packs the whole project up and
 * belongs to the editor's own export. The first opens the dialog whether or
 * not a renderer was found — a machine without one is told so in the dialog,
 * rather than being left to guess why the item does nothing.
 */
export function ClipTopBar({ onHome }: ClipTopBarProps) {
  const { t } = useTranslation();
  return (
    <PageTopBar
      current="clip"
      exportItems={
        <button
          onClick={() => useExportStore.getState().setOpen(true)}
          role="menuitem"
          type="button"
        >
          {t("clip:topBar.exportVideo")}
        </button>
      }
      onHome={onHome}
      tabs={<TimelineTabs />}
    />
  );
}
