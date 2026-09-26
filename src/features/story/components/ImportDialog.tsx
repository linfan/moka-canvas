import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

interface ImportDialogProps {
  /** What the question is, and what the thing being made is for. */
  title: string;
  hint: string;
  /** The name the thing is given; the field is labelled plain "Name". */
  defaultName: string;
  maxLength: number;
  /** What the confirming button says, which differs by the room it leads to. */
  confirm: string;
  /** The test id of the form, so a test can tell the two imports apart. */
  testId: string;
  onClose: () => void;
  onImport: (name: string) => boolean;
}

/**
 * The question an import is asked under: what the thing it makes is called.
 *
 * Nothing else is asked here. What the import will hold is the story's to say —
 * it is whatever the steps have generated — and the dialog says as much in one
 * line rather than counting it out, since a count that is read while the room
 * is still being worked in is a count to read again.
 *
 * The dialog stands until the import lands: a document that refuses the change
 * says why, and throwing the reader's name away with it would be losing their
 * words for them.
 */
export function ImportDialog({
  title,
  hint,
  defaultName,
  maxLength,
  confirm,
  testId,
  onClose,
  onImport,
}: ImportDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (onImport(trimmed)) onClose();
  };

  return (
    <div
      aria-label={title}
      aria-modal="true"
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <form className="dialog" data-testid={testId} onSubmit={submit}>
        <h2>{title}</h2>
        <p className="dialog-note">{hint}</p>
        <label className="dialog-field">
          <span>{t("story:import.name")}</span>
          <input
            autoFocus
            data-testid={`${testId}-name`}
            maxLength={maxLength}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            {t("story:import.cancel")}
          </button>
          <button
            className="primary"
            data-testid={`${testId}-confirm`}
            disabled={name.trim().length === 0}
            type="submit"
          >
            {confirm}
          </button>
        </div>
      </form>
    </div>
  );
}
