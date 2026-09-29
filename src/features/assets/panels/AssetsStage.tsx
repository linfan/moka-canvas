import { useTranslation } from "react-i18next";

/**
 * The stage: the file that is chosen, and everything that points at it.
 *
 * While nothing is chosen the stage reads the project itself — how much it
 * holds, and how much of it is placed nowhere — so arriving in the room says
 * what there is to look at rather than waiting to be asked.
 */
export function AssetsStage() {
  const { t } = useTranslation();
  return (
    <p className="assets-stage-hint" data-testid="assets-stage-hint">
      {t("assets:page.empty")}
    </p>
  );
}
