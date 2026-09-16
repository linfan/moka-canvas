import type { Capability } from "../../../shared/domain";
import { MODEL_CAPABILITIES } from "../../../shared/domain";
import type { ShelfLens } from "../../editor/panels/shelfFilter";
import type { ClipFace } from "../stores/clipStore";

/**
 * The two media faces, as lenses on the one shelf.
 *
 * A face is a question, and the shelf answers it: what the project holds, and
 * which files were brought in. Everything that is not the question — the
 * search, the words, the keepers, the paging, the rows with their drag-out —
 * is the shelf's own and is the same on every face.
 *
 * Pure functions only: what a face passes to the shelf is decided here, so it
 * can be read and tested without a browser.
 */

/** The faces that read the shelf, in the rail's order. */
export const MEDIA_FACES = ["project", "local"] as const;

export type MediaFace = (typeof MEDIA_FACES)[number];

/** Whether a face of the rail is one of the shelf's own. */
export function isMediaFace(face: ClipFace): face is MediaFace {
  return (MEDIA_FACES as readonly ClipFace[]).includes(face);
}

/**
 * The kinds a source face reads: pictures and sound.
 *
 * The cutting room cuts what is seen and heard, and words have a page of their
 * own where they are written rather than laid on a track.
 */
const MEDIA_KINDS: readonly Capability[] = MODEL_CAPABILITIES.filter(
  (kind) => kind !== "text",
);

export { newestFirst } from "../../editor/panels/shelfFilter";

/** What a face has the shelf say when the face itself holds nothing. */
const EMPTY_TEXT: Record<MediaFace, string> = {
  project: "clip:mediaLenses.project",
  local: "clip:mediaLenses.local",
};

/** Everything a face passes to the shelf, apart from its own row actions. */
export interface FaceShelfProps {
  /** Which kind tabs the face offers. */
  kinds: readonly Capability[];
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

/** What one face of the media column asks of the shelf. */
export function faceShelf(face: MediaFace): FaceShelfProps {
  const common = {
    emptyText: EMPTY_TEXT[face],
    order: "newest",
    addNodes: false,
    showAddNodes: false,
    acceptFileDrops: true,
    canvasActions: false,
  } as const;
  switch (face) {
    /*
      Both faces are the origin question themselves, so the shelf is read
      through a lens even where that lens narrows nothing: an open lens is
      what tells the shelf the face has already asked where the files came
      from, and that the reader should not be asked again on top of it.
    */
    case "local":
      return { ...common, kinds: MEDIA_KINDS, lens: { where: "brought" } };
    case "project":
      return { ...common, kinds: MEDIA_KINDS, lens: { where: null } };
  }
}
