import { describe, expect, it } from "vitest";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import {
  MEDIA_FACES,
  faceShelf,
  isMediaFace,
  newestFirst,
} from "./mediaLenses";

/** A row on the shelf, with what the lenses read: an id and a filed time. */
function entry(id: AssetId, updatedAt: string): ResourceEntry {
  return {
    id,
    name: `${id}.png`,
    path: `assets/images/${id}.png`,
    mime: "image/png",
    bytes: 64,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("what each face asks the shelf", () => {
  it("stands the local face on what was brought in", () => {
    expect(faceShelf("local").lens?.where).toBe("brought");
  });

  it("reads the project face open on origin, so it is a face of its own", () => {
    expect(faceShelf("project").lens?.where).toBeNull();
  });

  it("keeps the words out of both source faces", () => {
    for (const face of MEDIA_FACES) {
      expect(faceShelf(face).kinds).not.toContain("text");
    }
  });

  it("gives every face the cutting room's own way of reading the shelf", () => {
    for (const face of MEDIA_FACES) {
      const shelf = faceShelf(face);
      expect(shelf.order).toBe("newest");
      expect(shelf.addNodes).toBe(false);
      expect(shelf.showAddNodes).toBe(false);
      expect(shelf.acceptFileDrops).toBe(true);
      expect(shelf.canvasActions).toBe(false);
      expect(shelf.emptyText.length).toBeGreaterThan(0);
    }
  });

  it("knows which faces read the shelf at all", () => {
    for (const face of MEDIA_FACES) expect(isMediaFace(face)).toBe(true);
    for (const face of ["text", "filters", "adjust"] as const) {
      expect(isMediaFace(face)).toBe(false);
    }
  });
});

describe("the order the cutting room reads in", () => {
  it("puts the newest rows first, and leaves the shelf's own order alone", () => {
    const rows = [
      entry("oldest", "2026-01-01T00:00:00.000Z"),
      entry("newest", "2026-03-01T00:00:00.000Z"),
      entry("middle", "2026-02-01T00:00:00.000Z"),
    ];
    expect(newestFirst(rows).map((row) => row.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(rows.map((row) => row.id)).toEqual(["oldest", "newest", "middle"]);
  });
});
