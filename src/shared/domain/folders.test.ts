import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import { decodeMokaFile, encodeMokaFile } from "./codec";
import { MAX_FOLDER_DEPTH, MAX_FOLDER_NAME_LENGTH } from "./constants";
import { createFolder, nextFolderName } from "./folders";
import { buildGoldenMokaFile } from "./fixtures";
import type { DocumentCommand, MokaFile } from "./types";
import { validateMokaFile } from "./validate";

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as CommandError).code;
  }
  return "OK";
}

function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
  return applyCommands(moka, commands);
}

/** What the tree reads as: folders before canvases among their siblings. */
function treeOf(moka: MokaFile, parentId: string | null = null): string[] {
  const folders = (moka.folders ?? []).filter(
    (folder) => (folder.parentId ?? null) === parentId,
  );
  const names = moka.canvas
    .filter((canvas) => (canvas.folderId ?? null) === parentId)
    .map((canvas) => canvas.name);
  return [
    ...folders.flatMap((folder) => [
      `${folder.name}/`,
      ...treeOf(moka, folder.id),
    ]),
    ...names,
  ];
}

/** A canvas by the name it is read by, since a move changes the flat order. */
function idOf(moka: MokaFile, name: string): string {
  const canvas = moka.canvas.find((item) => item.name === name);
  if (!canvas) throw new Error(`No canvas called ${name}`);
  return canvas.id;
}

/** A folder by the name it is read by. */
function idOfFolder(moka: MokaFile, name: string): string {
  const folder = (moka.folders ?? []).find((item) => item.name === name);
  if (!folder) throw new Error(`No folder called ${name}`);
  return folder.id;
}

/** A golden document with two folders, one holding a canvas and a subfolder. */
function buildTree(): MokaFile {
  const moka = buildGoldenMokaFile();
  const drafts = createFolder("Drafts");
  const kept = createFolder("Kept");
  const inside = createFolder("Inside", drafts.id);
  let next = apply(moka, { type: "addFolder", folder: drafts }).next;
  next = apply(next, { type: "addFolder", folder: kept }).next;
  next = apply(next, { type: "addFolder", folder: inside }).next;
  return apply(next, {
    type: "moveCanvas",
    canvasId: moka.canvas[0].id,
    folderId: drafts.id,
    index: 0,
  }).next;
}

