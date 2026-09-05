import { useEffect, useRef, useState } from "react";
import { findNode } from "../../../shared/domain";
import { worldToClient } from "../canvas/canvasControl";
import { editTextContent } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

const NODE_HEADER_HEIGHT = 30;

/**
 * Body editor for text nodes: a textarea laid over the card body. Blur or
 * Cmd/Ctrl+Enter commits (undoable), Escape restores the pre-edit content.
 */
export function TextEditOverlay() {
  const textEditing = useEditorStore((state) => state.textEditing);
  const camera = useEditorStore((state) => state.camera);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  const node =
    textEditing && canvas ? findNode(canvas, textEditing.nodeId) : null;
  const nodeId = node?.id ?? null;

  useEffect(() => {
    if (nodeId && node) {
      setValue((node.data as { content?: string }).content ?? "");
      requestAnimationFrame(() => {
        areaRef.current?.focus();
        areaRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  if (!node || !textEditing) return null;
  const zoom = camera?.zoom ?? canvas?.viewport.zoom ?? 1;
  const origin = worldToClient({ x: node.bounds.x, y: node.bounds.y });

  const commit = () => {
    editTextContent(node.id, value);
    useEditorStore.getState().stopEditingText();
  };

  const style: React.CSSProperties = {
    left: (origin?.x ?? 0) + 14 * zoom,
    top: (origin?.y ?? 0) + (NODE_HEADER_HEIGHT + 12) * zoom,
    width: Math.max(80, (node.bounds.width - 28) * zoom),
    height: Math.max(40, (node.bounds.height - NODE_HEADER_HEIGHT - 20) * zoom),
    fontSize: Math.max(11, 12 * zoom),
  };

  return (
    <textarea
      aria-label={`Edit ${node.title}`}
      className="rename-overlay text-edit-overlay"
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          useEditorStore.getState().stopEditingText();
        }
      }}
      ref={areaRef}
      style={style}
      value={value}
    />
  );
}
