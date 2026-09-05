import { useEditorStore } from "../stores/editorStore";
import { useActiveCanvas } from "../stores/projectStore";

export function InspectorPanel() {
  const selection = useEditorStore((state) => state.selection);
  const activeCanvas = useActiveCanvas();

  const selectedNodes = activeCanvas
    ? activeCanvas.nodes.filter((node) => selection.nodeIds.includes(node.id))
    : [];
  const selectedEdges = activeCanvas
    ? activeCanvas.edges.filter((edge) => selection.edgeIds.includes(edge.id))
    : [];

  return (
    <aside aria-label="Inspector" className="editor-inspector">
      <h2>Inspector</h2>
      {selectedNodes.length === 0 && selectedEdges.length === 0 ? (
        <p className="inspector-empty">Nothing selected</p>
      ) : (
        <ul className="inspector-list">
          {selectedNodes.map((node) => (
            <li key={node.id}>
              <strong>{node.title}</strong>
              <span>{node.kind}</span>
            </li>
          ))}
          {selectedEdges.map((edge) => (
            <li key={edge.id}>
              <strong>Edge</strong>
              <span>
                {edge.source.nodeId} → {edge.target.nodeId}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
