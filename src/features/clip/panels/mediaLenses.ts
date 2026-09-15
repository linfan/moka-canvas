import type { AssetId, Capability, MokaFile } from "../../../shared/domain";
import { MODEL_CAPABILITIES } from "../../../shared/domain";
import { canvasAssetIds } from "../../editor/panels/canvasAssets";
import { SHELF_KINDS, type ShelfLens } from "../../editor/panels/shelfFilter";
import type { ClipFace } from "../stores/clipStore";

/**
 * The six media faces, as lenses on the one shelf.
 *
 * A face is a question, and the shelf answers it: which files were brought in,
 * which the models made, which the boards are holding, what the library holds
 * altogether, what can be mixed. Everything that is not the question — the
 * search, the words, the keepers, the paging, the rows with their drag-out —
 * is the shelf's own and is the same on every face.
 *
 * Pure functions only: what a face passes to the shelf is decided here, so it
 * can be read and tested without a browser.
 */

/** The faces that read the shelf, in the rail's order. */
export const MEDIA_FACES = [
  "local",
  "project",
  "runs",
  "canvas",
  "library",
  "audio",
] as const;

export type MediaFace = (typeof MEDIA_FACES)[number];

/** Whether a face of the rail is one of the shelf's own. */
export function isMediaFace(face: ClipFace): face is MediaFace {
  return (MEDIA_FACES as readonly ClipFace[]).includes(face);
}

/**
 * The kinds a source face reads: pictures and sound.
 *
 * The cutting room cuts what is seen and heard, and words have a page of their
 * own where they are written rather than laid on a track — so the shelf's text
 * book is only ever opened by the Library face, which is the project's whole
 * library and nothing else.
 */
export const MEDIA_KINDS: readonly Capability[] = MODEL_CAPABILITIES.filter(
  (kind) => kind !== "text",
);

/**
 * Every file the boards are holding, once each.
 *
 * Read in one pass over the document rather than asked of the registry once
 * per file: the question belongs to the document, and a face that asked it per
 * row would ask the same thing a thousand times for the same answer.
 */
export function canvasHeldIds(moka: MokaFile | null): Set<AssetId> {
  const held = new Set<AssetId>();
  for (const canvas of moka?.canvas ?? []) {
    for (const id of canvasAssetIds(canvas)) held.add(id);
  }
  return held;
}

export { newestFirst } from "../../editor/panels/shelfFilter";

/** What a face has the shelf say when the face itself holds nothing. */
const EMPTY_TEXT: Record<MediaFace, string> = {
  local: "Nothing brought in yet — import files, or drop them here.",
  project: "No media in this project yet.",
  runs: "Nothing made by the models yet.",
  canvas: "No canvas is holding a file yet.",
  library: "No files yet — import media to fill the shelf.",
  audio: "No sound yet — import audio to build the mix.",
};

/** Everything a face passes to the shelf, apart from its own row actions. */
export interface FaceShelfProps {
  /** Which kind tabs the face offers. */
  kinds: readonly Capability[];
  /** The question the face stands behind, if it stands behind one. */
  lens?: ShelfLens;
  /** What the face says when it holds nothing. */
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
export function faceShelf(
  face: MediaFace,
  held: ReadonlySet<AssetId>,
): FaceShelfProps {
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
      The four source faces are the origin question themselves, so the shelf
      is read through a lens even where that lens narrows nothing: an open lens
      is what tells the shelf the face has already asked where the files came
      from, and that the reader should not be asked again on top of it.
    */
    case "local":
      return { ...common, kinds: MEDIA_KINDS, lens: { where: "brought" } };
    case "project":
      return { ...common, kinds: MEDIA_KINDS, lens: { where: null } };
    case "runs":
      return { ...common, kinds: MEDIA_KINDS, lens: { where: "made" } };
    case "canvas":
      return {
        ...common,
        kinds: MEDIA_KINDS,
        lens: { where: null, narrow: (entry) => held.has(entry.id) },
      };
    // The library is the editor's own shelf, whole: all five books, all four
    // kinds, the origin question included.
    case "library":
      return { ...common, kinds: SHELF_KINDS };
    // A sound is filed as music or a voice, so the mix face reads both books
    // of one kind rather than one shelf of two.
    case "audio":
      return { ...common, kinds: ["audio"] };
  }
}
