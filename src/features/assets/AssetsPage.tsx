import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { historyBoundary } from "../editor/commands/execute";
import { PanelUnfold } from "../editor/components/PanelFold";
import { PanelResizer } from "../editor/components/PanelResizer";
import { panelWidthStyle } from "../editor/components/panelWidthVars";
import { useAppStore } from "../editor/stores/appStore";
import { usePanelFolds } from "../editor/stores/panelFolds";
import { usePanelWidths } from "../editor/stores/panelWidths";
import { useProjectStore } from "../editor/stores/projectStore";
import { i18n } from "../../shared/i18n";
import { AssetsTopBar } from "./components/AssetsTopBar";
import { AssetsColumn } from "./panels/AssetsColumn";
import { AssetsInspector } from "./panels/AssetsInspector";
import { AssetsStage } from "./panels/AssetsStage";
import { useAssetsStore } from "./stores/assetsStore";

/**
 * The files room.
 *
 * A fourth page beside the board, the cutting room and the story room, and the
 * one that reads the whole project rather than one document of it: every file
 * the project holds on the left, the chosen file and everything that points at
 * it in the middle, and what is known about it on the right. Stepping into it
 * changes nothing — a file's own words are written through the command
 * pipeline the other rooms use, so what is typed here is undone here.
 */
export function AssetsPage() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const leftWidth = usePanelWidths((state) => state.left);
  const rightWidth = usePanelWidths((state) => state.right);
  const leftFolded = usePanelFolds((state) => state.left);
  const rightFolded = usePanelFolds((state) => state.right);
  const projectId = moka?.metadata.id ?? null;

  // Entering the room is a seam in the history: what is undone here is not
  // undone on a board, and a board's undos stop at the door.
  useEffect(() => {
    if (!projectId) return;
    historyBoundary(i18n.t("assets:page.historyBoundary"));
  }, [projectId]);

  /**
   * Going home from here puts the project down first.
   *
   * Like the story room there is no dialog about unsaved work: what the room
   * holds when the reader steps over is flushed, and a flush that cannot land
   * says so and keeps the reader here rather than walking away from the work.
   */
  const goHome = async () => {
    const project = useProjectStore.getState();
    if (project.moka) {
      try {
        await project.flush();
      } catch {
        // The flush's own error is on the store; the toast says the rest.
      }
      const after = useProjectStore.getState();
      if (after.pending.length > 0 || after.saveStatus === "conflicted") {
        useAppStore
          .getState()
          .pushToast(
            "error",
            after.saveStatus === "conflicted"
              ? t("assets:page.saveConflict")
              : (after.saveError ?? t("assets:page.saveFailed")),
          );
        return;
      }
      after.close();
      useAssetsStore.getState().forget();
    }
    useAppStore.getState().setPhase("launcher");
  };

  return (
    <div className="assets-page" data-testid="assets-page">
      <AssetsTopBar onHome={() => void goHome()} />
      <div
        className="assets-body"
        style={panelWidthStyle(leftWidth, rightWidth)}
      >
        {leftFolded ? <PanelUnfold side="left" /> : <AssetsColumn />}
        {!leftFolded && <PanelResizer side="left" />}
        <main aria-label={t("assets:stage.label")} className="assets-stage">
          <AssetsStage />
        </main>
        {!rightFolded && <PanelResizer side="right" />}
        {rightFolded ? <PanelUnfold side="right" /> : <AssetsInspector />}
      </div>
    </div>
  );
}
