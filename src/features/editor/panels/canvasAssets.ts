import type {
  AssetCategory,
  AssetId,
  AssetKind,
  CanvasDocument,
  CanvasId,
  MokaFile,
  NodeId,
  ResourceEntry,
} from "../../../shared/domain";
import { PROJECT_ASSET_CATEGORIES, nodeAssetIds } from "../../../shared/domain";
import { SHELF_KINDS, kindOfShelf } from "./shelfFilter";

/**
 * What a board is made of, read off the cards on it.
 *
 * The tree beside the canvas opens a board into the four kinds of thing it uses,
 * and what it uses is what its cards point at rather than what the project
 * holds: a shelf of a thousand files says nothing about one board, while the
 * dozen files that board's cards are filled with are the dozen worth listing
 * under it.
 */

/** Which shelf an asset sits on, read off the path it is stored at. */
export function shelfOf(entry: ResourceEntry): AssetCategory | null {
  const category = entry.path.split("/")[1];
  return PROJECT_ASSET_CATEGORIES.find((shelf) => shelf === category) ?? null;
}

/** The assets a board's cards point at, once each, in the order held. */
export function canvasAssetIds(canvas: CanvasDocument): AssetId[] {
  const seen = new Set<AssetId>();
  for (const node of canvas.nodes) {
    for (const id of nodeAssetIds(node)) {
      seen.add(id);
    }
  }
  return [...seen];
}

/** The cards on a board that point at an asset, in the order they sit. */
export function canvasNodesUsing(
  canvas: CanvasDocument,
  assetId: AssetId,
): NodeId[] {
  return canvas.nodes
    .filter((node) => nodeAssetIds(node).includes(assetId))
    .map((node) => node.id);
}

/**
 * What a board uses, by kind, in shelf order.
 *
 * Every kind is present even when it holds nothing, so a board can be opened
 * onto four headings that read as an account of it rather than as three
 * headings with one missing and a reader left to wonder whether the fourth was
 * looked for.
 */
export function canvasAssetsByKind(
  moka: MokaFile,
  canvasId: CanvasId,
): Record<AssetKind, ResourceEntry[]> {
  const empty = Object.fromEntries(
    SHELF_KINDS.map((kind) => [kind, [] as ResourceEntry[]]),
  ) as Record<AssetKind, ResourceEntry[]>;
  const canvas = moka.canvas.find((item) => item.id === canvasId);
  if (!canvas) return empty;
  const used = canvasAssetIds(canvas);
  for (const shelf of PROJECT_ASSET_CATEGORIES) {
    const kind = kindOfShelf(shelf);
    for (const entry of moka.resources[shelf] ?? []) {
      if (used.includes(entry.id)) empty[kind].push(entry);
    }
  }
  return empty;
}
