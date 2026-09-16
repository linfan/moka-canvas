import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type {
  AssetId,
  Capability,
  CanvasId,
  FolderId,
  MokaFile,
  ResourceEntry,
} from "../../../shared/domain";
import {
  CAPABILITY_LABELS,
  MAX_CANVAS_NAME_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  childFolders,
  folderCanvases,
  foldersOf,
} from "../../../shared/domain";
import {
  ASSET_DRAG_MIME,
  assetReferencingNodeIds,
  focusNodes,
} from "../interactions/actions";
import {
  atCanvasLimit,
  boardsInFolder,
  canDropHere,
  closeCanvas,
  createCanvas,
  createFolderIn,
  landingIndex,
  moveCanvasTo,
  moveFolderTo,
  openCanvas,
  removeCanvas,
  removeFolder,
  renameCanvas,
  renameFolder,
  type DragKind,
  type DropEdge,
} from "../interactions/canvasTree";
import { useAppStore } from "../stores/appStore";
import { useEditorStore } from "../stores/editorStore";
import { useProjectStore } from "../stores/projectStore";
import { canvasAssetsByKind, canvasNodesUsing, shelfOf } from "./canvasAssets";
import { SHELF_GLYPHS, SHELF_KINDS } from "./shelfFilter";
import { useClampedMenuPosition } from "./useClampedMenuPosition";

/**
 * The project's boards, as a tree.
 *
 * Folders hold folders and boards, a board opens onto the four kinds of thing it
 * uses, and each of those onto the files themselves — so what a project holds is
 * readable top down without opening a board to find out what is on it. Opening a
 * board puts a tab up on the strip across the top, and closing it there puts it
 * down without touching it: the tree is the whole project and the strip is what
 * is being looked at.
 *
 * Everything here is one step of history where it changes the document, so a
 * rename let go of by mistake is one undo from being as it was.
 */

/**
 * What a drag out of the tree carries.
 *
 * Its own type rather than the one a dragged file uses: a board dropped on the
 * canvas is nothing the canvas can do anything with, and a canvas that read both
 * would have to guess which was meant.
 */
const TREE_DRAG_MIME = "application/x-moka-tree";

/** What a row is, which is what decides what can be done to it. */
type TreeTarget =
  /** The space under the last row: the project's own top level. */
  | { kind: "root" }
  | { kind: "folder"; id: FolderId }
  | { kind: "canvas"; id: CanvasId }
  | { kind: "branch"; canvasId: CanvasId; capability: Capability }
  | {
      kind: "asset";
      id: AssetId;
      canvasId: CanvasId;
      capability: Capability;
    };

/** What is being dragged about the tree. */
interface DragItem {
  kind: DragKind;
  id: string;
}

/** Where the row being dragged would land, and which row says so. */
interface Drop {
  anchor: string;
  edge: DropEdge;
  parentId: FolderId | null;
  index: number;
}

function keyOf(target: TreeTarget): string {
  switch (target.kind) {
    case "root":
      return "root";
    case "folder":
      return `folder:${target.id}`;
    case "canvas":
      return `canvas:${target.id}`;
    case "branch":
      return `branch:${target.canvasId}:${target.capability}`;
    case "asset":
      return `asset:${target.canvasId}:${target.id}`;
  }
}

/** The folders a board sits under, outermost first. */
function ancestorsOf(moka: MokaFile, canvasId: CanvasId): FolderId[] {
  const chain: FolderId[] = [];
  let folderId = moka.canvas.find((canvas) => canvas.id === canvasId)?.folderId;
  while (folderId !== undefined) {
    const folder = foldersOf(moka).find((item) => item.id === folderId);
    if (!folder || chain.includes(folder.id)) break;
    chain.unshift(folder.id);
    folderId = folder.parentId;
  }
  return chain;
}

