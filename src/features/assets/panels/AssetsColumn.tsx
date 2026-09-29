import { useTranslation } from "react-i18next";
import { PanelFold } from "../../editor/components/PanelFold";

/**
 * The library column: every file the project holds, one kind at a time.
 *
 * The pane that finds a file — the kinds and their counts, the shelf's search
 * and its words, and the rows themselves — with the stage beside it and the
 * right column holding what is known about the file that is chosen.
 */
export function AssetsColumn() {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("assets:page.title")}
      className="assets-column"
      id="assets-panel-left"
    >
      <PanelFold side="left" />
      <div className="assets-column-head">
        <h2>{t("assets:page.title")}</h2>
      </div>
    </aside>
  );
}
