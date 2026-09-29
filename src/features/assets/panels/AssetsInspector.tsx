import { useTranslation } from "react-i18next";
import { PanelFold } from "../../editor/components/PanelFold";

/**
 * The right column: what the chosen file is, and what was said about it.
 *
 * Facts read, words written — the shelf's own editor is the only writer, so
 * what is typed here lands in the document exactly as it does from a row.
 */
export function AssetsInspector() {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t("assets:inspector.label")}
      className="assets-inspector"
      id="assets-panel-right"
    >
      <PanelFold side="right" />
      <p className="inspector-empty">{t("assets:inspector.empty")}</p>
    </aside>
  );
}
