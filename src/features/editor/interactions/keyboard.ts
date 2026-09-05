import { useEffect } from "react";
import { redo, undo } from "../commands/execute";
import { cancelGesture, zoomBy, zoomReset } from "../canvas/canvasControl";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import {
  activeCanvas,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  fitSelectionAction,
  fitViewAction,
  groupSelection,
  pasteAt,
  selectAll,
  ungroupSelection,
} from "./actions";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Global editor keyboard map. Both Cmd and Ctrl are accepted so automated
 * tests and either platform work; display labels use the platform modifier.
 */
export function useEditorKeyboard() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const editor = useEditorStore.getState();
      const project = useProjectStore.getState();
      if (!project.moka) return;
      if (editor.assetDeletePrompt || editor.previewAssetId) return;
      if (isEditableTarget(event.target)) return;

      const mod = event.metaKey || event.ctrlKey;

      // Temporary tool inversion while held. Ctrl alone inverts select→pan;
      // with Cmd held Ctrl keydowns are modifier noise, so gate on key.
      if (event.key === " " && !mod && !event.repeat) {
        editor.setTemporaryTool("pan");
        event.preventDefault();
        return;
      }
      if (event.key === "Control" && !event.metaKey && !event.repeat) {
        editor.setTemporaryTool("pan");
        return;
      }

      if (event.key === "Escape") {
        if (editor.nodeMenu) {
          editor.closeNodeMenu();
        } else if (editor.contextMenu) {
          editor.closeContextMenu();
        } else if (editor.renaming) {
          editor.stopRenaming();
        } else if (editor.textEditing) {
          editor.stopEditingText();
        } else if (editor.inputPick) {
          editor.stopInputPick();
        } else if (editor.gesture.kind !== "idle") {
          cancelGesture();
        } else {
          editor.clearSelection();
          editor.announce("Nothing selected");
        }
        return;
      }

      if (mod) {
        const key = event.key.toLowerCase();
        if (key === "z" && event.shiftKey) {
          event.preventDefault();
          redo();
        } else if (key === "z") {
          event.preventDefault();
          undo();
        } else if (key === "y") {
          event.preventDefault();
          redo();
        } else if (key === "a") {
          event.preventDefault();
          selectAll();
        } else if (key === "c") {
          event.preventDefault();
          void copySelection();
        } else if (key === "x") {
          event.preventDefault();
          void cutSelection();
        } else if (key === "v") {
          event.preventDefault();
          void pasteAt();
        } else if (key === "d") {
          event.preventDefault();
          void duplicateSelection();
        } else if (key === "g" && event.shiftKey) {
          event.preventDefault();
          ungroupSelection();
        } else if (key === "g") {
          event.preventDefault();
          groupSelection();
        } else if (key === "=" || key === "+") {
          event.preventDefault();
          zoomBy(1.2);
        } else if (key === "-") {
          event.preventDefault();
          zoomBy(1 / 1.2);
        } else if (key === "0") {
          event.preventDefault();
          zoomReset();
        } else if (key === "1" && event.shiftKey) {
          event.preventDefault();
          fitSelectionAction();
        } else if (key === "1") {
          event.preventDefault();
          fitViewAction();
        }
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
        return;
      }

      if (event.key === "Enter") {
        const selection = editor.selection;
        if (selection.nodeIds.length === 1) {
          const nodeId = selection.nodeIds[0];
          const canvas = activeCanvas();
          const node = canvas?.nodes.find((entry) => entry.id === nodeId);
          if (node?.kind === "text") {
            editor.startEditingText(nodeId);
          } else {
            editor.startRenaming(nodeId);
          }
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "v" && !event.repeat) editor.setTool("select");
      if (key === "h" && !event.repeat) editor.setTool("pan");
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Control") {
        useEditorStore.getState().setTemporaryTool(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
}

/** Uses the active canvas; exported for menu/shortcut parity tests. */
export { activeCanvas };
