import { open, save } from "@tauri-apps/plugin-dialog";

/** Native pickers; only call when the runtime mode is "tauri". */
export async function pickDirectory(title: string): Promise<string | null> {
  const selected = await open({ title, directory: true });
  return typeof selected === "string" ? selected : null;
}

export async function pickFile(
  title: string,
  extensions: string[],
): Promise<string | null> {
  const selected = await open({
    title,
    filters: [{ name: title, extensions }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * The operating system's own save dialog, answering the path a file is to be
 * written to — or null when the reader backed out of it.
 */
export async function pickSavePath(
  title: string,
  defaultPath: string,
  extensions: string[],
): Promise<string | null> {
  const selected = await save({
    title,
    defaultPath,
    filters: [{ name: title, extensions }],
  });
  return typeof selected === "string" ? selected : null;
}
