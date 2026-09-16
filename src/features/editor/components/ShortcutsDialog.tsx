import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SHORTCUT_GROUPS } from "../interactions/keyboard";
import { useEditorStore } from "../stores/editorStore";

/** How a token is worn as a keycap on a Mac. */
const MAC_KEYCAPS: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Ctrl: "⌃",
};

function isMac(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /mac/i.test(navigator.platform || navigator.userAgent)
  );
}

/** One chord as the keys it is pressed as, on this machine. */
function chordLabel(chord: string[]): string {
  if (isMac())
    return chord.map((token) => MAC_KEYCAPS[token] ?? token).join("");
  // The command key leads away from a Mac, where it is spelled out beside the
  // others rather than worn.
  const ordered = ["Mod", ...chord.filter((token) => token !== "Mod")];
  return ordered.map((token) => (token === "Mod" ? "Ctrl" : token)).join("+");
}

/**
 * The keys the editor answers to, listed from the map the handler works from
 * rather than from a copy, so help cannot go stale on its own.
 */
export function ShortcutsDialog() {
  const { t } = useTranslation();
  const open = useEditorStore((state) => state.shortcutsOpen);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") useEditorStore.getState().closeShortcuts();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;
  const close = () => useEditorStore.getState().closeShortcuts();

  return (
    <div className="dialog-backdrop" onClick={close} role="presentation">
      <div
        aria-labelledby="shortcuts-title"
        aria-modal="true"
        className="dialog shortcuts-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="dialog-head">
          <h2 id="shortcuts-title">{t("editor:dialogs.shortcuts.title")}</h2>
          <button
            aria-label={t("editor:dialogs.shortcuts.close")}
            onClick={close}
            type="button"
          >
            ✕
          </button>
        </header>
        <div className="shortcut-groups">
          {SHORTCUT_GROUPS.map((group) => (
            <section className="shortcut-group" key={group.title}>
              <h3>{t(group.title)}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.label}>
                    <span>{t(row.label)}</span>
                    <span className="shortcut-keys">
                      {row.chords.map((chord) => (
                        <kbd key={chord.join("+")}>{chordLabel(chord)}</kbd>
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
