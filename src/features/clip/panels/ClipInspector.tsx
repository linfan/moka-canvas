import { PanelFold } from "../../editor/components/PanelFold";
import { SelectIcon } from "../components/ClipIcons";

/**
 * The column on the right of the cutting room.
 *
 * What is chosen on the timeline is read and changed here. Nothing is chosen
 * yet and the properties arrive with package 09, so the column says what it is
 * for rather than showing fields that would edit nothing.
 */
export function ClipInspector() {
  return (
    <aside
      aria-label="Inspector"
      className="clip-inspector"
      id="clip-panel-right"
    >
      <PanelFold side="right" />
      <div className="clip-empty clip-empty-inspector">
        <SelectIcon size={26} />
        <p>Select a timeline item to edit its properties</p>
      </div>
    </aside>
  );
}
