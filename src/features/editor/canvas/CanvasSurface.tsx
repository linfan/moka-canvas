import { useEffect, useRef } from "react";
import type { CanvasDocument } from "../../../shared/domain";
import type { ControllerCallbacks, LeaferEditorController } from "./controller";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";

function activeCanvas(): CanvasDocument | null {
  const { moka, activeCanvasId } = useProjectStore.getState();
  if (!moka) return null;
  return (
    moka.canvas.find((canvas) => canvas.id === activeCanvasId) ??
    moka.canvas[0] ??
    null
  );
}

const callbacks: ControllerCallbacks = {
  onBackgroundTap: () => useEditorStore.getState().clearSelection(),
  onBackgroundDoubleTap: () => {
    // The add-node menu arrives with the interaction package.
  },
  onNodeTap: (nodeId, additive) => {
    const editor = useEditorStore.getState();
    if (additive) editor.toggleNode(nodeId);
    else editor.selectOnly(nodeId);
  },
  onNodeDoubleTap: () => {
    // Rename/text editing arrives with the interaction package.
  },
  onEdgeTap: (edgeId, additive) => {
    const editor = useEditorStore.getState();
    const edgeIds = editor.selection.edgeIds;
    if (additive) {
      editor.setSelection({
        nodeIds: editor.selection.nodeIds,
        edgeIds: edgeIds.includes(edgeId)
          ? edgeIds.filter((id) => id !== edgeId)
          : [...edgeIds, edgeId],
      });
    } else {
      editor.setSelection({ nodeIds: [], edgeIds: [edgeId] });
    }
  },
  onPortTap: () => {
    // Port connections arrive with the interaction package.
  },
  onCameraChange: (camera, phase) => {
    useEditorStore.getState().setCamera(camera);
    if (phase !== "end") return;
    const canvas = activeCanvas();
    if (!canvas) return;
    try {
      // Viewport persistence bypasses history: camera moves are not undoable.
      useProjectStore
        .getState()
        .applyLocal([
          { type: "setViewport", canvasId: canvas.id, viewport: camera },
        ]);
    } catch {
      // A save conflict freezes autosave; keep the local camera.
    }
  },
  onContextMenu: () => {
    // Context menus arrive with the interaction package.
  },
  wantPan: () => {
    const editor = useEditorStore.getState();
    return (editor.temporaryTool ?? editor.tool) === "pan";
  },
};

/**
 * Mounts the long-lived Leafer controller and feeds it store projections.
 * All document mutations flow back through store actions via callbacks.
 * The controller is imported lazily so environments without a canvas
 * implementation (jsdom tests) still render the DOM fallback.
 */
export function CanvasSurface() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: LeaferEditorController | null = null;
    let unsubscribe: (() => void) | null = null;

    const start = (Ctor: typeof LeaferEditorController) => {
      const host = hostRef.current;
      if (cancelled || !host) return;
      const instance = new Ctor();
      try {
        instance.mount(host, callbacks);
      } catch {
        // No working canvas implementation: the DOM hint overlay remains as
        // the accessible fallback.
        return;
      }
      controller = instance;

      let lastCanvasId: string | null = null;
      const push = () => {
        const canvas = activeCanvas();
        const editor = useEditorStore.getState();
        if (!canvas) return;
        if (canvas.id !== lastCanvasId) {
          // Adopt the target canvas's persisted viewport on switch.
          lastCanvasId = canvas.id;
          editor.setCamera(canvas.viewport);
        }
        const camera = editor.camera ?? canvas.viewport;
        instance.render({
          canvasId: canvas.id,
          camera,
          nodes: canvas.nodes,
          edges: canvas.edges,
          selection: editor.selection,
          hoveredNodeId: editor.hoveredNodeId,
          background: canvas.settings.background,
          showMinimap: canvas.settings.showMinimap,
        });
      };

      const unsubscribeProject = useProjectStore.subscribe(push);
      const unsubscribeEditor = useEditorStore.subscribe(push);
      unsubscribe = () => {
        unsubscribeProject();
        unsubscribeEditor();
      };
      push();
    };

    import("./controller")
      .then((module) => start(module.LeaferEditorController))
      .catch(() => {
        // Leafer cannot load here (e.g. jsdom); keep the DOM fallback.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      controller?.dispose();
    };
  }, []);

  return (
    <div
      className="canvas-surface"
      data-testid="canvas-surface"
      ref={hostRef}
    />
  );
}
