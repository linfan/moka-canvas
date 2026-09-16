import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CLIP_SHORTCUT_GROUPS } from "../interactions/clipShortcuts";

interface ClipShortcutsDialogProps {
  onClose: () => void;
}

/**
 * The keys the cutting room answers to, listed from the table the handler
 * works from rather than from a copy, so the help cannot go stale on its own.
 *
 * The list holds only what the room can do today: what a later package adds
 * is added to the table and appears here, rather than being promised ahead.
 */
export function ClipShortcutsDialog({ onClose }: ClipShortcutsDialogProps) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      aria-label={t("clip:shortcuts.title")}
      aria-modal="true"
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <div className="dialog shortcuts-dialog">
        <header className="dialog-head">
          <h2>{t("clip:shortcuts.title")}</h2>
          <button
            aria-label={t("clip:shortcuts.close")}
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <div className="shortcut-groups">
          {CLIP_SHORTCUT_GROUPS.map((group) => (
            <section className="shortcut-group" key={group.title}>
              <h3>{t(group.title)}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.label}>
                    <span>{t(row.label)}</span>
                    <span className="shortcut-keys">
                      {row.chords.map((chord) => (
                        <kbd key={chord}>{t(chord)}</kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
