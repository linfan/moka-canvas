import { describe, expect, it } from "vitest";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import {
  MEDIA_FACES,
  faceShelf,
  isMediaFace,
  newestFirst,
} from "./mediaLenses";

/** A row on the shelf, with what the lens reads: an id and a filed time. */
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

const WHEN = "2026-01-01T00:00:00.000Z";

describe("what the cut's face asks the shelf", () => {
  it("is the one media face, and the shelf's own", () => {
    expect(MEDIA_FACES).toEqual(["cut"]);
    expect(isMediaFace("cut")).toBe(true);
    for (const face of ["text", "filters", "adjust"] as const) {
      expect(isMediaFace(face)).toBe(false);
    }
  });

  it("reads only the files the open cut holds", () => {
    const shelf = faceShelf({ held: new Set(["clip-material"]) });
    expect(shelf.lens?.narrow?.(entry("clip-material", WHEN))).toBe(true);
    expect(shelf.lens?.narrow?.(entry("elsewhere", WHEN))).toBe(false);
  });

  it("holds an empty cut to nothing rather than to everything", () => {
    expect(faceShelf().lens?.narrow?.(entry("anything", WHEN))).toBe(false);
  });

  it("leaves the origin question to the shelf", () => {
    // A lens that only narrows has not answered where a file came from, so
    // the shelf still asks: the cut's material can be narrowed to what was
    // brought in or made.
    expect(faceShelf().lens?.where).toBeUndefined();
  });

  it("gives the face the cutting room's own way of reading the shelf", () => {
    const shelf = faceShelf();
    expect(shelf.kinds).not.toContain("text");
    expect(shelf.emptyText).toBe("clip:mediaLenses.cut");
    expect(shelf.order).toBe("newest");
    expect(shelf.addNodes).toBe(false);
    expect(shelf.showAddNodes).toBe(false);
    expect(shelf.acceptFileDrops).toBe(true);
    expect(shelf.canvasActions).toBe(false);
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
