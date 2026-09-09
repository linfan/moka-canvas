import { useEffect } from "react";
import { findNode, generationCapabilityFor } from "../../../shared/domain";
import {
  activeCanvas,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  fitViewAction,
  groupSelection,
  pasteAt,
  selectAll,
  ungroupSelection,
} from "../interactions/actions";
import { useEditorStore } from "../stores/editorStore";
import { useClampedMenuPosition } from "./useClampedMenuPosition";

interface Item {
  label: string;
  disabled?: boolean;
  action: () => void;
}

/**
 * Right-click menu. Mirrors toolbar/shortcut actions only; opening it on a
 * node or edge selects that target first (handled by the canvas callback).
 */
export function ContextMenu() {
  const menu = useEditorStore((state) => state.contextMenu);
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
        useEditorStore.getState().closeContextMenu();
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, listRef]);

  if (!menu) return null;
  const editor = useEditorStore.getState();
  const canvas = activeCanvas();

  const items: Item[] = [];
  if (menu.target.kind === "node" || menu.target.kind === "port") {
    const targetId = menu.target.nodeId;
    const selectedCount = editor.selection.nodeIds.length;
    const targetNode = canvas ? findNode(canvas, targetId) : undefined;
    if (targetNode && generationCapabilityFor(targetNode.kind) !== null) {
      items.push({
        label: "Generate…",
        action: () => editor.openPromptPanel(targetId, true),
      });
    }
    items.push(
      { label: "Rename", action: () => editor.startRenaming(targetId) },
      { label: "Duplicate", action: () => void duplicateSelection() },
      { label: "Copy", action: () => void copySelection() },
      { label: "Cut", action: () => void cutSelection() },
      {
        label: "Group",
        disabled: selectedCount < 2,
        action: () => groupSelection(),
      },
      {
        label: "Ungroup",
        disabled: targetNode?.kind !== "group",
        action: () => ungroupSelection(),
      },
      { label: "Delete", action: () => deleteSelection() },
    );
  } else if (menu.target.kind === "edge") {
    items.push({ label: "Delete edge", action: () => deleteSelection() });
  } else {
    const world = menu.target.world;
    items.push(
      { label: "Paste here", action: () => void pasteAt(world) },
      { label: "Select all", action: () => selectAll() },
      { label: "Fit view", action: () => fitViewAction() },
      {
        label: "Add node",
        action: () => {
          editor.openNodeMenu({
            x: menu.x,
            y: menu.y,
            world,
            connectFrom: null,
          });
        },
      },
    );
  }

  const run = (item: Item) => {
    useEditorStore.getState().closeContextMenu();
    item.action();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = listRef.current?.querySelectorAll("button:not(:disabled)");
    if (!buttons || buttons.length === 0) return;
    const index = [...buttons].findIndex(
      (item) => item === document.activeElement,
    );
    if (event.key === "ArrowDown") {
      event.preventDefault();
      (buttons[(index + 1) % buttons.length] as HTMLElement).focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (
        buttons[(index - 1 + buttons.length) % buttons.length] as HTMLElement
      ).focus();
    }
  };

  return (
    <div
      aria-label="Context menu"
      className="menu context-menu"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <button
          disabled={item.disabled}
          key={item.label}
          onClick={() => run(item)}
          role="menuitem"
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
