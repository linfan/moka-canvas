import {
  MAX_CANVAS_NAME_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  childFolders,
  createFolder,
  descendantFolderIds,
  emptyCanvas,
  folderCanvases,
  newId,
  nextFolderName,
  type CanvasId,
  type FolderId,
  type MokaFile,
} from "../../../shared/domain";
import { useAppStore } from "../stores/appStore";
import { useOpenCanvases } from "../stores/openCanvases";
import { useProjectStore, nextCanvasName } from "../stores/projectStore";
import { runsInFlight } from "../stores/runStore";
import { execute, historyBoundary } from "../commands/execute";
import { i18n } from "../../../shared/i18n";

/**
 * What can be done to the canvas tree: the boards a project has, the folders
 * they are filed in, and which of them are open on the strip across the top.
 *
 * These sit together rather than in the components that call them because two
 * places ask for the same things — the tree beside the canvas and the tabs above
 * it — and a board opened from one has to look the same as a board opened from
 * the other. Each is one step of history where it changes the document, so
 * letting go of a rename or a move gives it back.
 */

/**
 * Puts a board up on the strip and looks at it.
 *
 * A run belongs to the project rather than to the board on screen, so switching
 * does not stop one; but its answer lands somewhere the reader has just stopped
 * looking, which is worth a word.
 */
export function openCanvas(canvasId: CanvasId): void {
  const project = useProjectStore.getState();
  const moka = project.moka;
  if (!moka) return;
  const target = moka.canvas.find((canvas) => canvas.id === canvasId);
  if (!target) return;
  useOpenCanvases.getState().open(canvasId);
  if (canvasId === project.activeCanvasId) return;
  const going = project.activeCanvasId
    ? runsInFlight(project.activeCanvasId)
    : 0;
  const left = moka.canvas.find(
    (canvas) => canvas.id === project.activeCanvasId,
  );
  project.switchCanvas(canvasId);
  historyBoundary(i18n.t("editor:history.switchTo", { name: target.name }));
  if (going > 0 && left) {
    useAppStore.getState().pushToast(
      "info",
      going === 1
        ? i18n.t("editor:interactions.runningOnCanvasOne", {
            name: left.name,
          })
        : i18n.t("editor:interactions.runningOnCanvasMany", {
            count: going,
            name: left.name,
          }),
    );
  }
}

/**
 * Puts a board down without touching it.
 *
 * The board stays in the project — a tab is a way of looking at a board and not
 * the board itself, so closing one is never a question about unsaved work. The
 * last tab open is not closable, since an editor with no board in it has nothing
 * to show.
 */
export function closeCanvas(canvasId: CanvasId): void {
  const project = useProjectStore.getState();
  const next = useOpenCanvases
    .getState()
    .close(canvasId, project.activeCanvasId);
  if (next) openCanvas(next);
}

/**
 * How many boards this deployment lets one project have.
 *
 * The document refuses past its own ceiling whatever a deployment says, but a
 * deployment can set a lower one, and an offer that would only be refused is
 * worse than no offer: the tree leaves "New canvas" out rather than letting a
 * reader ask for a board that cannot be made.
 */
export function canvasLimit(): number {
  return (
    useAppStore.getState().config?.limits.maxCanvasesPerProject ?? Infinity
  );
}

/**
 * Whether a project has as many boards as it is allowed.
 *
 * The ceiling can be handed in by something watching it, so a tree that has to
 * redraw when a deployment's answer arrives is not left reading a number that
 * was not there yet when it first drew.
 */
export function atCanvasLimit(
  moka: MokaFile,
  limit: number = canvasLimit(),
): boolean {
  return moka.canvas.length >= limit;
}

/**
 * A new board, filed where it was asked for and opened straight away.
 *
 * Named after the boards the project has rather than the ones its folder has:
 * two boards called "Canvas 3" in different drawers would be two boards nobody
 * could tell apart in the strip across the top, which shows no folder at all.
 */
