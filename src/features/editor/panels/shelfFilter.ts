import type {
  AssetCategory,
  ResourceEntry,
  ResourceRegistry,
} from "../../../shared/domain";
import {
  ASSET_ORIGIN_LABELS,
  PROJECT_ASSET_CATEGORIES,
} from "../../../shared/domain";

/** How many rows the shelf shows before asking a reader to carry on. */
export const SHELF_PAGE = 60;

/**
 * Where the shelf says a file came from.
 *
 * One of these answers is not a field on the entry: a project that made a file
 * says so through `provenance`, so "made here" is read out of that rather than
 * written twice and given a chance to disagree with itself.
 */
export type ShelfWhere = "made" | "brought" | "filed";

export const SHELF_WHERE_LABELS: Record<ShelfWhere, string> = {
  made: "Made here",
  ...ASSET_ORIGIN_LABELS,
};

export function shelfWhere(entry: ResourceEntry): ShelfWhere {
  if (entry.origin === "filed") return "filed";
  if (entry.provenance) return "made";
  if (entry.origin === "brought") return "brought";
  // Nothing recognisable was said about where it came from, and no node made
  // it: a project was handed the file.
  return "brought";
}

export interface ShelfFilter {
  /** Words to find, matched against the name and everything said about it. */
  asked: string;
  /** Every one of these must be carried by an asset for it to stay. */
  tags: string[];
  keepersOnly: boolean;
  where: ShelfWhere | null;
  category: AssetCategory | null;
}

export const OPEN_SHELF_FILTER: ShelfFilter = {
  asked: "",
  tags: [],
  keepersOnly: false,
  where: null,
  category: null,
};

export function shelfFilterIsOpen(filter: ShelfFilter): boolean {
  return (
    filter.asked.trim() === "" &&
    filter.tags.length === 0 &&
    !filter.keepersOnly &&
    filter.where === null &&
    filter.category === null
  );
}

function carriesTag(entry: ResourceEntry, tag: string): boolean {
  const asked = tag.toLowerCase();
  return (entry.tags ?? []).some((carried) => carried.toLowerCase() === asked);
}

function saidAbout(entry: ResourceEntry): string {
  return [
    entry.name,
    ...(entry.tags ?? []),
    entry.note ?? "",
    entry.keyword ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/** The shelf, narrowed to what a reader asked for, in filing order. */
export function filterShelf(
  resources: ResourceRegistry,
  filter: ShelfFilter,
): ResourceEntry[] {
  const asked = filter.asked.trim().toLowerCase();
  const kept: ResourceEntry[] = [];
  for (const category of PROJECT_ASSET_CATEGORIES) {
    if (filter.category && filter.category !== category) continue;
    for (const entry of resources[category] ?? []) {
      if (filter.keepersOnly && entry.favorite !== true) continue;
      if (filter.where && shelfWhere(entry) !== filter.where) continue;
      if (filter.tags.some((tag) => !carriesTag(entry, tag))) continue;
      if (asked && !saidAbout(entry).includes(asked)) continue;
      kept.push(entry);
    }
  }
  return kept;
}

export interface ShelfTag {
  tag: string;
  count: number;
}

/**
 * Every word on the shelf, most-carried first.
 *
 * Counted over the whole shelf rather than over what a filter left standing, so
 * adding a second word narrows the list instead of emptying it.
 */
export function shelfTags(resources: ResourceRegistry): ShelfTag[] {
  const counts = new Map<string, ShelfTag>();
  for (const category of PROJECT_ASSET_CATEGORIES) {
    for (const entry of resources[category] ?? []) {
      for (const tag of entry.tags ?? []) {
        const seen = counts.get(tag.toLowerCase());
        if (seen) seen.count += 1;
        else counts.set(tag.toLowerCase(), { tag, count: 1 });
      }
    }
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.count - left.count || left.tag.localeCompare(right.tag),
  );
}

/** Kept in filing order, so a page of the shelf reads the same twice. */
export function groupShelf(
  entries: ResourceEntry[],
): { category: AssetCategory; entries: ResourceEntry[] }[] {
  return PROJECT_ASSET_CATEGORIES.map((category) => ({
    category,
    entries: entries.filter((entry) => entry.path.split("/")[1] === category),
  })).filter((group) => group.entries.length > 0);
}
