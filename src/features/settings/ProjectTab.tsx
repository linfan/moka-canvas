import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_PROJECT_NAME_LENGTH } from "../../shared/domain";
import { execute } from "../editor/commands/execute";
import { useProjectStore } from "../editor/stores/projectStore";

/**
 * What the project is called and what it is about.
 *
 * Both are written when either field is left, which is how the room's
 * inspector edits a timeline's own name: a form that waited for a Save button
 * would stand beside the dialog's Done as a second way out, and the two would
 * disagree about the half-written field left between them.
 *
 * A name has to say something — the command asks the same, and either refusal
 * is told beside the field rather than thrown away with the words. The change
 * goes through the command pipeline like every other one, so it reaches the
 * document, the save badge, and the undo stack the same way a rename of a
 * timeline does, and a reader with no project open is told so plainly.
 */
export function ProjectTab() {
  const { t } = useTranslation();
  const metadata = useProjectStore((state) => state.moka?.metadata ?? null);
  const [name, setName] = useState(metadata?.name ?? "");
  const [description, setDescription] = useState(metadata?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const nameFocused = useRef(false);
  const descriptionFocused = useRef(false);

  // The document is what the fields show, except for the field being written
  // in: an undo, or a write from somewhere else, moves them with it.
  useEffect(() => {
    if (!nameFocused.current) setName(metadata?.name ?? "");
    if (!descriptionFocused.current) {
      setDescription(metadata?.description ?? "");
    }
  }, [metadata?.name, metadata?.description]);

  if (!metadata) {
    return <p className="settings-hint">{t("settings:project.noProject")}</p>;
  }

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError(t("settings:project.needsName"));
      return;
    }
    setError(null);
    if (
      trimmed === metadata.name &&
      description.trim() === (metadata.description ?? "")
    ) {
      return;
    }
    execute(t("editor:history.editProject"), [
      { type: "updateProjectMetadata", name: trimmed, description },
    ]);
  };

  return (
    <div className="settings-section">
      <label className="dialog-field">
        <span>{t("settings:project.name")}</span>
        <input
          maxLength={MAX_PROJECT_NAME_LENGTH}
          onBlur={() => {
            nameFocused.current = false;
            commit();
          }}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onFocus={() => {
            nameFocused.current = true;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          value={name}
        />
      </label>
      {error !== null && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
      <label className="dialog-field">
        <span>{t("settings:project.description")}</span>
        <textarea
          aria-label={t("settings:project.description")}
          onBlur={() => {
            descriptionFocused.current = false;
            commit();
          }}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("settings:project.descriptionPlaceholder")}
          rows={4}
          value={description}
        />
      </label>
      <p className="settings-hint">{t("settings:project.hint")}</p>
    </div>
  );
}