export function createCanvas(folderId: FolderId | null): CanvasId | null {
  const moka = useProjectStore.getState().moka;
  if (!moka) return null;
  if (atCanvasLimit(moka)) {
    useAppStore
      .getState()
      .pushToast(
        "info",
        i18n.t("editor:tree.canvasCeiling", { count: canvasLimit() }),
      );
    return null;
  }
  const canvas = emptyCanvas(newId(), nextCanvasName(moka));
  const placed = folderId ? { ...canvas, folderId } : canvas;
  const applied = execute(i18n.t("editor:history.addCanvas"), [
    { type: "addCanvas", canvas: placed },
  ]);
  if (!applied) return null;
  openCanvas(placed.id);
  return placed.id;
}

/** A new folder, filed where it was asked for. */
export function createFolderIn(parentId: FolderId | null): FolderId | null {
  const moka = useProjectStore.getState().moka;
  if (!moka) return null;
  const folder = createFolder(nextFolderName(moka, parentId), parentId);
  const applied = execute(i18n.t("editor:history.addFolder"), [
    { type: "addFolder", folder },
  ]);
  return applied ? folder.id : null;
}

export function renameCanvas(canvasId: CanvasId, name: string): void {
  const trimmed = name.trim().slice(0, MAX_CANVAS_NAME_LENGTH);
  const moka = useProjectStore.getState().moka;
  const current = moka?.canvas.find((canvas) => canvas.id === canvasId);
  if (!trimmed || !current || trimmed === current.name) return;
  execute(i18n.t("editor:history.renameCanvas"), [
    { type: "renameCanvas", canvasId, name: trimmed },
  ]);
}

export function renameFolder(folderId: FolderId, name: string): void {
  const trimmed = name.trim().slice(0, MAX_FOLDER_NAME_LENGTH);
  const moka = useProjectStore.getState().moka;
  const current = (moka?.folders ?? []).find(
    (folder) => folder.id === folderId,
  );
  if (!trimmed || !current || trimmed === current.name) return;
  execute(i18n.t("editor:history.renameFolder"), [
    { type: "renameFolder", folderId, name: trimmed },
  ]);
}

/** How many boards a folder holds, counting the folders inside it. */
export function boardsInFolder(moka: MokaFile, folderId: FolderId): number {
  const holders = [folderId, ...descendantFolderIds(moka, folderId)];
  return holders.reduce(
    (total, holder) => total + folderCanvases(moka, holder).length,
    0,
  );
}

/**
 * Takes a board out of the project.
 *
 * Asked about first when the board has work on it, since a board with cards on
 * it is not something to let go of by mistaking one row of a tree for another;
 * an empty one is tidying and goes without a question. The tab it had comes down
 * with it, and the boards beside it stay where they are.
 */
export function removeCanvas(canvasId: CanvasId): void {
  const moka = useProjectStore.getState().moka;
  const canvas = moka?.canvas.find((item) => item.id === canvasId);
  if (!moka || !canvas) return;
  if (moka.canvas.length <= 1) {
    useAppStore.getState().pushToast("info", i18n.t("editor:tree.lastCanvas"));
    return;
  }
  if (
    canvas.nodes.length > 0 &&
    !window.confirm(
      i18n.t("editor:tree.confirmDeleteCanvas", {
        name: canvas.name,
        count: canvas.nodes.length,
      }),
    )
  ) {
    return;
  }
  const applied = execute(i18n.t("editor:history.deleteCanvas"), [
    { type: "removeCanvas", canvasId },
  ]);
  if (!applied) return;
  reconcileTabs();
}

/**
 * Brings the strip across the top back into agreement with the document.
 *
 * Called after anything that can take a board away — a deletion from the tree,
 * an undo of the add that made it — so a tab is never left showing a board that
 * is not there, and the reader is never left looking at nothing.
 */
export function reconcileTabs(): void {
  const project = useProjectStore.getState();
  const moka = project.moka;
  if (!moka) return;
  const next = useOpenCanvases.getState().prune(
    moka.canvas.map((canvas) => canvas.id),
    project.activeCanvasId,
  );
  if (next && next !== project.activeCanvasId) {
    project.switchCanvas(next);
  }
}

