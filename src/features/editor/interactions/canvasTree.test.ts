import { describe, expect, it } from "vitest";
import { createFolder, type MokaFile } from "../../../shared/domain";
import { buildGoldenMokaFile } from "../../../shared/domain/fixtures";
import { boardsInFolder, canDropHere, landingIndex } from "./canvasTree";

/**
 * A project with Drafts holding one board and a folder of its own, Kept beside
 * it, and one board at the top level: the tree a reader has to be able to
 * rearrange without losing anything in it.
 */
function project(): MokaFile {
  const moka = buildGoldenMokaFile();
  const drafts = createFolder("Drafts");
  const kept = createFolder("Kept");
  const inside = createFolder("Inside", drafts.id);
  moka.folders = [drafts, kept, inside];
  const [first, second] = moka.canvas;
  moka.canvas = [
    { ...second, folderId: kept.id },
    { ...first, folderId: drafts.id },
  ];
  return moka;
}

function ids(moka: MokaFile) {
  const [drafts, kept, inside] = moka.folders ?? [];
  const [second, first] = moka.canvas;
  return {
    drafts: drafts.id,
    kept: kept.id,
    inside: inside.id,
    first: first.id,
    second: second.id,
  };
}

describe("where a dragged row lands", () => {
  it("counts the siblings without the row being dragged", () => {
    const moka = project();
    const { kept, first, second } = ids(moka);
    // Letting go under the board already there is the place before it.
    expect(
      landingIndex(moka, { id: first, kind: "canvas" }, kept, second, "before"),
    ).toBe(0);
    // Letting go under it is the place after it, which is the end of the drawer.
    expect(
      landingIndex(moka, { id: first, kind: "canvas" }, kept, second, "after"),
    ).toBe(1);
    // Inside a folder, the end of what it holds.
    expect(
      landingIndex(moka, { id: first, kind: "canvas" }, kept, null, "inside"),
    ).toBe(1);
  });

  it("counts the folders a folder is dropped among", () => {
    const moka = project();
    const { kept, inside } = ids(moka);
    // The top level holds Drafts and Kept, so dropping Inside out of Drafts
    // counts both of them: before Kept is the second place and after it the
    // third, however deep Inside was sitting before.
    expect(
      landingIndex(moka, { id: inside, kind: "folder" }, null, kept, "after"),
    ).toBe(2);
    expect(
      landingIndex(moka, { id: inside, kind: "folder" }, null, kept, "before"),
    ).toBe(1);
  });

  it("refuses a folder dropped into itself or into one it holds", () => {
    const moka = project();
    const { drafts, inside } = ids(moka);
    expect(
      canDropHere(moka, { id: drafts, kind: "folder" }, drafts, null, "inside"),
    ).toBe(false);
    expect(
      canDropHere(moka, { id: drafts, kind: "folder" }, inside, null, "inside"),
    ).toBe(false);
    // Beside itself, in the folder it is already in, is nowhere to go.
    expect(
      canDropHere(
        moka,
        { id: inside, kind: "folder" },
        drafts,
        inside,
        "before",
      ),
    ).toBe(false);
    expect(
      canDropHere(moka, { id: inside, kind: "folder" }, null, null, "inside"),
    ).toBe(true);
  });

  it("counts what a folder holds all the way down", () => {
    const moka = project();
    const { drafts, inside, kept } = ids(moka);
    // Drafts holds a board and a folder of its own that holds none.
    expect(boardsInFolder(moka, drafts)).toBe(1);
    expect(boardsInFolder(moka, inside)).toBe(0);
    expect(boardsInFolder(moka, kept)).toBe(1);
  });
});
