import { create } from "zustand";
import type { AssetId, AssetKind } from "../../../shared/domain";

/**
 * What the files room is looking at.
 *
 * A reader's place in the room rather than a fact about the work: which file
 * is on the stage, which files the column lists, and which kind it is turned
 * to. It is kept in memory and never written down — a project reopened starts
 * at the whole shelf.
 *
 * The kind lives here rather than inside the shelf because the overview's
 * cards turn it too, and a column with two owners is a column that disagrees
 * with itself.
 */
export type AssetsView = "all" | "unused";

interface AssetsState {
  /** The file the stage and the right column read, or null. */
  inspectedAssetId: AssetId | null;
  /** Which files the column lists: everything, or what nothing holds. */
  view: AssetsView;
  /** The kind the column is turned to. */
  kind: AssetKind;
  select: (id: AssetId | null) => void;
  setView: (view: AssetsView) => void;
  setKind: (kind: AssetKind) => void;
  forget: () => void;
}

export const useAssetsStore = create<AssetsState>()((set) => ({
  inspectedAssetId: null,
  view: "all",
  // Pictures, which is the kind the shelf itself opens on: what a reader of a
  // project's files reaches for first.
  kind: "image",

  select: (inspectedAssetId) => set({ inspectedAssetId }),
  setView: (view) => set({ view }),
  setKind: (kind) => set({ kind }),
  forget: () => set({ inspectedAssetId: null, view: "all" }),
}));
