import { useState, type FormEvent } from "react";
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
  create: "New project",
  open: "Open project",
  import: "Import project package",
};

export function ProjectDialog({ mode, nativePickers, onClose, onDone }: Props) {
  const [directory, setDirectory] = useState("");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which field the application's own file dialog is choosing for, if one is. */
  const [browsing, setBrowsing] = useState<Field | null>(null);

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
        cause instanceof Error
          ? cause.message
          : "The file dialog could not open",
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
        ? () => pickDirectory("Choose project folder")
        : () => pickFile("Open project", ["moka"]),
      field === "folder" ? setDirectory : setPath,
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const project = useProjectStore.getState();
      const selfCheck =
        mode === "create"
          ? await project.create(directory.trim(), name.trim())
          : mode === "open"
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
      setError(cause instanceof Error ? cause.message : "Request failed");
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
        <h2>{TITLES[mode]}</h2>

        {mode !== "open" && (
          <div className="dialog-field">
            <span id="project-folder-label">Folder</span>
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
                Browse…
              </button>
            </div>
          </div>
        )}

        {mode !== "open" && (
          <label className="dialog-field">
            <span>
              {mode === "create" ? "Project name" : "Name (optional)"}
            </span>
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder={
                mode === "create" ? "Launch teaser" : "Derived from the package"
              }
              value={name}
            />
          </label>
        )}

        {mode === "open" && (
          <div className="dialog-field">
            <span id="project-path-label">Project folder or .moka file</span>
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
                Browse…
              </button>
            </div>
          </div>
        )}

        {mode === "import" &&
          (nativePickers ? (
            <div className="dialog-field">
              <span id="package-path-label">Package file</span>
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
                        pickFile("Import project package", ["zip", "mokapkg"]),
                      setPath,
                    )
                  }
                  type="button"
                >
                  Browse…
                </button>
              </div>
            </div>
          ) : (
            <label className="dialog-field">
              <span>Package file</span>
              <input
                accept=".zip,.mokapkg,application/zip"
                onChange={(event) =>
                  setArchive(event.target.files?.[0] ?? null)
                }
                type="file"
              />
            </label>
          ))}

        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button disabled={busy} onClick={onClose} type="button">
            Cancel
          </button>
          <button disabled={!ready} type="submit">
            {busy ? "Working…" : TITLES[mode]}
          </button>
        </div>
      </form>

      {/* Beside the form rather than inside it: a form within a form is not
          HTML, and the listing's own path bar submits. */}
      {browsing !== null && (
        <PathBrowserDialog
          chooseLabel={browsing === "folder" ? "Choose folder" : "Open"}
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
              ? "Choose a folder for the project"
              : "Open a project"
          }
        />
      )}
    </div>
  );
}
