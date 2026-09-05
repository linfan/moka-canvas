import type { AssetCategory } from "../../../shared/domain";
import { useProjectStore } from "../stores/projectStore";

const CATEGORY_LABELS: Record<string, string> = {
  images: "Images",
  music: "Music",
  voice: "Voice",
  texts: "Texts",
  videos: "Videos",
};

export function SidePanel() {
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  if (!moka) return null;

  return (
    <aside aria-label="Project" className="editor-side">
      <section>
        <h2>Canvases</h2>
        <ul className="side-canvas-list">
          {moka.canvas.map((canvas) => (
            <li key={canvas.id}>
              <button
                className={canvas.id === activeCanvasId ? "is-active" : ""}
                onClick={() =>
                  useProjectStore.getState().switchCanvas(canvas.id)
                }
                type="button"
              >
                <strong>{canvas.name}</strong>
                <span>
                  {canvas.nodes.length} nodes · {canvas.edges.length} edges
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Resources</h2>
        <ul className="side-resource-list">
          {(
            Object.entries(moka.resources) as [
              AssetCategory,
              { id: string }[],
            ][]
          ).map(([category, entries]) => (
            <li key={category}>
              <span>{CATEGORY_LABELS[category] ?? category}</span>
              <span>{entries.length}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
