import { exportCanvasImage } from "../interactions/actions";
import { useActiveCanvas } from "../stores/projectStore";
import { CanvasTabs } from "./CanvasTabs";
import { PageTopBar } from "./PageTopBar";

interface TopBarProps {
  onBack: () => void;
  /** Opens the export question; the dialog itself belongs to the page. */
  onExport: () => void;
}

/**
 * The canvas page's bar: the shared one with the board strip and the two
 * exports this page offers.
 *
 * The strips and the exports are arguments rather than neighbours so the bar
 * itself stays one thing: the cutting room stands under the same bar with a
 * strip of its own and one export, and neither page has to know how the other
 * is arranged.
 */
export function TopBar({ onBack, onExport }: TopBarProps) {
  const canvasDoc = useActiveCanvas();

  return (
    <PageTopBar
      current="canvas"
      onHome={onBack}
      exportItems={
        <>
          <button
            onClick={onExport}
            role="menuitem"
            title="Choose what leaves with the project, and where to"
            type="button"
          >
            Export project
          </button>
          <button
            disabled={!canvasDoc || canvasDoc.nodes.length === 0}
            onClick={() => void exportCanvasImage()}
            role="menuitem"
            title="Save the canvas as a PNG image"
            type="button"
          >
            Export as image
          </button>
        </>
      }
      tabs={<CanvasTabs />}
    />
  );
}
