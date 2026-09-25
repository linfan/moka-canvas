import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";

/** Which page the menu is standing on, and marks as current. */
export type HomeMenuPage = "canvas" | "clip" | "story";

/** Where each row of the menu leads. */
const PHASE: Record<HomeMenuPage, "editing" | "clip" | "story"> = {
  canvas: "editing",
  story: "story",
  clip: "clip",
};

/**
 * The mark on the button: a cup with steam over it.
 *
 * Drawn here rather than taken from a set, so the one thing that opens the
 * menu is a thing of its own and reads as the app's corner rather than as a
 * back arrow that happens to be decorated.
 */
function CoffeeIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="18"
    >
      <path d="M8.5 3.2c-.7.9-.7 1.6 0 2.5M12 2.6c-.7.9-.7 1.9 0 2.8M15.5 3.2c-.7.9-.7 1.6 0 2.5" />
      <path d="M5 8.5h11v5.5a4.5 4.5 0 0 1-4.5 4.5h-2A4.5 4.5 0 0 1 5 14V8.5Z" />
      <path d="M16 9.8h1.6a2.4 2.4 0 0 1 0 4.8H16" />
      <path d="M3.5 21h14" />
    </svg>
  );
}

/** A house with a chimney: where the projects are. */
function HomeIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.8V19h12V9.8" />
      <path d="M16.5 7.6V4.8h2v4.2" />
      <path d="M10 19v-4.5h4V19" />
    </svg>
  );
}

/** Two cards joined by a wire: the board itself. */
function CanvasIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="16"
    >
      <rect height="7" rx="1.5" width="7" x="3" y="4" />
      <rect height="7" rx="1.5" width="7" x="14" y="13" />
      <path d="M10 7.5h4a3 3 0 0 1 3 3V13" />
    </svg>
  );
}

/** A book with ruled lines in it: the telling a project is made of. */
function StoryIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M4 5.5A2 2 0 0 1 6 3.5h12a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2Z" />
      <path d="M4 17.5h15" />
      <path d="M8 3.5v14M12 3.5v14" />
    </svg>
  );
}

/** A strip of film: the cutting room that is on its way. */
function ClipIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="16"
    >
      <rect height="14" rx="1.5" width="18" x="3" y="5" />
      <path d="M7.5 5v14M16.5 5v14" />
      <path d="M3 9.7h4.5M3 14.3h4.5M16.5 9.7H21M16.5 14.3H21" />
    </svg>
  );
}

interface HomeMenuProps {
  /** The page the menu stands on; its row is marked as the current one. */
  current: HomeMenuPage;
  /**
   * What going home costs: the page the menu stands on decides whether that
   * is a guarded close of an open project or a plain step back.
   */
  onHome: () => void;
}

/**
 * The app's corner: a cup that opens the way between its pages.
 *
 * One button and a menu of where the app is, rather than a back arrow: home
 * is a place the reader goes to on purpose, and the board and the cutting
 * room beside it are places the reader goes between without putting the
 * project down. The page being stood on is marked, so the menu says where
 * "here" is as well as where "there" would be.
 *
 * The menu stands on a ring of nothing that takes the pointer. This corner of
 * the window is also where the column beside the canvas keeps its tabs, so a
 * reader sliding along the edge of an open menu would otherwise be sliding
 * over things that answer to a click: the ring takes those clicks instead,
 * and taking one is a way of putting the menu down rather than a way of
 * turning a tab over by mistake.
 */
export function HomeMenu({ current, onHome }: HomeMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (page: HomeMenuPage) => {
    setOpen(false);
    if (page === current) return;
    // The project stays open across the working pages: stepping between the
    // board, the story room, and the cutting room is not a close, and each is
    // standing exactly as it was left.
    useAppStore.getState().setPhase(PHASE[page]);
  };

  return (
    <div className="home-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("app:homeMenu.button")}
        className="home-menu-button"
        data-testid="home-menu-button"
        onClick={() => setOpen((seen) => !seen)}
        title={t("app:homeMenu.hint")}
        type="button"
      >
        <CoffeeIcon />
      </button>
      {open && (
        <div
          className="home-menu-guard"
          data-testid="home-menu-guard"
          onMouseDown={(event) => {
            // Only the ring itself puts the menu down. A press that lands on a
            // row of the menu bubbles here too, and closing on the way to a
            // choice would take the choice away before it was made.
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="home-menu-pop" data-testid="home-menu" role="menu">
            <div className="home-menu-group">
              <button
                className="home-menu-item"
                onClick={() => {
                  setOpen(false);
                  onHome();
                }}
                role="menuitem"
                type="button"
              >
                <HomeIcon />
                <span>{t("app:homeMenu.home")}</span>
              </button>
            </div>
            <div className="home-menu-group">
              <button
                aria-current={current === "canvas" ? "page" : undefined}
                className={`home-menu-item${
                  current === "canvas" ? " is-current" : ""
                }`}
                onClick={() => go("canvas")}
                role="menuitem"
                type="button"
              >
                <CanvasIcon />
                <span>{t("app:homeMenu.canvas")}</span>
              </button>
              <button
                aria-current={current === "story" ? "page" : undefined}
                className={`home-menu-item${
                  current === "story" ? " is-current" : ""
                }`}
                onClick={() => go("story")}
                role="menuitem"
                type="button"
              >
                <StoryIcon />
                <span>{t("app:homeMenu.story")}</span>
              </button>
              <button
                aria-current={current === "clip" ? "page" : undefined}
                className={`home-menu-item${
                  current === "clip" ? " is-current" : ""
                }`}
                onClick={() => go("clip")}
                role="menuitem"
                type="button"
              >
                <ClipIcon />
                <span>{t("app:homeMenu.clip")}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
