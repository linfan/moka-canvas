import type {
  AssetId,
  AssetKind,
  MokaFile,
  ResourceEntry,
} from "../../../shared/domain";
import { collectAssetReferences } from "../../../shared/domain";
import { KIND_SHELVES, newestFirst, shelfWhere } from "./shelfFilter";

/**
 * Files brought in and placed nowhere yet: the tray above a scoped shelf.
 *
 * Brought, not made — a run's output lands in a document by definition, while
 * an import is a file the reader still has to put somewhere. Placed, not kept:
 * what counts is a reference (a card, a clip, a story place), not the keeper
 * star. Derived rather than remembered, so it keeps itself true: placing the
 * file clears its row, letting the placement go brings it back.
 */

/** Whether one file is waiting for a place, given what is placed. */
export function isUnplaced(
  placed: ReadonlySet<AssetId>,
  entry: ResourceEntry,
): boolean {
  return shelfWhere(entry) === "brought" && !placed.has(entry.id);
}

/**
 * The unplaced files of a kind, newest first.
 *
 * Read through the shelves the kind is filed on, so a sound filed as music or
 * as a voice is found either way, and newest first because what was just
 * brought in is what the tray is for.
 */
export function unplacedEntries(
  moka: MokaFile,
  kind: AssetKind,
): ResourceEntry[] {
  const placed = new Set(collectAssetReferences(moka).keys());
  const kept: ResourceEntry[] = [];
  for (const shelf of KIND_SHELVES[kind]) {
    for (const entry of moka.resources[shelf] ?? []) {
      if (isUnplaced(placed, entry)) kept.push(entry);
    }
  }
  return newestFirst(kept);
}
