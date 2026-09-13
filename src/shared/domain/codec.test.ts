import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "./constants";
import {
  buildConversationMokaFile,
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  buildLegacyV1MokaFile,
  buildShelfMokaFile,
  buildTreeMokaFile,
} from "./fixtures";
import { decodeMokaFile, encodeMokaFile, MokaCodecError } from "./codec";
import { derivePorts } from "./factories";
import type { MediaNodeData } from "./types";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);
const GOLDEN_JSON = join(FIXTURE_DIR, "minimal.moka.json");
const GOLDEN_BINARY = join(FIXTURE_DIR, "minimal.canvas.moka");
const CONVERSATION_JSON = join(FIXTURE_DIR, "conversation.moka.json");
const CONVERSATION_BINARY = join(FIXTURE_DIR, "conversation.canvas.moka");
const SHELF_JSON = join(FIXTURE_DIR, "shelf.moka.json");
const SHELF_BINARY = join(FIXTURE_DIR, "shelf.canvas.moka");
const TREE_JSON = join(FIXTURE_DIR, "tree.moka.json");
const TREE_BINARY = join(FIXTURE_DIR, "tree.canvas.moka");
const LEGACY_BINARY = join(FIXTURE_DIR, "v1-legacy.moka");

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value;
}

describe("moka codec", () => {
  it("round-trips the golden fixture semantically", () => {
    const golden = buildGoldenMokaFile();
    const encoded = encodeMokaFile(golden);
    const decoded = decodeMokaFile(encoded);
    expect(normalize(decoded)).toEqual(normalize(golden));
  });

  it("is byte-canonical on re-save", () => {
    const golden = buildGoldenMokaFile();
    const first = encodeMokaFile(golden);
    const second = encodeMokaFile(decodeMokaFile(first));
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("matches the shared golden fixtures", () => {
    const golden = buildGoldenMokaFile();
    const encoded = encodeMokaFile(golden);
    const json = `${JSON.stringify(golden, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(GOLDEN_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(GOLDEN_BINARY, encoded);
      writeFileSync(GOLDEN_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(GOLDEN_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(GOLDEN_JSON, "utf8")).toBe(json);
  });

  it("decodes the shared golden binary to the same model", () => {
    const decoded = decodeMokaFile(new Uint8Array(readFileSync(GOLDEN_BINARY)));
    expect(normalize(decoded)).toEqual(normalize(buildGoldenMokaFile()));
  });

  it("rejects a bad magic prefix", () => {
    const encoded = encodeMokaFile(buildGoldenMokaFile());
    encoded[0] = 0x00;
    expect(() => decodeMokaFile(encoded)).toThrowError(MokaCodecError);
    try {
      decodeMokaFile(encoded);
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_MAGIC_INVALID");
    }
  });

  it("rejects truncated BSON", () => {
    const encoded = encodeMokaFile(buildGoldenMokaFile());
    const truncated = encoded.slice(0, encoded.length - 8);
    try {
      decodeMokaFile(truncated);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_BSON_INVALID");
    }
  });

  it("rejects an unknown version", () => {
    const golden = buildGoldenMokaFile();
    const tampered = { ...golden, version: "v9" as never };
    const encoded = encodeMokaFile(tampered);
    try {
      decodeMokaFile(encoded);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_VERSION_UNSUPPORTED");
    }
  });

  it("migrates a v1 canvas onto the v2 port table", () => {
    const decoded = decodeMokaFile(encodeMokaFile(buildLegacyV1MokaFile()));
    const canvas = decoded.canvas[0];
    expect(canvas.schemaVersion).toBe(CANVAS_SCHEMA_VERSION);
    expect(canvas.nodes[0].ports.map((p) => p.id)).toEqual([
      "prompt",
      "images",
      "audio",
      "video",
      "out",
      "legacyNote",
    ]);
    expect(canvas.nodes[1].ports.map((p) => p.id)).toEqual([
      "prompt",
      "images",
      "mask",
      "out",
    ]);
    expect(canvas.nodes[0].ports.at(-1)?.label).toBe("Legacy note");
  });

  it("keeps migration idempotent and byte-canonical", () => {
    const once = encodeMokaFile(
      decodeMokaFile(encodeMokaFile(buildLegacyV1MokaFile())),
    );
    const twice = encodeMokaFile(decodeMokaFile(once));
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true);
    expect(normalize(decodeMokaFile(twice))).toEqual(
      normalize(decodeMokaFile(once)),
    );
  });

  it("reads the committed v1 legacy fixture", () => {
    const legacy = encodeMokaFile(buildLegacyV1MokaFile());
    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(LEGACY_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(LEGACY_BINARY, legacy);
    }
    expect(
      Buffer.from(readFileSync(LEGACY_BINARY)).equals(Buffer.from(legacy)),
    ).toBe(true);
    expect(
      normalize(decodeMokaFile(new Uint8Array(readFileSync(LEGACY_BINARY)))),
    ).toEqual(normalize(decodeMokaFile(legacy)));
  });

  it("rejects a canvas schema from the future", () => {
    const golden = buildGoldenMokaFile();
    golden.canvas[0].schemaVersion = CANVAS_SCHEMA_VERSION + 1;
    const encoded = encodeMokaFile(golden);
    try {
      decodeMokaFile(encoded);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_VERSION_UNSUPPORTED");
    }
  });

  it("round-trips generation specs", () => {
    const golden = buildGenerationMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(golden));
    expect(normalize(decoded)).toEqual(normalize(golden));
  });

  /**
   * A media kind has no whitelist entry of its own for the child nodes holding
   * results past the first, so this is what keeps the encoder's shared tail
   * from losing them.
   */
  it("round-trips the extra results a generation leaves on child nodes", () => {
    const golden = buildGenerationMokaFile();
    const canvas = golden.canvas[0];
    const asked = canvas.nodes[1];
    const childId = "00000000-0000-7000-8000-0000000000f1";
    const firstAsset = "00000000-0000-7000-8000-0000000000e1";
    const secondAsset = "00000000-0000-7000-8000-0000000000e2";

    const askedData = asked.data as MediaNodeData;
    askedData.assetId = firstAsset;
    askedData.resultSlots = [
      {
        id: "slot-first",
        status: "succeeded",
        assetId: firstAsset,
        isPrimary: true,
      },
      {
        id: "slot-second",
        status: "succeeded",
        assetId: secondAsset,
        isPrimary: false,
      },
    ];
    askedData.resultNodeIds = [childId];

    canvas.nodes.push({
      id: childId,
      kind: "image",
      title: "Poster (2)",
      bounds: { x: 320, y: 240, width: 280, height: 220 },
      zIndex: 2,
      ports: derivePorts("image"),
      data: { assetId: secondAsset },
      createdAt: asked.createdAt,
      updatedAt: asked.updatedAt,
    });

    const decoded = decodeMokaFile(encodeMokaFile(golden));
    const decodedAsked = decoded.canvas[0].nodes[1].data as MediaNodeData;
    expect(decodedAsked.resultNodeIds).toEqual([childId]);
    expect(decodedAsked.resultSlots?.map((slot) => slot.assetId)).toEqual([
      firstAsset,
      secondAsset,
    ]);
    expect(decoded.canvas[0].nodes[2].id).toBe(childId);
    expect(normalize(decoded)).toEqual(normalize(golden));
  });

  it("rejects a resource path that escapes the project root", () => {
    const golden = buildGoldenMokaFile();
    golden.resources.images[0].path = "../outside.png";
    const encoded = encodeMokaFile(golden);
    try {
      decodeMokaFile(encoded);
      expect.unreachable();
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("PATH_ESCAPE");
    }
  });

  it("enforces the encoded size cap", () => {
    const golden = buildGoldenMokaFile();
    expect(() => encodeMokaFile(golden, 16)).toThrowError(MokaCodecError);
    try {
      encodeMokaFile(golden, 16);
    } catch (error) {
      expect((error as MokaCodecError).code).toBe("MOKA_TOO_LARGE");
    }
  });

  it("round-trips the conversations a canvas carries", () => {
    const carried = buildConversationMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(carried));
    expect(normalize(decoded)).toEqual(normalize(carried));
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so what a conversation
   * looks like on the disk is one contract rather than two opinions about it.
   */
  it("matches the shared conversation fixtures", () => {
    const carried = buildConversationMokaFile();
    const encoded = encodeMokaFile(carried);
    const json = `${JSON.stringify(carried, null, 2)}\n`;

    if (
      process.env.UPDATE_FIXTURES === "1" ||
      !existsSync(CONVERSATION_BINARY)
    ) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(CONVERSATION_BINARY, encoded);
      writeFileSync(CONVERSATION_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(CONVERSATION_BINARY)).equals(
        Buffer.from(encoded),
      ),
    ).toBe(true);
    expect(readFileSync(CONVERSATION_JSON, "utf8")).toBe(json);
  });

  /**
   * The field came in without a schema version of its own, so a document stored
   * before it existed has to read as carrying no conversations and write back
   * unchanged — otherwise opening an old project would quietly rewrite it.
   */
  it("reads a document stored before conversations existed as carrying none", () => {
    const stored = new Uint8Array(readFileSync(GOLDEN_BINARY));
    const decoded = decodeMokaFile(stored);
    expect(decoded.canvas.map((canvas) => canvas.sessions)).toEqual([
      undefined,
      undefined,
    ]);
    expect(
      Buffer.from(encodeMokaFile(decoded)).equals(Buffer.from(stored)),
    ).toBe(true);
  });

  it("round-trips what the shelf says about an asset", () => {
    const shelf = buildShelfMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(shelf));
    expect(normalize(decoded)).toEqual(normalize(shelf));
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so what the shelf looks
   * like on the disk is one contract rather than two opinions about it.
   */
  it("matches the shared shelf fixtures", () => {
    const shelf = buildShelfMokaFile();
    const encoded = encodeMokaFile(shelf);
    const json = `${JSON.stringify(shelf, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(SHELF_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(SHELF_BINARY, encoded);
      writeFileSync(SHELF_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(SHELF_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(SHELF_JSON, "utf8")).toBe(json);
  });

  it("round-trips the canvas tree", () => {
    const tree = buildTreeMokaFile();
    const decoded = decodeMokaFile(encodeMokaFile(tree));
    expect(normalize(decoded)).toEqual(normalize(tree));
  });

  /**
   * The shared pair the other language reads: it decodes the binary to this
   * model and writes the binary back byte for byte, so where a board sits in
   * the tree is one contract rather than two opinions about it.
   */
  it("matches the shared tree fixtures", () => {
    const tree = buildTreeMokaFile();
    const encoded = encodeMokaFile(tree);
    const json = `${JSON.stringify(tree, null, 2)}\n`;

    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(TREE_BINARY)) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(TREE_BINARY, encoded);
      writeFileSync(TREE_JSON, json);
    }

    expect(
      Buffer.from(readFileSync(TREE_BINARY)).equals(Buffer.from(encoded)),
    ).toBe(true);
    expect(readFileSync(TREE_JSON, "utf8")).toBe(json);
  });

  it("reads an asset stored before the shelf existed as saying nothing", () => {
    const stored = new Uint8Array(readFileSync(GOLDEN_BINARY));
    const decoded = decodeMokaFile(stored);
    const said = decoded.resources.images[0];
    expect([
      said.tags,
      said.note,
      said.favorite,
      said.origin,
      said.keyword,
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(
      Buffer.from(encodeMokaFile(decoded)).equals(Buffer.from(stored)),
    ).toBe(true);
  });

  /**
   * A word the shelf does not know is written back as it was read rather than
   * dropped: validation is the one that says it is wrong, and quietly rewriting
   * a document to agree with a newer vocabulary would lose what it had in it.
   */
  it("carries an origin outside the vocabulary through unchanged", () => {
    const shelf = buildShelfMokaFile();
    const entry: { origin?: string } = shelf.resources.images[0];
    entry.origin = "inherited";
    const decoded = decodeMokaFile(encodeMokaFile(shelf));
    expect(decoded.resources.images[0].origin).toBe("inherited");
  });
});
