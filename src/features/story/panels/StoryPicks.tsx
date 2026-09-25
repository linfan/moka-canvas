import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { assetUrl } from "../../../api/assets";
import { relativeTime } from "../relativeTime";
import type { StoryTake } from "../../../shared/domain/types";

/**
 * The drawings a place has been given, and which of them is being kept.
 *
 * A redraw does not throw the old one away — it appends — so what a reader is
 * shown here is the place's history, newest at the bottom, with the current
 * take marked. Choosing one moves it to the head of the list, which is what
 * every other part of the room reads as "the picture of this place".
 */
export function StoryPicks({
  takes,
  current,
  label,
  onChoose,
  onClose,
}: {
  takes: StoryTake[];
  /** The asset the place is keeping just now. */
  current: string | undefined;
  label: string;
  onChoose: (assetId: string) => void;
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
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        aria-label={t("story:panels.picks", { label })}
        aria-modal="true"
        className="story-picks"
        data-testid="story-picks"
        role="dialog"
      >
        <h2>{t("story:panels.picks", { label })}</h2>
        <div className="story-picks-grid">
          {takes.map((take) => (
            <button
              className={`story-pick${take.assetId === current ? " is-current" : ""}`}
              data-testid={`story-pick-${take.assetId}`}
              key={take.assetId}
              onClick={() => onChoose(take.assetId)}
              type="button"
            >
              <img alt={label} src={assetUrl(take.assetId)} />
              <span className="story-pick-foot">
                {take.createdAt === undefined
                  ? t("story:panels.pickUndated")
                  : relativeTime(take.createdAt)}
                {take.assetId === current && (
                  <span className="story-pick-current">
                    {t("story:panels.pickCurrent")}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose} type="button">
            {t("story:panels.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
