import type { AssetId, AssetKind } from "../../../shared/domain";
import { ASSET_KINDS } from "../../../shared/domain";
import { heldLens } from "../../editor/panels/shelfFilter";
import type { ShelfLens } from "../../editor/panels/shelfFilter";
import type { ClipFace } from "../stores/clipStore";

/**
 * The cutting room's one media face, as a lens on the shelf.
 *
 * The column reads the cut's own material rather than the project's: the files
 * the open timeline's clips hold, and nothing else. Everything the project
 * holds is the files room's question, and the way to reach it from here is the
 * picker — a cut is made of what is laid on it, and a shelf of a hundred files
 * the cut does not touch is a shelf that hides the ones it does.
 *
 * Pure functions only: what the face passes to the shelf is decided here, so
 * it can be read and tested without a browser.
 */

/** The faces that read the shelf, in the rail's order. */
export const MEDIA_FACES = ["cut"] as const;

export type MediaFace = (typeof MEDIA_FACES)[number];

/** Whether a face of the rail is the shelf's own. */
export function isMediaFace(face: ClipFace): face is MediaFace {
  return (MEDIA_FACES as readonly ClipFace[]).includes(face);
}

/**
 * The kinds the cut's face reads: pictures and sound.
 *
 * The cutting room cuts what is seen and heard, and words have a page of their
 * own where they are written rather than laid on a track.
 */
const MEDIA_KINDS: readonly AssetKind[] = ASSET_KINDS.filter(
  (kind) => kind !== "text",
);

export { newestFirst } from "../../editor/panels/shelfFilter";

/** Everything a face passes to the shelf, apart from its own row actions. */
export interface FaceShelfProps {
  /** Which kind tabs the face offers. */
  kinds: readonly AssetKind[];
  /** The question the face stands behind, if it stands behind one. */
  lens?: ShelfLens;
  /** What the face says when it holds nothing, as a translation key. */
  emptyText: string;
  /** A cutting room shelf reads newest first: what just arrived is what to use. */
  order: "newest";
  /** An import here fills the shelf; no nodes are made on any board. */
  addNodes: false;
  /** With nowhere for imported files to land, there is no checkbox to offer. */
  showAddNodes: false;
  /** Files dropped over the column are what the column is for. */
  acceptFileDrops: true;
  /** Focus selects cards on a board, which is the canvas column's business. */
  canvasActions: false;
}

/** What the cut's face reads the shelf through. */
export interface FaceShelfOptions {
  /** Every file the open timeline's clips read. */
  held?: ReadonlySet<AssetId>;
}

/** What the cut's own material is: the files the open timeline's clips read. */
const NOTHING_HELD: ReadonlySet<AssetId> = new Set();

/** What the face of the media column asks of the shelf. */
export function faceShelf(options: FaceShelfOptions = {}): FaceShelfProps {
  return {
    kinds: MEDIA_KINDS,
    // A lens that only narrows: the face has not answered the origin question,
    // so the shelf still asks it — a cut's material can be narrowed to what
    // was made or what was brought in on top of belonging to this cut.
    lens: heldLens(options.held ?? NOTHING_HELD),
    emptyText: "clip:mediaLenses.cut",
    order: "newest",
    addNodes: false,
    showAddNodes: false,
    acceptFileDrops: true,
    canvasActions: false,
  };
}