/** Everything a row of the tree is given, so rows need no wiring of their own. */
interface TreeApi {
  moka: MokaFile;
  activeCanvasId: CanvasId | null;
  expanded: Set<string>;
  toggle: (key: string) => void;
  renaming: TreeTarget | null;
  draft: string;
  setDraft: (value: string) => void;
  startRename: (target: TreeTarget) => void;
  commitRename: () => void;
  cancelRename: () => void;
  openMenu: (event: ReactMouseEvent, target: TreeTarget) => void;
  dragging: DragItem | null;
  drop: Drop | null;
  startDrag: (event: ReactDragEvent, item: DragItem | null) => void;
  overRow: (event: ReactDragEvent, target: TreeTarget) => void;
  dropRow: (event: ReactDragEvent) => void;
  clearDrop: () => void;
}

/** The name being typed over a row, committed on Enter and let go on Escape. */
function RenameField({
  label,
  maxLength,
  api,
}: {
  label: string;
  maxLength: number;
  api: TreeApi;
}) {
  return (
    <input
      aria-label={label}
      autoFocus
      className="tree-rename"
      maxLength={maxLength}
      onBlur={api.commitRename}
      onChange={(event) => api.setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") api.commitRename();
        if (event.key === "Escape") api.cancelRename();
      }}
      value={api.draft}
    />
  );
}

/** The mark a row carries while something is being dragged over it. */
function dropClass(api: TreeApi, key: string): string {
  const drop = api.drop;
  return drop && drop.anchor === key ? `is-drop-${drop.edge}` : "";
}

/** What a row is dragged by, and what it lets go of where. */
function dragProps(api: TreeApi, target: TreeTarget, item: DragItem | null) {
  const key = keyOf(target);
  return {
    draggable: item !== null && api.renaming === null,
    onContextMenu: (event: ReactMouseEvent) => api.openMenu(event, target),
    onDragStart: (event: ReactDragEvent) => api.startDrag(event, item),
    onDragOver: (event: ReactDragEvent) => api.overRow(event, target),
    onDrop: api.dropRow,
    onDragEnd: api.clearDrop,
    "data-row": key,
  };
}

/**
 * One row of the tree.
 *
 * One component draws every row rather than one per kind of thing, since what
 * differs between a folder, a board, a kind and a file is the words on it and
 * what a click does — not the shape of it. Keeping the shape in one place is
 * what keeps a tree that reads the same all the way down.
 */
function Row({
  api,
  target,
  label,
  glyph,
  count,
  caret,
  open,
  active,
  drag,
  maxLength,
  onClick,
}: {
  api: TreeApi;
  target: TreeTarget;
  label: string;
  /** The mark a row leads with, where it has one of its own. */
  glyph?: string;
  /** How many of something the row holds, left off where it holds none. */
  count?: number;
  /** Whether the row opens onto rows of its own. */
  caret: boolean;
  open?: boolean;
  /** Whether this is the board being looked at. */
  active?: boolean;
  /** What the row is dragged as, or null for one that cannot be dragged. */
  drag: DragItem | null;
  maxLength: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const key = keyOf(target);
  const renaming = api.renaming !== null && keyOf(api.renaming) === key;
  // Words between the names, since a row dressed in "tree-rowis-active" wears
  // neither: it loses the shape every other row has and with it the place its
  // words start, which is the one thing a tree is read by.
  const classes = [
    "tree-row",
    active ? "is-active" : "",
    renaming ? "is-renaming" : "",
    dropClass(api, key),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...dragProps(api, target, drag)}>
      {caret ? (
        <button
          aria-label={
            open
              ? t("editor:tree.fold", { name: label })
              : t("editor:tree.openRow", { name: label })
          }
          className="tree-caret"
          onClick={() => api.toggle(key)}
          type="button"
        >
          {open ? "▾" : "▸"}
        </button>
      ) : (
        <span aria-hidden="true" className="tree-caret is-blank" />
      )}
      {glyph && (
        <span aria-hidden="true" className="tree-glyph">
          {glyph}
        </span>
      )}
      {renaming ? (
        <RenameField
          api={api}
          label={t("editor:tree.renameField", { name: label })}
          maxLength={maxLength}
        />
      ) : (
        <button
          className="tree-label"
          onClick={onClick}
          onDoubleClick={() => api.startRename(target)}
          title={label}
          type="button"
        >
          {label}
        </button>
      )}
      {count !== undefined && <span className="tree-count">{count}</span>}
    </div>
  );
}

