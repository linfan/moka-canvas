import { useState, type FormEvent } from "react";
import type { SelfCheckReport } from "../../../shared/domain";
import { useProjectStore } from "../stores/projectStore";
import { pickDirectory, pickFile } from "./pickPath";

export type DialogMode = "create" | "open" | "import";

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
          <label className="dialog-field">
            <span>Folder</span>
            <div className="dialog-path">
              <input
                onChange={(event) => setDirectory(event.target.value)}
                placeholder="/Users/you/Movies/My project"
                value={directory}
              />
              {nativePickers && (
                <button
                  onClick={() =>
                    void pick(
                      () => pickDirectory("Choose project folder"),
                      setDirectory,
                    )
                  }
                  type="button"
                >
                  Browse…
                </button>
              )}
            </div>
          </label>
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
          <label className="dialog-field">
            <span>Project folder or .moka file</span>
            <div className="dialog-path">
              <input
                onChange={(event) => setPath(event.target.value)}
                placeholder="/Users/you/Movies/My project"
                value={path}
              />
              {nativePickers && (
                <button
                  onClick={() =>
                    void pick(() => pickFile("Open project", ["moka"]), setPath)
                  }
                  type="button"
                >
                  Browse…
                </button>
              )}
            </div>
          </label>
        )}

        {mode === "import" &&
          (nativePickers ? (
            <label className="dialog-field">
              <span>Package file</span>
              <div className="dialog-path">
                <input
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
            </label>
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
    </div>
  );
}