/**
 * Takes a folder out of the tree, asking first when it holds boards.
 *
 * What it held is not held by nothing: its folders and its boards move up into
 * the folder that held it, so tidying the tree cannot cost anybody their work.
 * That is worth saying in the question rather than leaving to be discovered,
 * since "delete" over a drawer of boards reads as something it is not.
 */
export function removeFolder(folderId: FolderId): void {
  const moka = useProjectStore.getState().moka;
  const folder = (moka?.folders ?? []).find((item) => item.id === folderId);
  if (!moka || !folder) return;
  const boards = boardsInFolder(moka, folderId);
  if (
    boards > 0 &&
    !window.confirm(
      boards === 1
        ? i18n.t("editor:tree.confirmDeleteFolderOne", { name: folder.name })
        : i18n.t("editor:tree.confirmDeleteFolderMany", {
            name: folder.name,
            count: boards,
          }),
    )
  ) {
    return;
  }
  execute(i18n.t("editor:history.deleteFolder"), [
    { type: "removeFolder", folderId },
  ]);
}

/** Files a board in a folder at the place it was let go. */
export function moveCanvasTo(
  canvasId: CanvasId,
  folderId: FolderId | null,
  index: number,
): void {
  execute(i18n.t("editor:history.moveCanvas"), [
    { type: "moveCanvas", canvasId, folderId, index },
  ]);
}

/** Files a folder in another at the place it was let go. */
export function moveFolderTo(
  folderId: FolderId,
  parentId: FolderId | null,
  index: number,
): void {
  execute(i18n.t("editor:history.moveFolder"), [
    { type: "moveFolder", folderId, parentId, index },
  ]);
}

/** What is being dragged about the tree. */
export type DragKind = "canvas" | "folder";

/** Where a row being dragged over would put it. */
export type DropEdge = "before" | "after" | "inside";

/**
 * The place among its new siblings a dragged row lands at.
 *
 * Counted without the row being dragged, since that is the list the move is
 * measured against: a board dragged down past its neighbour would otherwise be
 * put one place further than the mark under the pointer says, the list having
 * been counted with the board still in it.
 *
 * `targetId` is the row dropped on and `edge` which part of it was let go over;
 * `inside` lands at the end of what the folder holds, since a drawer has no
 * order to aim at from outside it.
 */
export function landingIndex(
  moka: MokaFile,
  dragged: { kind: DragKind; id: string },
  parentId: FolderId | null,
  targetId: string | null,
  edge: DropEdge,
): number {
  const peers =
    dragged.kind === "canvas"
      ? folderCanvases(moka, parentId).map((canvas) => canvas.id)
      : childFolders(moka, parentId).map((folder) => folder.id);
  const without = peers.filter((id) => id !== dragged.id);
  if (edge === "inside" || targetId === null) return without.length;
  const at = without.indexOf(targetId);
  if (at < 0) return without.length;
  return edge === "after" ? at + 1 : at;
}

/**
 * Whether a row may be let go here.
 *
 * A folder cannot be dropped into itself or into one it holds, and a board
 * cannot be dropped into the place it already is at — which is not a rule so
 * much as a mark that would promise a move that does nothing, or one the
 * document would refuse after the reader had let go.
 */
export function canDropHere(
  moka: MokaFile,
  dragged: { kind: DragKind; id: string },
  parentId: FolderId | null,
  targetId: string | null,
  edge: DropEdge,
): boolean {
  if (dragged.kind === "folder") {
    if (edge === "inside" && parentId === dragged.id) return false;
    if (descendantFolderIds(moka, dragged.id).includes(parentId ?? "")) {
      return false;
    }
  }
  if (edge === "inside") return true;
  // Beside itself, in the folder it is already in, is nowhere to go.
  return !(
    targetId === dragged.id && currentParentOf(moka, dragged) === parentId
  );
}

/** The folder a dragged row sits in now. */
function currentParentOf(
  moka: MokaFile,
  dragged: { kind: DragKind; id: string },
): FolderId | null {
  if (dragged.kind === "canvas") {
    return (
      moka.canvas.find((canvas) => canvas.id === dragged.id)?.folderId ?? null
    );
  }
  return (
    (moka.folders ?? []).find((folder) => folder.id === dragged.id)?.parentId ??
    null
  );
}
