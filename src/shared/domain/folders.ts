import { newId, nowIso } from "./ids";
import type { CanvasDocument, CanvasFolder, FolderId, MokaFile } from "./types";

/**
 * Reading and naming the canvas tree.
 *
 * The document holds two flat lists — folders and canvases — and a folder named
 * on each canvas saying where it sits, so the tree is derived rather than
 * stored: there is one order to keep, and no nested copy of it free to disagree
 * with the list a command just moved. Among their siblings folders come before
 * canvases, each in the order its own list holds it.
 *
 * Everything here is total over a malformed document as well as a sound one. A
 * document out of the wild can name a parent that is not there, or a parent that
 * is its own grandchild, and a reader walking that has to stop rather than spin.
 */

/** The folders a project has, or none for a document written before them. */
export function foldersOf(moka: MokaFile): CanvasFolder[] {
  return moka.folders ?? [];
}

export function folderById(
  moka: MokaFile,
  folderId: FolderId,
): CanvasFolder | null {
  return foldersOf(moka).find((folder) => folder.id === folderId) ?? null;
}

/** The folder a canvas sits in, or null for one at the project root. */
export function canvasFolderOf(canvas: CanvasDocument): FolderId | null {
  return canvas.folderId ?? null;
}

/** The folders directly in `parentId`, in the order the list holds them. */
export function childFolders(
  moka: MokaFile,
  parentId: FolderId | null,
): CanvasFolder[] {
  return foldersOf(moka).filter(
    (folder) => (folder.parentId ?? null) === parentId,
  );
}

/** The canvases directly in `parentId`, in the order the list holds them. */
export function folderCanvases(
  moka: MokaFile,
  parentId: FolderId | null,
): CanvasDocument[] {
  return moka.canvas.filter((canvas) => (canvas.folderId ?? null) === parentId);
}

/**
 * How deep a folder sits, counting a folder at the project root as one.
 *
 * The walk stops at a name it has already passed, so a document carrying a
 * circle reads as a finite depth rather than a walk that never ends; naming the
 * circle is validation's job, and it does it separately. The depth is allowed
 * past the ceiling on purpose: a caller has to be able to see one level too
 * deep in order to refuse it.
 */
export function folderDepth(moka: MokaFile, folderId: FolderId): number {
  const seen = new Set<FolderId>([folderId]);
  let depth = 1;
  let parentId = folderById(moka, folderId)?.parentId;
  while (parentId !== undefined && !seen.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = folderById(moka, parentId)?.parentId;
  }
  return depth;
}

/** Every folder under this one, not counting it. */
export function descendantFolderIds(
  moka: MokaFile,
  folderId: FolderId,
): FolderId[] {
  const found: FolderId[] = [];
  const seen = new Set<FolderId>([folderId]);
  const queue: FolderId[] = [folderId];
  while (queue.length > 0) {
    const holder = queue.shift() as FolderId;
    for (const child of childFolders(moka, holder)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

/**
 * How deep the tree under a folder reaches, counting the folder itself as one.
 *
 * What a move is measured against: a folder carrying two levels of its own
 * cannot be dropped six levels down, and saying so before the move is made is
 * the only way a tree is kept to a depth a reader can follow.
 */
export function subtreeDepth(moka: MokaFile, folderId: FolderId): number {
  let deepest = 1;
  for (const descendant of descendantFolderIds(moka, folderId)) {
    const relative =
      folderDepth(moka, descendant) - folderDepth(moka, folderId);
    if (relative + 1 > deepest) deepest = relative + 1;
  }
  return deepest;
}

/**
 * The place a canvas holds among the canvases of the folder it sits in.
 *
 * The order the tree shows, and so the order a move is asked for and undone in:
 * a canvas moving back to where it was is put back at this index, which lands it
 * beside the same neighbours however the flat list underneath was rearranged.
 */
export function canvasSiblingIndex(moka: MokaFile, canvasId: string): number {
  const canvas = moka.canvas.find((item) => item.id === canvasId);
  if (!canvas) return 0;
  const peers = folderCanvases(moka, canvasFolderOf(canvas));
  return Math.max(
    0,
    peers.findIndex((item) => item.id === canvasId),
  );
}

/** The place a folder holds among the folders of the folder it sits in. */
export function folderSiblingIndex(moka: MokaFile, folderId: FolderId): number {
  const folder = folderById(moka, folderId);
  if (!folder) return 0;
  const peers = childFolders(moka, folder.parentId ?? null);
  return Math.max(
    0,
    peers.findIndex((item) => item.id === folderId),
  );
}

/**
 * A new folder, with an id and the moment it was made.
 *
 * No updated-at beside it: renaming or moving a drawer is not an event worth a
 * timestamp the document has to carry, and a field that says when a folder was
 * last touched would be one more thing a command could forget to keep honest.
 */
export function createFolder(
  name: string,
  parentId?: FolderId | null,
): CanvasFolder {
  return {
    id: newId(),
    name,
    ...(parentId ? { parentId } : {}),
    createdAt: nowIso(),
  };
}

/**
 * A name for a new folder that the folder it lands in does not already use.
 *
 * Counted within its own parent rather than across the project, since two
 * folders called "Drafts" in different places are two different drawers and
 * neither reader is confused by it.
 */
export function nextFolderName(
  moka: MokaFile,
  parentId?: FolderId | null,
): string {
  const used = new Set(
    childFolders(moka, parentId ?? null).map((folder) => folder.name),
  );
  let n = used.size + 1;
  while (used.has(`Folder ${n}`)) n += 1;
  return `Folder ${n}`;
}
