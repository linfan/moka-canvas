import { useAppStore } from "../stores/appStore";
import { useProjectStore } from "../stores/projectStore";
import { pickSavePath } from "./pickPath";
import { useSavePathStore, type SaveAsk } from "./savePathStore";

export type { SaveAsk };

/** A name that can be a file's: a cut, a canvas or a project is never a path. */
export function fileSafeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "-");
}

/**
 * Where a save is offered: the project's own output folder, with the name the
 * caller suggested inside it.
 *
 * The folder is made when a project is opened, so it is there to open a dialog
 * at; a window with no project open has nothing to suggest and offers the name
 * alone.
 */
export function suggestedSavePath(defaultName: string): string {
  const root = useProjectStore.getState().root;
  return root === null ? defaultName : `${root}/output/${defaultName}`;
}

/** The folder a save dialog opens at, when there is a project to open it in. */
export function outputFolder(): string | null {
  const root = useProjectStore.getState().root;
  return root === null ? null : `${root}/output`;
}

/**
 * Asks where a file should be saved, and answers the path or null.
 *
 * The desktop asks the operating system, which draws a save dialog of its own;
 * the web runtime asks the window, whose built-in dialog stands in for one.
 * Which one it is is a fact about this runtime, read once at boot — the same
 * split the launcher uses for choosing a project to open.
 */
export async function askSavePath(ask: SaveAsk): Promise<string | null> {
  const mode = useAppStore.getState().config?.capabilities.mode ?? "web";
  if (mode !== "tauri") return useSavePathStore.getState().ask(ask);
  return pickSavePath(
    ask.title,
    suggestedSavePath(ask.defaultName),
    ask.extensions,
  );
}
