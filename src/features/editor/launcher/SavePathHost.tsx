import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { filesystemApi } from "../../../api";
import { PathBrowserDialog } from "./PathBrowserDialog";
import { outputFolder } from "./savePath";
import { useSavePathStore } from "./savePathStore";

/**
 * The window's own save dialog, drawn for the runtime that has no other one.
 *
 * Mounted once, beside the settings dialog and the toasts: a save can be asked
 * for by a room, by a panel, or by a plain function with no JSX to draw with,
 * and all of them are answered by the question this holds.
 *
 * It opens at the project's own output folder. A project opened before this
 * version made one is given it on the next open, and a folder that would not
 * open anyway falls back to the project root rather than to nothing.
 */
export function SavePathHost() {
  const { t } = useTranslation();
  const pending = useSavePathStore((state) => state.pending);
  // Where the listing opens, read once per question: the answer is about the
  // question that was standing when it was asked, not about one asked after it.
  const [start, setStart] = useState<string | null>(null);

  useEffect(() => {
    if (pending === null) {
      setStart(null);
      return;
    }
    const folder = outputFolder();
    let live = true;
    if (folder === null) {
      setStart("");
      return;
    }
    filesystemApi
      .list(folder)
      .then(() => {
        if (live) setStart(folder);
      })
      .catch(() => {
        if (live) setStart(folder.replace(/\/output$/, ""));
      });
    return () => {
      live = false;
    };
  }, [pending]);

  if (pending === null || start === null) return null;
  const reply = useSavePathStore.getState().reply;
  return (
    <PathBrowserDialog
      chooseLabel={t("app:browser.save")}
      extensions={pending.extensions}
      onChoose={reply}
      onClose={() => reply(null)}
      saveAs={pending.defaultName}
      start={start}
      title={pending.title}
    />
  );
}
