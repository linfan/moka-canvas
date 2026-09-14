import { AssistantPanel } from "../../assistant/AssistantPanel";
import { PanelFold } from "../components/PanelFold";
import { useEditorStore } from "../stores/editorStore";
import { HistoryPanel } from "./HistoryPanel";
import { InspectorPanel } from "./InspectorPanel";

/**
 * The column on the right of the canvas, and the choice of what it shows.
 *
 * Three faces of one column, turned over by the tabs at its head rather than
 * by buttons on a strip across the bottom of the window: what is chosen is
 * read here, so the choice is offered here. The column beside the canvas on
 * the other side works the same way, and the two sides of the canvas are
 * worked the same way because they are the same kind of thing — down to the
 * corner that folds the column away.
 */
export function RightPanel() {
  const tab = useEditorStore((state) => state.sidePanelTab);
  const setTab = useEditorStore((state) => state.setSidePanelTab);

  return (
    <div className="editor-right" data-testid="right-panel" id="panel-right">
      <PanelFold side="right" />
      <div
        aria-label="What the column shows"
        className="side-panel-tabs"
        role="tablist"
      >
        <button
          aria-selected={tab === "inspector"}
          className={tab === "inspector" ? "is-active" : ""}
          data-testid="right-tab-inspector"
          onClick={() => setTab("inspector")}
          role="tab"
          title="What is chosen on the canvas, or the canvas itself"
          type="button"
        >
          Inspector
        </button>
        <button
          aria-selected={tab === "assistant"}
          className={tab === "assistant" ? "is-active" : ""}
          data-testid="right-tab-assistant"
          onClick={() => setTab("assistant")}
          role="tab"
          title="Ask about the cards on this canvas"
          type="button"
        >
          Assistant
        </button>
        <button
          aria-selected={tab === "history"}
          className={tab === "history" ? "is-active" : ""}
          data-testid="right-tab-history"
          onClick={() => setTab("history")}
          role="tab"
          title="What has been asked of this project, and the way to ask again"
          type="button"
        >
          History
        </button>
      </div>
      {tab === "assistant" ? (
        <AssistantPanel />
      ) : tab === "history" ? (
        <HistoryPanel />
      ) : (
        <InspectorPanel />
      )}
    </div>
  );
}