/**
 * What one folder holds: its folders first, then its boards.
 *
 * Folders before boards at every level, so a drawer is read as a drawer and
 * what is in it as what is in it, rather than the two interleaved by whenever
 * each happened to be made.
 */
function Branch({
  parentId,
  depth,
  api,
  root,
}: {
  parentId: FolderId | null;
  depth: number;
  api: TreeApi;
  /** Whether this is the tree itself rather than a level inside it. */
  root?: boolean;
}) {
  const { t } = useTranslation();
  const folders = childFolders(api.moka, parentId);
  const canvases = folderCanvases(api.moka, parentId);
  return (
    <ul
      className={root ? "tree-root" : "tree-branch"}
      role={root ? "tree" : "group"}
    >
      {folders.map((folder) => {
        const key = `folder:${folder.id}`;
        const open = api.expanded.has(key);
        return (
          <li
            aria-expanded={open}
            aria-level={depth}
            className="tree-item"
            key={key}
            role="treeitem"
          >
            <Row
              api={api}
              caret
              count={boardsInFolder(api.moka, folder.id)}
              drag={{ kind: "folder", id: folder.id }}
              glyph="▤"
              label={folder.name}
              maxLength={MAX_FOLDER_NAME_LENGTH}
              onClick={() => api.toggle(key)}
              open={open}
              target={{ kind: "folder", id: folder.id }}
            />
            {open && (
              <Branch api={api} depth={depth + 1} parentId={folder.id} />
            )}
          </li>
        );
      })}
      {canvases.map((canvas) => {
        const key = `canvas:${canvas.id}`;
        const open = api.expanded.has(key);
        return (
          <li
            aria-expanded={open}
            aria-level={depth}
            aria-selected={canvas.id === api.activeCanvasId}
            className="tree-item"
            key={key}
            role="treeitem"
          >
            <Row
              active={canvas.id === api.activeCanvasId}
              api={api}
              caret
              count={canvas.nodes.length}
              drag={{ kind: "canvas", id: canvas.id }}
              glyph="□"
              label={canvas.name}
              maxLength={MAX_CANVAS_NAME_LENGTH}
              onClick={() => openCanvas(canvas.id)}
              open={open}
              target={{ kind: "canvas", id: canvas.id }}
            />
            {open && (
              <BoardBranch api={api} canvasId={canvas.id} depth={depth + 1} />
            )}
          </li>
        );
      })}
      {folders.length === 0 && canvases.length === 0 && depth > 1 && (
        <li className="tree-empty" role="presentation">
          {t("editor:tree.nothingInHere")}
        </li>
      )}
    </ul>
  );
}

/**
 * What one board uses, under the four kinds of thing it can be given.
 *
 * All four are shown whether or not they hold anything, since a board opened
 * onto three headings leaves a reader wondering whether the fourth was looked
 * for or simply is not there. What is listed under each is what the board's
 * cards point at rather than what the project holds: a shelf of a thousand files
 * says nothing about one board.
 */
