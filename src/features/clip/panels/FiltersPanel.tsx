import { useTranslation } from "react-i18next";
import type { ClipFilterPreset } from "../../../shared/domain";
import { execute } from "../../editor/commands/execute";
import { useProjectStore } from "../../editor/stores/projectStore";
import { useClipStore } from "../stores/clipStore";
import { patchCommands } from "../inspector/clipFieldMath";

/**
 * The six looks a clip can be poured through, and nothing else.
 *
 * A tile is applied, not argued with: pressing it lays the preset over every
 * chosen clip as one step of history, and pressing the one that is already
 * worn takes it off again. The swatches are the colour each preset stands
 * for rather than a thumbnail of the reader's own picture — a look is a
 * decision about the whole cut, and six little previews of one frame would
 * promise more than they can show.
 */

/** The name and the wash each preset wears on its tile. */
const TILES: { preset: ClipFilterPreset; label: string }[] = [
  { preset: "none", label: "clip:filters.none" },
  { preset: "warm", label: "clip:filters.warm" },
  { preset: "cool", label: "clip:filters.cool" },
  { preset: "mono", label: "clip:filters.mono" },
  { preset: "fade", label: "clip:filters.fade" },
  { preset: "vivid", label: "clip:filters.vivid" },
];

export function FiltersPanel() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeTimelineId = useClipStore((state) => state.activeTimelineId);
  const clipIds = useClipStore((state) => state.selection.clipIds);
  const timeline =
    (moka?.timelines ?? []).find((each) => each.id === activeTimelineId) ??
    null;
  const chosen = new Set(clipIds);
  const clips = (timeline?.clips ?? []).filter((clip) => chosen.has(clip.id));

  const apply = (preset: ClipFilterPreset) => {
    if (!timeline || clips.length === 0) return;
    // Pressing what every chosen clip already wears takes it off again; the
    // untouched tile is the same gesture said a different way.
    const worn = clips.every((clip) => (clip.filter ?? "none") === preset);
    const next: ClipFilterPreset = worn ? "none" : preset;
    const patches = clips
      .filter((clip) => (clip.filter ?? "none") !== next)
      .map((clip) => ({ clipId: clip.id, patch: { filter: next } }));
    if (patches.length === 0) return;
    execute(
      t(next === "none" ? "clip:history.clearLook" : "clip:history.applyLook"),
      patchCommands(timeline.id, patches),
    );
  };

  const onNone = clips.every((clip) => (clip.filter ?? "none") === "none");

  return (
    <div className="clip-filter-page" data-testid="clip-filters-panel">
      <div className="clip-filter-grid">
        {TILES.map(({ preset, label }) => (
          <button
            aria-label={t(label)}
            aria-pressed={
              preset === "none"
                ? clips.length > 0 && onNone
                : clips.length > 0 &&
                  clips.every((clip) => (clip.filter ?? "none") === preset)
            }
            className={`clip-filter-tile is-${preset}`}
            data-testid={`clip-filter-${preset}`}
            disabled={clips.length === 0}
            key={preset}
            onClick={() => apply(preset)}
            type="button"
          >
            <span aria-hidden="true" className="clip-filter-swatch" />
            <span>{t(label)}</span>
          </button>
        ))}
      </div>
      {clips.length === 0 ? (
        <p className="clip-filter-hint">{t("clip:filters.selectHint")}</p>
      ) : (
        <p className="clip-filter-hint">{t("clip:filters.toggleHint")}</p>
      )}
    </div>
  );
}
