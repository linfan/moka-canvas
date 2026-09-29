import { describe, expect, it } from "vitest";
import type { MokaFile, ResourceEntry } from "../../../shared/domain";
import { buildShelfMokaFile } from "../../../shared/domain/fixtures";
import { isUnplaced, unplacedEntries } from "./unplaced";

const POEM = "opening-lines.md";

/** The shelf fixture: one brought picture a card holds, one brought text nobody does. */
function shelf(): MokaFile {
  return buildShelfMokaFile();
}

function entryNamed(moka: MokaFile, name: string): ResourceEntry {
  const all = Object.values(moka.resources).flat();
  const found = all.find((entry) => entry.name === name);
  if (!found) throw new Error(`no entry named ${name}`);
  return found;
}

describe("the tray above a scoped shelf", () => {
  it("keeps a file a card holds out of it", () => {
    const moka = shelf();
    const picture = moka.resources.images[0];
    expect(isUnplaced(new Set([picture.id]), picture)).toBe(false);
    expect(unplacedEntries(moka, "image").map((entry) => entry.id)).toEqual([]);
  });

  it("holds a brought file nothing points at", () => {
    const moka = shelf();
    const waiting = entryNamed(moka, POEM);
    expect(isUnplaced(new Set(), waiting)).toBe(true);
    expect(unplacedEntries(moka, "text").map((entry) => entry.id)).toContain(
      waiting.id,
    );
  });

  it("reads only the kind it was asked about", () => {
    const moka = shelf();
    const waiting = entryNamed(moka, POEM);
    expect(
      unplacedEntries(moka, "image").map((entry) => entry.id),
    ).not.toContain(waiting.id);
    expect(unplacedEntries(moka, "video")).toEqual([]);
  });

  it("leaves a made file out even when nothing holds it", () => {
    const moka = shelf();
    moka.resources.texts.push({
      id: "asset-made-text",
      name: "made.md",
      path: "assets/texts/made-00000000.md",
      mime: "text/markdown",
      bytes: 12,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      provenance: { createdAt: "2026-01-01T00:00:00.000Z", runId: "run-1" },
    });
    expect(
      unplacedEntries(moka, "text").map((entry) => entry.id),
    ).not.toContain("asset-made-text");
  });

  it("reads newest first, since the tray is what just arrived", () => {
    const moka = shelf();
    moka.resources.texts.push(
      {
        id: "asset-old",
        name: "old.md",
        path: "assets/texts/old-00000000.md",
        mime: "text/markdown",
        bytes: 4,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "asset-new",
        name: "new.md",
        path: "assets/texts/new-00000000.md",
        mime: "text/markdown",
        bytes: 4,
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    );
    const ids = unplacedEntries(moka, "text").map((entry) => entry.id);
    expect(ids.indexOf("asset-new")).toBeLessThan(ids.indexOf("asset-old"));
  });
});