function BoardBranch({
  canvasId,
  depth,
  api,
}: {
  canvasId: CanvasId;
  depth: number;
  api: TreeApi;
}) {
  const { t } = useTranslation();
  const byKind = useMemo(
    () => canvasAssetsByKind(api.moka, canvasId),
    [api.moka, canvasId],
  );
  const canvas = api.moka.canvas.find((item) => item.id === canvasId);
  return (
    <ul className="tree-branch" role="group">
      {SHELF_KINDS.map((capability) => {
        const entries = byKind[capability];
        const key = `branch:${canvasId}:${capability}`;
        const open = api.expanded.has(key);
        const target: TreeTarget = { kind: "branch", canvasId, capability };
        return (
          <li
            aria-expanded={open}
            aria-level={depth}
            className="tree-item"
            key={key}
            role="treeitem"
          >
            <Row
              api={api}
              caret
              count={entries.length}
              drag={null}
              label={t(CAPABILITY_LABELS[capability])}
              maxLength={MAX_CANVAS_NAME_LENGTH}
              onClick={() => api.toggle(key)}
              open={open}
              target={target}
            />
            {open && (
              <ul className="tree-branch" role="group">
                {entries.map((entry) => (
                  <AssetRow
                    api={api}
                    canvasId={canvasId}
                    capability={capability}
                    depth={depth + 1}
                    entry={entry}
                    key={entry.id}
                    uses={
                      canvas ? canvasNodesUsing(canvas, entry.id).length : 0
                    }
                  />
                ))}
                {entries.length === 0 && (
                  <li className="tree-empty" role="presentation">
                    {t("editor:tree.noKindOnBoard", {
                      kind: t(CAPABILITY_LABELS[capability]).toLowerCase(),
                    })}
                  </li>
                )}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One file a board uses, under the kind it is filed as.
 *
 * Draggable as the file itself rather than as a row of the tree, so a picture can
 * be taken from the board that uses it and let go on another to become a card
 * there — the same drag the assets column offers, from the place a reader
 * happened to be looking.
 */
function AssetRow({
  api,
  entry,
  canvasId,
  capability,
  uses,
  depth,
}: {
  api: TreeApi;
  entry: ResourceEntry;
  canvasId: CanvasId;
  capability: Capability;
  /** How many cards on this board hold it. */
  uses: number;
  depth: number;
}) {
  const { t } = useTranslation();
  const openPreview = useEditorStore((state) => state.openPreview);
  const shelf = shelfOf(entry);
  const target: TreeTarget = {
    kind: "asset",
    id: entry.id,
    canvasId,
    capability,
  };
  return (
    <li aria-level={depth} className="tree-item" role="treeitem">
      <div
        className="tree-row"
        draggable
        onContextMenu={(event) => api.openMenu(event, target)}
        onDragStart={(event) => {
          event.dataTransfer.setData(ASSET_DRAG_MIME, entry.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
        title={
          uses === 1
            ? t("editor:tree.cardHoldsOne")
            : t("editor:tree.cardHoldsMany", { count: uses })
        }
      >
        <span aria-hidden="true" className="tree-caret is-blank" />
        <span aria-hidden="true" className="tree-glyph">
          {shelf ? SHELF_GLYPHS[shelf] : "▪"}
        </span>
        <button
          className="tree-label"
          onClick={() => {
            const canvas = api.moka.canvas.find((item) => item.id === canvasId);
            const nodes = canvas ? canvasNodesUsing(canvas, entry.id) : [];
            // The cards on this board are what was asked for; a file no card on
            // it holds any more falls back to wherever else it is used.
            if (canvasId !== api.activeCanvasId) openCanvas(canvasId);
            focusNodes(
              nodes.length > 0 ? nodes : assetReferencingNodeIds(entry.id),
            );
          }}
          type="button"
        >
          {entry.name}
        </button>
        <button
          aria-label={t("editor:tree.preview", { name: entry.name })}
          className="tree-peek"
          onClick={() => openPreview(entry.id)}
          type="button"
        >
          {t("editor:action.view")}
        </button>
      </div>
    </li>
  );
}

interface MenuItem {
  label: string;
  /** A heading for the item and the ones under it that share their subject. */
  title?: string;
  danger?: boolean;
  action: () => void;
}

/**
 * What can be done to the row pointed at.
 *
 * Drawn from a list rather than working the list out here: what a row offers
 * depends on what it is and on what the tree is doing at the time — renaming,
 * which board is open — and the tree is what knows that.
 */
function TreeMenu({
  x,
  y,
  items,
  onDone,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  /** Called once the menu is finished with, before the item asked for. */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { ref, pos } = useClampedMenuPosition(x, y);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        ref.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      ) {
        onDone();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDone();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [onDone, ref]);

  return (
    <div
      aria-label={t("editor:tree.menu")}
      className="menu tree-menu"
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <Fragment key={item.label}>
          {item.title && <p className="menu-title">{item.title}</p>}
          <button
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              onDone();
              item.action();
            }}
            role="menuitem"
            type="button"
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The project's boards and the folders they are filed in.
 *
 * Holds what the rows cannot hold for themselves: which rows are open, which one
 * is being renamed, which one is being dragged and where it would land, and
 * which one was pointed at for a menu. All of it is a way of looking at the
 * document rather than part of it, so none of it is written anywhere — a project
 * reopened folds back up to what it was, and a board opened from the tree is the
 * only thing here that changes what is stored.
 */
export function ProjectTree() {
  const { t } = useTranslation();
  const moka = useProjectStore((state) => state.moka);
  const activeCanvasId = useProjectStore((state) => state.activeCanvasId);
  // Watched rather than read when asked, so the tree stops offering a board at
  // the moment a deployment's ceiling says it has enough.
  const ceiling = useAppStore(
    (state) => state.config?.limits.maxCanvasesPerProject ?? Infinity,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<TreeTarget | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: TreeTarget;
  } | null>(null);
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  // A board opened from anywhere is a board worth seeing: the folders above it
  // open, so the row the reader just chose is not one they have to hunt for.
  useEffect(() => {
    if (!moka || !activeCanvasId) return;
    const chain = ancestorsOf(moka, activeCanvasId).map((id) => `folder:${id}`);
    setExpanded((current) => {
      const missing = chain.filter((key) => !current.has(key));
      if (missing.length === 0) return current;
      return new Set([...current, ...missing]);
    });
  }, [moka, activeCanvasId]);

  const toggle = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const commitRename = useCallback(() => {
    const target = renaming;
    setRenaming(null);
    if (!target) return;
    if (target.kind === "folder") renameFolder(target.id, draft);
    if (target.kind === "canvas") renameCanvas(target.id, draft);
  }, [draft, renaming]);

  const startRename = useCallback((target: TreeTarget) => {
    if (target.kind !== "folder" && target.kind !== "canvas") return;
    const held = useProjectStore.getState().moka;
    const name =
      target.kind === "folder"
        ? (held?.folders ?? []).find((item) => item.id === target.id)?.name
        : held?.canvas.find((item) => item.id === target.id)?.name;
    if (name === undefined) return;
    setDraft(name);
    setRenaming(target);
    setExpanded((current) => new Set([...current, keyOf(target)]));
  }, []);

  const openMenu = useCallback((event: ReactMouseEvent, target: TreeTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  }, []);

  const startDrag = useCallback(
    (event: ReactDragEvent, item: DragItem | null) => {
      if (!item) return;
      event.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify(item));
      event.dataTransfer.effectAllowed = "move";
      setDragging(item);
    },
    [],
  );

  /**
   * Where the row being dragged would land, worked out while it is dragged.
   *
   * The top and bottom of a row are the places beside it and the middle is
   * inside it, which is how a reader aims a drawer at a gap rather than at a
   * row: a mark is drawn where the thing would go, so letting go is not a guess
   * about what the tree thought was meant.
   */
  const overRow = useCallback(
    (event: ReactDragEvent, target: TreeTarget) => {
      const item = dragging;
      if (!item || !moka) return;
      // Only a folder and a board are somewhere to land; what a board opens
      // onto is a way of reading it and not a place to put anything.
      if (target.kind !== "folder" && target.kind !== "canvas") return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      const bounds = event.currentTarget.getBoundingClientRect();
      const ratio = (event.clientY - bounds.top) / bounds.height;
      const edge: DropEdge =
        target.kind === "folder"
          ? ratio < 0.25
            ? "before"
            : ratio > 0.75
              ? "after"
              : "inside"
          : ratio < 0.5
            ? "before"
            : "after";
      const parentId =
        edge === "inside"
          ? target.id
          : target.kind === "folder"
            ? (foldersOf(moka).find((held) => held.id === target.id)
                ?.parentId ?? null)
            : (moka.canvas.find((held) => held.id === target.id)?.folderId ??
              null);
      if (!canDropHere(moka, item, parentId, target.id, edge)) {
        setDrop(null);
        return;
      }
      setDrop({
        anchor: keyOf(target),
        edge,
        parentId,
        index: landingIndex(moka, item, parentId, target.id, edge),
      });
    },
    [dragging, moka],
  );

  const dropRow = useCallback(
    (event: ReactDragEvent) => {
      const item = dragging;
      const landing = drop;
      event.preventDefault();
      event.stopPropagation();
      setDragging(null);
      setDrop(null);
      if (!item || !landing) return;
      if (item.kind === "canvas") {
        moveCanvasTo(item.id, landing.parentId, landing.index);
      } else {
        moveFolderTo(item.id, landing.parentId, landing.index);
      }
    },
    [dragging, drop],
  );

  const clearDrop = useCallback(() => {
    setDragging(null);
    setDrop(null);
  }, []);

  /**
   * What the row pointed at offers.
   *
   * A folder and a board both offer what goes inside them, since both are
   * somewhere a new board can be filed; only a board can be opened, closed, or
   * deleted, and only a file can be followed to the assets column. What cannot
   * be done is left out rather than offered greyed, except where leaving it out
   * would hide the reason — a folder's delete says what it would move.
   */
  /**
   * What "new here" offers at one place in the tree.
   *
   * A board is offered only where one can still be made. A deployment may set a
   * ceiling lower than the document's own, and an offer that would only be
   * refused says something untrue about what a project can still hold, so it is
   * left out rather than greyed.
   */
  const newHere = (parentId: FolderId | null): MenuItem[] => {
    const offers: MenuItem[] = [];
    if (moka && !atCanvasLimit(moka, ceiling)) {
      offers.push({
        title: t("editor:tree.newHere"),
        label: t("editor:tree.newCanvas"),
        action: () => createCanvas(parentId),
      });
    }
    offers.push({
      title: offers.length === 0 ? t("editor:tree.newHere") : undefined,
      label: t("editor:tree.newFolder"),
      action: () => createFolderIn(parentId),
    });
    return offers;
  };

  const menuItems = (target: TreeTarget): MenuItem[] => {
    if (!moka) return [];
    const items: MenuItem[] = [];
    if (target.kind === "root") {
      items.push(...newHere(null));
    }
    if (target.kind === "folder" || target.kind === "canvas") {
      // What "here" means differs by what was pointed at, and the difference is
      // the one a reader expects of a drawer: something new asked for on a
      // folder goes inside it, and something new asked for on a board goes
      // beside that board, since a board is not a place to put anything.
      const parentId =
        target.kind === "folder"
          ? target.id
          : (moka.canvas.find((held) => held.id === target.id)?.folderId ??
            null);
      items.push(...newHere(parentId));
    }
    if (target.kind === "folder") {
      const id = target.id;
      const held = boardsInFolder(moka, id);
      items.push(
        {
          title: t("editor:tree.thisFolder"),
          label: t("editor:action.rename"),
          action: () => startRename(target),
        },
        {
          label:
            held > 0
              ? held === 1
                ? t("editor:tree.deleteMovesOne")
                : t("editor:tree.deleteMovesMany", { count: held })
              : t("editor:action.delete"),
          danger: true,
          action: () => removeFolder(id),
        },
      );
    }
    if (target.kind === "canvas") {
      const id = target.id;
      items.push(
        {
          title: t("editor:tree.thisCanvas"),
          label: t("editor:action.open"),
          action: () => openCanvas(id),
        },
        { label: t("editor:action.rename"), action: () => startRename(target) },
        { label: t("editor:tree.closeTab"), action: () => closeCanvas(id) },
        {
          label: t("editor:action.delete"),
          danger: true,
          action: () => removeCanvas(id),
        },
      );
    }
    if (target.kind === "branch") {
      const { canvasId, capability } = target;
      items.push(
        {
          title: t("editor:tree.usesKind", {
            kind: t(CAPABILITY_LABELS[capability]).toLowerCase(),
          }),
          label: t("editor:action.showInAssets"),
          action: () => useEditorStore.getState().setAssetKind(capability),
        },
        {
          label: t("editor:tree.openThisCanvas"),
          action: () => openCanvas(canvasId),
        },
      );
    }
    if (target.kind === "asset") {
      const { id, canvasId, capability } = target;
      items.push(
        {
          title: t("editor:tree.thisFile"),
          label: t("editor:action.showInAssets"),
          action: () =>
            useEditorStore.getState().showAssetOnShelf(id, capability),
        },
        {
          label: t("editor:tree.selectCardsUsingIt"),
          action: () => {
            const canvas = moka.canvas.find((held) => held.id === canvasId);
            const nodes = canvas ? canvasNodesUsing(canvas, id) : [];
            if (canvasId !== activeCanvasId) openCanvas(canvasId);
            focusNodes(nodes.length > 0 ? nodes : assetReferencingNodeIds(id));
          },
        },
      );
    }
    return items;
  };

  if (!moka) return null;

  const api: TreeApi = {
    moka,
    activeCanvasId,
    expanded,
    toggle,
    renaming,
    draft,
    setDraft,
    startRename,
    commitRename,
    cancelRename: () => setRenaming(null),
    openMenu,
    dragging,
    drop,
    startDrag,
    overRow,
    dropRow,
    clearDrop,
  };

  /** The space under the last row, which is the project's own top level. */
  const overRoot = (event: ReactDragEvent) => {
    if (!dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDrop({
      anchor: "__root__",
      edge: "inside",
      parentId: null,
      index: landingIndex(moka, dragging, null, null, "inside"),
    });
  };

  return (
    <section className="side-tree">
      <div className="side-tree-head">
        <span className="side-tree-new">
          <button
            aria-label={t("editor:tree.newCanvasTopLevel")}
            disabled={atCanvasLimit(moka, ceiling)}
            onClick={() => createCanvas(null)}
            title={
              atCanvasLimit(moka, ceiling)
                ? t("editor:tree.canvasCeiling", { count: ceiling })
                : t("editor:tree.newCanvasTopLevel")
            }
            type="button"
          >
            {t("editor:tree.addCanvas")}
          </button>
          <button
            aria-label={t("editor:tree.newFolderTopLevel")}
            onClick={() => createFolderIn(null)}
            type="button"
          >
            {t("editor:tree.addFolder")}
          </button>
        </span>
      </div>
      <div
        className="side-tree-scroll"
        onContextMenu={(event) => openMenu(event, { kind: "root" })}
        onDragOver={overRoot}
        onDrop={dropRow}
      >
        <Branch api={api} depth={1} parentId={null} root />
        {moka.canvas.length === 0 && (
          <p className="inspector-empty">{t("editor:tree.empty")}</p>
        )}
      </div>
      {menu && (
        <TreeMenu
          items={menuItems(menu.target)}
          onDone={() => setMenu(null)}
          x={menu.x}
          y={menu.y}
        />
      )}
    </section>
  );
}
