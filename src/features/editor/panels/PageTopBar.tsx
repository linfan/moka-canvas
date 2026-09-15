import { useEffect, useRef, useState, type ReactNode } from "react";
import { useModelStore } from "../../settings/modelStore";
import { redo, undo } from "../commands/execute";
import { useHistoryStore, isBoundary } from "../stores/historyStore";
import { useProjectStore } from "../stores/projectStore";
import { HomeMenu } from "../components/HomeMenu";

export const SAVE_LABEL: Record<string, string> = {
  saved: "Saved",
  saving: "Saving…",
  conflicted: "Conflict",
  error: "Save failed",
};

export function useCanUndo(): boolean {
  return useHistoryStore((state) => {
    const top = state.undoStack[state.undoStack.length - 1];
    return top !== undefined && !isBoundary(top);
  });
}

interface PageTopBarProps {
  /** The page the bar stands on, which the menu marks as current. */
  current: "canvas" | "clip";
  /** What going home costs; the page decides whether that is guarded. */
  onHome: () => void;
  /** The middle of the bar: what the page is made of. */
  tabs?: ReactNode;
  /** The answers under the Export button, which differs by page. */
  exportItems?: ReactNode;
}

/**
 * The bar every working page stands under.
 *
 * What the project is, where it is being saved, and the things that act on the
 * document as a whole. Everything that acts on one node lives on the node, in
 * its inspector, or in the menus the page itself offers, so this bar says the
 * same thing however much is selected — and the two exports, which answer one
 * question between them ("what should leave with this?"), are one button with
 * its answers under it rather than two buttons side by side.
 *
 * The middle and the menu are slots because that is what changes between the
 * canvases and the cutting room: the rest is one bar serving both pages, and a
 * reader stepping between them finds the same corner in the same place.
 */
export function PageTopBar({
  current,
  onHome,
  tabs,
  exportItems,
}: PageTopBarProps) {
  const projectName = useProjectStore((state) => state.moka?.metadata.name);
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const saveError = useProjectStore((state) => state.saveError);
  const canUndo = useCanUndo();
  const canRedo = useHistoryStore((state) => state.redoStack.length > 0);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!exportRef.current?.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [exportOpen]);

  return (
    <header className="editor-topbar">
      <HomeMenu current={current} onHome={onHome} />
      <strong className="editor-project-name">{projectName}</strong>
      {tabs}
      <span
        className={`save-status save-status-${saveStatus}`}
        title={saveError ?? undefined}
      >
        {SAVE_LABEL[saveStatus]}
      </span>
      {saveStatus === "conflicted" && (
        <button
          onClick={() => void useProjectStore.getState().reload()}
          type="button"
        >
          Reload
        </button>
      )}
      <div aria-label="Edit" className="tool-group" role="group">
        <button
          aria-label="Undo"
          disabled={!canUndo}
          onClick={() => undo()}
          type="button"
        >
          ↶
        </button>
        <button
          aria-label="Redo"
          disabled={!canRedo}
          onClick={() => redo()}
          type="button"
        >
          ↷
        </button>
      </div>
      <button
        onClick={() => useModelStore.getState().openSettings()}
        type="button"
      >
        Settings
      </button>
      <div className="export-menu" ref={exportRef}>
        <button
          aria-expanded={exportOpen}
          aria-haspopup="menu"
          data-testid="export-menu-button"
          onClick={() => setExportOpen((seen) => !seen)}
          type="button"
        >
          Export
        </button>
        {exportOpen && (
          <div
            aria-label="Export"
            className="menu export-menu-pop"
            data-testid="export-menu"
            // A choice made under this button puts the menu down with it; a
            // disabled answer never gets here, so the menu stays up for the
            // reader to see what it says.
            onClick={() => setExportOpen(false)}
            role="menu"
          >
            {exportItems}
          </div>
        )}
      </div>
    </header>
  );
}
