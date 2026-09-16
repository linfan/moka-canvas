// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { AssetId, ResourceEntry } from "../../../shared/domain";
import {
  noteVideoPaused,
  noteVideoPlaying,
  previewKindOf,
  stopMediaPreview,
  stopMediaPreviewFor,
  toggleMediaPreview,
  useMediaPreview,
  type MediaPreview,
} from "./mediaPreview";

/**
 * The element the module makes, stood in for: a play settles rather than
 * reaching a browser that is not here, and nothing else is asked of it.
 */
class FakeAudio {
  src = "";
  addEventListener(): void {}
  load(): void {}
  pause(): void {}
  play(): Promise<void> {
    return Promise.resolve();
  }
}
vi.stubGlobal("Audio", FakeAudio);

/** A row on the shelf, with what the preview reads: an id and a mime. */
function entry(id: AssetId, mime: string | undefined): ResourceEntry {
  return {
    id,
    name: `${id}.bin`,
    path: `assets/images/${id}.bin`,
    mime,
    bytes: 64,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** The state as a mounted reader sees it. */
function current(): MediaPreview {
  return renderHook(() => useMediaPreview()).result.current;
}

beforeEach(() => stopMediaPreview());
afterEach(() => cleanup());

describe("reading a row's kind", () => {
  it("tells the two files that can be tried from the ones that cannot", () => {
    expect(previewKindOf(entry("tone", "audio/wav"))).toBe("audio");
    expect(previewKindOf(entry("clip", "video/mp4"))).toBe("video");
    expect(previewKindOf(entry("picture", "image/png"))).toBeNull();
    expect(previewKindOf(entry("mystery", undefined))).toBeNull();
  });
});

describe("one file at a time", () => {
  it("starts a sound, stops it where it stands, and carries on from there", () => {
    toggleMediaPreview("tone", "audio");
    expect(current()).toEqual({
      assetId: "tone",
      kind: "audio",
      playing: true,
    });
    toggleMediaPreview("tone", "audio");
    expect(current()).toEqual({
      assetId: "tone",
      kind: "audio",
      playing: false,
    });
    toggleMediaPreview("tone", "audio");
    expect(current().playing).toBe(true);
  });

  it("leaves one sound standing when another row asks", () => {
    toggleMediaPreview("tone", "audio");
    toggleMediaPreview("other", "audio");
    expect(current()).toEqual({
      assetId: "other",
      kind: "audio",
      playing: true,
    });
  });

  it("gives the sound way to a video, and the video way to a sound", () => {
    toggleMediaPreview("tone", "audio");
    toggleMediaPreview("clip", "video");
    expect(current()).toEqual({
      assetId: "clip",
      kind: "video",
      playing: true,
    });
    toggleMediaPreview("tone", "audio");
    expect(current()).toEqual({
      assetId: "tone",
      kind: "audio",
      playing: true,
    });
  });

  it("keeps a video's mark true when the card's own controls move", () => {
    toggleMediaPreview("clip", "video");
    noteVideoPaused("clip");
    expect(current().playing).toBe(false);
    noteVideoPlaying("clip");
    expect(current()).toEqual({
      assetId: "clip",
      kind: "video",
      playing: true,
    });
    // Another file's card reporting itself says nothing about this one.
    noteVideoPaused("elsewhere");
    expect(current().playing).toBe(true);
  });

  it("stops only the file a leaving card was showing", () => {
    toggleMediaPreview("clip", "video");
    stopMediaPreviewFor("elsewhere");
    expect(current().assetId).toBe("clip");
    stopMediaPreviewFor("clip");
    expect(current().assetId).toBeNull();
  });
});
