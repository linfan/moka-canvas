import { useEffect } from "react";
import type { NodeKind } from "../../../shared/domain";
import {
  addNodeAt,
  kindAcceptsConnection,
  activeCanvas,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useClampedMenuPosition } from "./useClampedMenuPosition";

const KINDS: { kind: NodeKind; label: string }[] = [
  { kind: "text", label: "Text" },
  { kind: "image", label: "Image" },
  { kind: "audio", label: "Audio" },
  { kind: "video", label: "Video" },
  { kind: "operation", label: "Operation" },
  { kind: "group", label: "Group" },
  { kind: "export", label: "Export" },
];

/**
 * Quick-add menu: double-click on blank canvas, or the tail of a connection
 * dropped on blank space (then only compatible kinds are enabled).
 */
export function NodeMenu() {
  const menu = useEditorStore((state) => state.nodeMenu);
  const { ref: listRef, pos } = useClampedMenuPosition(
    menu?.x ?? 0,
    menu?.y ?? 0,
  );

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (
        listRef.current &&
        event.target instanceof Node &&
        !listRef.current.contains(event.target)
      ) {
        useEditorStore.getState().closeNodeMenu();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, listRef]);

  if (!menu) return null;
  const canvas = activeCanvas();

  const pick = (kind: NodeKind) => {
    useEditorStore.getState().closeNodeMenu();
    addNodeAt(menu.world, kind, menu.connectFrom);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const items = listRef.current?.querySelectorAll("button:not(:disabled)");
    if (!items || items.length === 0) return;
    const index = [...items].findIndex(
      (item) => item === document.activeElement,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[(index + 1) % items.length] as HTMLElement).focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[(index - 1 + items.length) % items.length] as HTMLElement).focus();
    }
  };

  return (
    <div
      aria-label="Add node"
      className="menu node-menu"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {menu.connectFrom && <p className="menu-title">Connect to new node</p>}
      {KINDS.map(({ kind, label }) => {
        const disabled =
          menu.connectFrom !== null &&
          canvas !== null &&
          !kindAcceptsConnection(canvas, menu.connectFrom, kind);
        return (
          <button
            disabled={disabled}
            key={kind}
            onClick={() => pick(kind)}
            role="menuitem"
            type="button"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
