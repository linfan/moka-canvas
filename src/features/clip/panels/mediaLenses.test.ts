import { describe, expect, it } from "vitest";
import type {
  AssetId,
  MediaNodeData,
  ResourceEntry,
  WorkflowNode,
} from "../../../shared/domain";
import { createNode } from "../../../shared/domain/factories";
import {
  buildShelfMokaFile,
  goldenNodeIds,
} from "../../../shared/domain/fixtures";
import {
  MEDIA_FACES,
  canvasHeldIds,
  faceShelf,
  isMediaFace,
  newestFirst,
  projectLens,
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

/** A card on a board, filled with the file (and poster) it points at. */
function holding(kind: "image" | "video", data: MediaNodeData): WorkflowNode {
  return { ...createNode(kind, { x: 0, y: 0 }), data };
}

describe("what the boards are holding", () => {
  it("gathers what every board points at, posters included", () => {
    const moka = buildShelfMokaFile();
    moka.canvas[0].nodes.push(holding("image", { assetId: "image-main" }));
    moka.canvas[1].nodes.push(
      holding("video", {
        assetId: "video-second",
        posterAssetId: "image-poster",
      }),
    );

    const held = canvasHeldIds(moka);
    expect([...held].sort()).toEqual(
      [
        "image-main",
        "image-poster",
        "video-second",
        goldenNodeIds().assetImage,
      ].sort(),
    );
    // A file that no card points at is not held, and neither is anything on a
    // document with no boards at all.
    expect(held.has("image-unheld")).toBe(false);
    expect(canvasHeldIds(buildShelfMokaFile()).has("image-unheld")).toBe(false);
    expect(canvasHeldIds(null).size).toBe(0);
  });
});

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

describe("what the project face narrows to", () => {
  it("stands on what the models made when the face asks for the made", () => {
    expect(faceShelf("project", { project: "made" }).lens?.where).toBe("made");
  });

  it("holds the canvas narrowing to the files the boards are using", () => {
    const shelf = faceShelf("project", {
      project: "canvas",
      held: new Set(["image-held"]),
    });
    expect(
      shelf.lens?.narrow?.(entry("image-held", "2026-01-01T00:00:00.000Z")),
    ).toBe(true);
    expect(
      shelf.lens?.narrow?.(entry("image-loose", "2026-01-01T00:00:00.000Z")),
    ).toBe(false);
  });

  it("reads open on origin when nothing narrows it", () => {
    const lens = projectLens("all", new Set());
    expect(lens.where).toBeNull();
    expect(lens.narrow).toBeUndefined();
  });

  it("says its own words when a narrowing of its own holds nothing", () => {
    expect(faceShelf("project", { project: "made" }).emptyText).toBe(
      "clip:mediaLenses.made",
    );
    expect(faceShelf("project", { project: "canvas" }).emptyText).toBe(
      "clip:mediaLenses.canvas",
    );
    expect(faceShelf("project").emptyText).toBe("clip:mediaLenses.project");
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