describe("the canvas tree", () => {
  it("holds a canvas in the folder it was put in", () => {
    const moka = buildTree();
    expect(treeOf(moka)).toEqual([
      "Drafts/",
      "Inside/",
      "Canvas 1",
      "Kept/",
      "Canvas 2",
    ]);
    expect(validateMokaFile(moka)).toEqual([]);
  });

  it("takes a canvas back out and gives the tree it had", () => {
    const moka = buildTree();
    const { next, inverse } = apply(moka, {
      type: "moveCanvas",
      canvasId: idOf(moka, "Canvas 1"),
      folderId: null,
      index: 0,
    });
    expect(treeOf(next)).toEqual([
      "Drafts/",
      "Inside/",
      "Kept/",
      "Canvas 1",
      "Canvas 2",
    ]);
    expect(treeOf(apply(next, ...inverse).next)).toEqual(treeOf(moka));
  });

  it("orders the canvases a folder holds by the place asked for", () => {
    const moka = buildTree();
    const drafts = (moka.folders ?? [])[0];
    const moved = apply(moka, {
      type: "moveCanvas",
      canvasId: idOf(moka, "Canvas 2"),
      folderId: drafts.id,
      index: 0,
    });
    expect(treeOf(moved.next)).toEqual([
      "Drafts/",
      "Inside/",
      "Canvas 2",
      "Canvas 1",
      "Kept/",
    ]);
    expect(treeOf(apply(moved.next, ...moved.inverse).next)).toEqual(
      treeOf(moka),
    );
  });

  it("leaves the field out of a document with no folders at all", () => {
    const moka = buildGoldenMokaFile();
    expect(moka.folders).toBeUndefined();
    const added = apply(moka, {
      type: "addFolder",
      folder: createFolder("Drafts"),
    });
    expect(added.next.folders).toHaveLength(1);
    expect(apply(added.next, ...added.inverse).next.folders).toBeUndefined();
  });

  it("renames a folder and undoes the rename", () => {
    const moka = buildTree();
    const folderId = (moka.folders ?? [])[0].id;
    const { next, inverse } = apply(moka, {
      type: "renameFolder",
      folderId,
      name: "Rough",
    });
    expect(treeOf(next)[0]).toBe("Rough/");
    expect(treeOf(apply(next, ...inverse).next)).toEqual(treeOf(moka));
    expect(
      codeOf(() => apply(moka, { type: "renameFolder", folderId, name: "" })),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "renameFolder",
          folderId,
          name: "x".repeat(MAX_FOLDER_NAME_LENGTH + 1),
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        apply(moka, { type: "renameFolder", folderId: "nope", name: "Rough" }),
      ),
    ).toBe("FOLDER_NOT_FOUND");
  });

  it("moves what a folder held up into the folder that held it", () => {
    const moka = buildTree();
    const drafts = (moka.folders ?? [])[0];
    const { next, inverse } = apply(moka, {
      type: "removeFolder",
      folderId: drafts.id,
    });
    expect(treeOf(next)).toEqual(["Inside/", "Kept/", "Canvas 2", "Canvas 1"]);
    expect(treeOf(apply(next, ...inverse).next)).toEqual(treeOf(moka));
    expect(
      codeOf(() => apply(moka, { type: "removeFolder", folderId: "nope" })),
    ).toBe("FOLDER_NOT_FOUND");
  });

  it("refuses to put a folder inside itself or inside one it holds", () => {
    const moka = buildTree();
    const [drafts, , inside] = moka.folders ?? [];
    expect(
      codeOf(() =>
        apply(moka, {
          type: "moveFolder",
          folderId: drafts.id,
          parentId: drafts.id,
          index: 0,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "moveFolder",
          folderId: drafts.id,
          parentId: inside.id,
          index: 0,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("keeps the tree to the depth it is kept to", () => {
    let moka = buildGoldenMokaFile();
    let parentId: string | null = null;
    for (let level = 0; level < MAX_FOLDER_DEPTH; level += 1) {
      const folder = createFolder(`Level ${level + 1}`, parentId);
      moka = apply(moka, { type: "addFolder", folder }).next;
      parentId = folder.id;
    }
    expect(validateMokaFile(moka)).toEqual([]);
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addFolder",
          folder: createFolder("Too deep", parentId),
        }),
      ),
    ).toBe("VALIDATION_FAILED");

    // What a folder carries under it counts as well as the folder itself.
    const carried = createFolder("Carried");
    moka = apply(moka, { type: "addFolder", folder: carried }).next;
    moka = apply(moka, {
      type: "addFolder",
      folder: createFolder("Inside carried", carried.id),
    }).next;
    const deepest = idOfFolder(moka, `Level ${MAX_FOLDER_DEPTH}`);
    // Two levels of room, since what it carries counts with it.
    const oneUp = idOfFolder(moka, `Level ${MAX_FOLDER_DEPTH - 2}`);
    expect(
      codeOf(() =>
        apply(moka, {
          type: "moveFolder",
          folderId: carried.id,
          parentId: deepest,
          index: 0,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    const moved = apply(moka, {
      type: "moveFolder",
      folderId: carried.id,
      parentId: oneUp,
      index: 0,
    });
    expect(validateMokaFile(moved.next)).toEqual([]);
  });

  it("names a new folder after the ones its neighbour already has", () => {
    const moka = buildTree();
    expect(nextFolderName(moka)).toBe("Folder 3");
    const drafts = (moka.folders ?? [])[0];
    expect(nextFolderName(moka, drafts.id)).toBe("Folder 2");
    const named = apply(moka, {
      type: "addFolder",
      folder: createFolder("Folder 1"),
    }).next;
    expect(nextFolderName(named)).toBe("Folder 4");
  });

  it("refuses a canvas born into a folder that is not there", () => {
    const moka = buildGoldenMokaFile();
    const canvas = { ...moka.canvas[1], id: "canvas-x", folderId: "nope" };
    expect(codeOf(() => apply(moka, { type: "addCanvas", canvas }))).toBe(
      "FOLDER_NOT_FOUND",
    );
  });

  it("carries the tree through the codec, and a flat one through unchanged", () => {
    const moka = buildTree();
    const once = encodeMokaFile(moka);
    const decoded = decodeMokaFile(once);
    expect(treeOf(decoded)).toEqual(treeOf(moka));
    expect(Buffer.from(encodeMokaFile(decoded)).equals(once)).toBe(true);

    const flat = buildGoldenMokaFile();
    const bytes = encodeMokaFile(flat);
    expect(decodeMokaFile(bytes).folders).toBeUndefined();
    expect(
      Buffer.from(encodeMokaFile(decodeMokaFile(bytes))).equals(bytes),
    ).toBe(true);
  });

  it("says what is wrong with a tree a document arrived with", () => {
    const moka = buildTree();
    const dangling = {
      ...moka,
      canvas: moka.canvas.map((canvas, index) =>
        index === 0 ? { ...canvas, folderId: "nope" } : canvas,
      ),
    };
    expect(validateMokaFile(dangling).map((issue) => issue.code)).toContain(
      "FOLDER_NOT_FOUND",
    );

    const circles = {
      ...moka,
      folders: (moka.folders ?? []).map((folder) =>
        folder.name === "Drafts"
          ? { ...folder, parentId: (moka.folders ?? [])[2].id }
          : folder,
      ),
    };
    expect(validateMokaFile(circles).map((issue) => issue.message)).toContain(
      `Folder "Drafts" is inside itself`,
    );
  });
});
