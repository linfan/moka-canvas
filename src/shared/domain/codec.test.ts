import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "./constants";
import {
  buildGenerationMokaFile,
  buildGoldenMokaFile,
  buildLegacyV1MokaFile,
} from "./fixtures";
import { decodeMokaFile, encodeMokaFile, MokaCodecError } from "./codec";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures",
);
const GOLDEN_JSON = join(FIXTURE_DIR, "minimal.moka.json");
const GOLDEN_BINARY = join(FIXTURE_DIR, "minimal.canvas.moka");
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
});
