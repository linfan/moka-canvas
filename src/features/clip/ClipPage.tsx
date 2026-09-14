import { HomeMenu } from "../editor/components/HomeMenu";
import { useAppStore } from "../editor/stores/appStore";
import { useProjectStore } from "../editor/stores/projectStore";
import { useRunStore } from "../editor/stores/runStore";

/**
 * The cutting room, which is not built yet.
 *
 * A page of its own rather than a corner of the editor: the menu in the
 * corner marks it as a place the app has, and a place the app has is a page
 * the reader stands on even while it has nothing to show but the saying so.
 */
export function ClipPage() {
  /**
   * Going home from here puts the project down first.
   *
   * There is no dialog about unsaved work on this page, since nothing on it
   * can leave work unsaved: what the board held when the reader stepped over
   * is flushed, and a flush that cannot land says so and keeps the reader
   * here rather than walking away from the work.
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
              ? "Saving is blocked by a revision conflict — go back to the canvas to resolve it."
              : (after.saveError ??
                  "Saving failed — go back to the canvas to try again."),
          );
        return;
      }
      after.close();
      useRunStore.getState().reset();
    }
    useAppStore.getState().setPhase("launcher");
  };

  return (
    <div className="clip-page" data-testid="clip-page">
      <header className="clip-head">
        <HomeMenu current="clip" onHome={() => void goHome()} />
      </header>
      <p className="clip-coming">Comming soon</p>
    </div>
  );
}
