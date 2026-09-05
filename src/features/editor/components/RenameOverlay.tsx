import { useEffect, useRef, useState } from "react";
import { findNode } from "../../../shared/domain";
import { worldToClient } from "../canvas/canvasControl";
import { renameNode } from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

const TITLE_MAX_LENGTH = 80;

/**
 * Inline title editor over the node's canvas header. Keys are isolated from
 * the global map (editable target), Escape restores, Enter/blur commits.
 */
export function RenameOverlay() {
  const renaming = useEditorStore((state) => state.renaming);
  const camera = useEditorStore((state) => state.camera);
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  const canvas =
    moka?.canvas.find((entry) => entry.id === activeCanvasId) ??
    moka?.canvas[0] ??
    null;
  const node = renaming && canvas ? findNode(canvas, renaming.nodeId) : null;
  const nodeId = node?.id ?? null;

  useEffect(() => {
    if (nodeId && node) {
      setValue(node.title);
      // Focus after mount so the global Enter handler is already finished.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  if (!node || !renaming) return null;
  const zoom = camera?.zoom ?? canvas?.viewport.zoom ?? 1;
  const origin = worldToClient({ x: node.bounds.x, y: node.bounds.y });

  const commit = () => {
    renameNode(node.id, value);
    useEditorStore.getState().stopRenaming();
  };

  const style: React.CSSProperties = {
    left: (origin?.x ?? 0) + 14 * zoom,
    top: (origin?.y ?? 0) + 7 * zoom,
    width: Math.max(80, (node.bounds.width - 52) * zoom),
    fontSize: Math.max(11, 13 * zoom),
  };

  return (
    <input
      aria-label={`Rename ${node.title}`}
      className="rename-overlay"
      maxLength={TITLE_MAX_LENGTH}
      onBlur={commit}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          useEditorStore.getState().stopRenaming();
        }
      }}
      ref={inputRef}
      style={style}
      value={value}
    />
  );
}
