import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetUrl } from "../../../api/assets";

/**
 * One drawing, as large as the window will take it.
 *
 * The pictures in the room are thumbnails of work a reader is deciding about,
 * so looking closely has to be possible without leaving the step. This is the
 * room's own viewer rather than the editor's preview dialog: that one is a
 * panel of the editor's state — folders, nodes, the canvas a file belongs to —
 * and a frame drawn for a story belongs to none of it.
 */
export function StoryLightbox({
  assetId,
  label,
  note,
  onClose,
}: {
  assetId: string;
  /** What the drawing is of, which is also its alt text. */
  label: string;
  /** A line about the view, when there is one worth saying. */
  note?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="story-lightbox"
      data-testid="story-lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={label}
        aria-modal="true"
        className="story-lightbox-body"
        role="dialog"
      >
        <img alt={label} src={assetUrl(assetId)} />
        <div className="story-lightbox-foot">
          <span>{label}</span>
          {note !== undefined && <span className="story-hint">{note}</span>}
          <button
            className="link"
            data-testid="story-lightbox-close"
            onClick={onClose}
            type="button"
          >
            {t("story:panels.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
