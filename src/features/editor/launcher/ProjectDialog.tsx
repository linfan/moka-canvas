import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isApiError } from "../../../api/client";
import type { SelfCheckReport } from "../../../shared/domain";
import { useProjectStore } from "../stores/projectStore";
import { PathBrowserDialog } from "./PathBrowserDialog";
import { pickDirectory, pickFile } from "./pickPath";

export type DialogMode = "create" | "open" | "import";

/**
 * Which of the two paths a dialog is being asked about: the folder a project
 * goes in, or the project itself.
 */
type Field = "folder" | "project";

interface Props {
  mode: DialogMode;
  /** Native file dialogs are only available in the desktop runtime. */
  nativePickers: boolean;
  onClose: () => void;
  onDone: (selfCheck: SelfCheckReport) => void;
}

const TITLES: Record<DialogMode, string> = {
  create: "app:newProject",
  open: "app:openProject",
  import: "app:importProjectPackage",
};

export function ProjectDialog({ mode, nativePickers, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which field the application's own file dialog is choosing for, if one is. */
  const [browsing, setBrowsing] = useState<Field | null>(null);
  /** Whether the folder's question has been raised and the fields stepped aside. */
  const [confirmingSubfolder, setConfirmingSubfolder] = useState(false);

  /** Run a native picker and surface its failure instead of dropping it. */
  const pick = async (
    run: () => Promise<string | null>,
    apply: (picked: string) => void,
  ) => {
    setError(null);
    try {
      const picked = await run();
      if (picked) apply(picked);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("app:dialog.dialogFailed"),
      );
    }
  };

  /**
   * Asks which folder is meant.
   *
   * The operating system answers on a desktop, where it has a dialog of its own
   * to answer with. In a browser nothing can be asked, so the application draws
   * one out of the server's own listings rather than leaving a reader to type a
   * path they would have to know already.
   */
  const browse = (field: Field) => {
    if (!nativePickers) {
      setBrowsing(field);
      return;
    }
    void pick(
      field === "folder"
        ? () => pickDirectory(t("app:chooseProjectFolder"))
        : () => pickFile(t("app:openProject"), ["moka"]),
      field === "folder" ? setDirectory : setPath,
    );
  };

  /**
   * Makes the project. A folder that already holds something is refused by
   * the server until the reader has agreed to a subfolder of its own, and
   * that refusal is what puts the question on screen.
   */
  const submitCreate = async (useSubdirectory: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const selfCheck = await useProjectStore
        .getState()
        .create(directory.trim(), name.trim(), useSubdirectory);
      onDone(selfCheck);
    } catch (cause) {
      if (!useSubdirectory && isApiError(cause, "TARGET_DIRECTORY_NOT_EMPTY")) {
        setConfirmingSubfolder(true);
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : t("app:dialog.requestFailed"),
        );
      }
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "create") {
      await submitCreate(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const project = useProjectStore.getState();
      const selfCheck =
        mode === "open"
          ? await project.open(path.trim())
          : archive
            ? await project.importUpload(
                archive,
                directory.trim(),
                name.trim() || undefined,
              )
            : await project.importFromPath(
                path.trim(),
                directory.trim(),
                name.trim() || undefined,
              );
      onDone(selfCheck);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t("app:dialog.requestFailed"),
      );
      setBusy(false);
    }
  };

  const ready =
    !busy &&
    (mode === "open"
      ? path.trim().length > 0
      : mode === "create"
        ? directory.trim().length > 0 && name.trim().length > 0
        : directory.trim().length > 0 &&
          (archive !== null || path.trim().length > 0));

  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
      role="dialog"
    >
      <form className="dialog" onSubmit={(event) => void submit(event)}>
        <h2>{t(TITLES[mode])}</h2>

        {!confirmingSubfolder && mode !== "open" && (
          <div className="dialog-field">
            <span id="project-folder-label">{t("app:dialog.folder")}</span>
            <div className="dialog-path">
              <input
                aria-labelledby="project-folder-label"
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="/Users/you/Movies/My project"
                value={directory}
              />
              <button
                data-testid="browse-folder"
                onClick={() => browse("folder")}
                type="button"
              >
                {t("app:dialog.browse")}
              </button>
            </div>
          </div>
        )}

        {!confirmingSubfolder && mode !== "open" && (
          <label className="dialog-field">
            <span>
              {mode === "create"
                ? t("app:dialog.projectName")
                : t("app:dialog.nameOptional")}
            </span>
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder={
                mode === "create"
                  ? t("app:dialog.createNamePlaceholder")
                  : t("app:dialog.namePlaceholder")
              }
              value={name}
            />
          </label>
        )}

        {mode === "open" && (
          <div className="dialog-field">
            <span id="project-path-label">{t("app:dialog.projectPath")}</span>
            <div className="dialog-path">
              <input
                aria-labelledby="project-path-label"
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/you/Movies/My project"
                value={path}
              />
              <button
                data-testid="browse-project"
                onClick={() => browse("project")}
                type="button"
              >
                {t("app:dialog.browse")}
              </button>
            </div>
          </div>
        )}

        {mode === "import" &&
          (nativePickers ? (
            <div className="dialog-field">
              <span id="package-path-label">{t("app:dialog.packageFile")}</span>
              <div className="dialog-path">
                <input
                  aria-labelledby="package-path-label"
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="/Users/you/Downloads/launch-teaser.mokapkg.zip"
                  value={path}
                />
                <button
                  onClick={() =>
                    void pick(
                      () =>
                        pickFile(t("app:importProjectPackage"), [
                          "zip",
                          "mokapkg",
                        ]),
                      setPath,
                    )
                  }
                  type="button"
                >
                  {t("app:dialog.browse")}
                </button>
              </div>
            </div>
          ) : (
            <label className="dialog-field">
              <span>{t("app:dialog.packageFile")}</span>
              <input
                accept=".zip,.mokapkg,application/zip"
                onChange={(event) =>
                  setArchive(event.target.files?.[0] ?? null)
                }
                type="file"
              />
            </label>
          ))}

        {confirmingSubfolder && (
          <p className="dialog-note">{t("app:dialog.folderNotEmpty")}</p>
        )}

        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          {confirmingSubfolder ? (
            <>
              <button
                disabled={busy}
                onClick={() => setConfirmingSubfolder(false)}
                type="button"
              >
                {t("app:cancel")}
              </button>
              <button
                autoFocus
                className="primary"
                disabled={busy}
                onClick={() => void submitCreate(true)}
                type="button"
              >
                {busy ? t("app:dialog.working") : t("app:dialog.confirmCreate")}
              </button>
            </>
          ) : (
            <>
              <button disabled={busy} onClick={onClose} type="button">
                {t("app:cancel")}
              </button>
              <button disabled={!ready} type="submit">
                {busy ? t("app:dialog.working") : t(TITLES[mode])}
              </button>
            </>
          )}
        </div>
      </form>

      {/* Beside the form rather than inside it: a form within a form is not
          HTML, and the listing's own path bar submits. */}
      {browsing !== null && (
        <PathBrowserDialog
          chooseLabel={
            browsing === "folder" ? t("app:chooseFolder") : t("app:choose")
          }
          extensions={browsing === "folder" ? undefined : ["moka"]}
          onClose={() => setBrowsing(null)}
          onChoose={(chosen) => {
            if (browsing === "folder") setDirectory(chosen);
            else setPath(chosen);
            setBrowsing(null);
          }}
          start={browsing === "folder" ? directory : path}
          title={
            browsing === "folder"
              ? t("app:dialog.chooseFolderTitle")
              : t("app:dialog.openTitle")
          }
        />
      )}
    </div>
  );
}
