import { newId, type DocumentCommand } from "../../../shared/domain";
import { i18n } from "../../../shared/i18n";
import { useAppStore } from "../stores/appStore";
import { useHistoryStore, type HistoryEntry } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";

function toastError(message: string) {
  useAppStore.getState().pushToast("error", message);
}

/**
 * Applies commands optimistically and records them for undo.
 * Returns the inverse commands, or null when the change was rejected.
 */
export function execute(
  label: string,
  commands: DocumentCommand[],
): DocumentCommand[] | null {
  if (commands.length === 0) return [];
  try {
    const inverse = useProjectStore.getState().applyLocal(commands);
    useHistoryStore.getState().record({
      id: newId(),
      label,
      forwardCommands: commands,
      inverseCommands: inverse,
    });
    return inverse;
  } catch (error) {
    toastError(
      error instanceof Error
        ? error.message
        : i18n.t("editor:stores.changeRejected"),
    );
    return null;
  }
}

export function undo(): boolean {
  const history = useHistoryStore.getState();
  const entry = history.takeUndo();
  if (!entry) return false;
  try {
    useProjectStore.getState().applyLocal(entry.inverseCommands);
    history.pushRedo(entry);
    return true;
  } catch (error) {
    history.restoreUndo(entry);
    toastError(
      error instanceof Error
        ? error.message
        : i18n.t("editor:stores.undoFailed"),
    );
    return false;
  }
}

export function redo(): boolean {
  const history = useHistoryStore.getState();
  const entry = history.takeRedo();
  if (!entry) return false;
  try {
    useProjectStore.getState().applyLocal(entry.forwardCommands);
    // restoreUndo appends without clearing the redo stack, which a
    // successful redo requires.
    history.restoreUndo(entry);
    return true;
  } catch (error) {
    history.pushRedo(entry);
    toastError(
      error instanceof Error
        ? error.message
        : i18n.t("editor:stores.redoFailed"),
    );
    return false;
  }
}

export function historyBoundary(label: string) {
  useHistoryStore.getState().pushBoundary(label);
}

export type { HistoryEntry };
