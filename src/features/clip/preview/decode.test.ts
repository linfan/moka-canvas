// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetId } from "../../../shared/domain";
import { elementOnlyReason, isElementOnly, mp4IndexFor } from "./decode";

/**
 * What a reader is told when a file cannot be decoded.
 *
 * The stage falls back to the element engine either way, so what this layer
 * owes anybody is the sentence under the notice — the parser's own complaint
 * where there is a parser to have one — and the promise not to keep asking.
 */

const notAnMp4 = (id: string) => id as AssetId;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(new Uint8Array([0, 0, 0, 4, 0x6a, 0x75, 0x6e, 0x6b]), {
        status: 200,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an asset the decoder gave up on", () => {
  it("keeps the parser's complaint, and does not ask a second time", async () => {
    const assetId = notAnMp4("asset-not-an-mp4");

    expect(await mp4IndexFor(assetId)).toBeNull();
    expect(isElementOnly(assetId)).toBe(true);
    const said = elementOnlyReason(assetId);
    expect(said).toBeTruthy();
    expect(said).not.toContain("undefined");

    // Ruled out for the session: the elements own it now, and the reason it
    // was handed over is still there to be said.
    await mp4IndexFor(assetId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(elementOnlyReason(assetId)).toBe(said);
  });

  it("says nothing about an asset nobody has tried to decode", () => {
    const assetId = notAnMp4("asset-not-looked-at");

    expect(isElementOnly(assetId)).toBe(false);
    expect(elementOnlyReason(assetId)).toBeUndefined();
  });
});
