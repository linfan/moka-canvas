// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createTimeline } from "../../../shared/domain";
import type { MokaFile } from "../../../shared/domain";
import { buildGoldenMokaFile } from "../../../shared/domain/fixtures";
import { useProjectStore } from "../../editor/stores/projectStore";
import {
  initialTimelineId,
  rememberTimelineId,
  rememberedTimelineId,
  useClipStore,
} from "./clipStore";

/** A project of its own name holding the given number of timelines. */
function project(id: string, timelines: number): MokaFile {
  const moka = buildGoldenMokaFile();
  return {
    ...moka,
    metadata: { ...moka.metadata, id },
    timelines: Array.from({ length: timelines }, (_, index) =>
      createTimeline(`Timeline ${index + 1}`),
    ),
  };
}

function open(moka: MokaFile) {
  useProjectStore.getState().hydrate({
    moka,
    root: `/tmp/${moka.metadata.id}`,
    selfCheck: { ok: true, issues: [] },
  });
}

function store() {
  return useClipStore.getState();
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.getState().close();
  useClipStore.setState({
    activeTimelineId: null,
    face: "local",
    selection: { clipIds: [], transitionId: null },
    newTimelineOpen: false,
  });
});

describe("which timeline a project opens onto", () => {
  it("opens onto the first timeline when nothing is remembered", () => {
    const moka = project("p1", 2);
    expect(rememberedTimelineId("p1")).toBeNull();
    expect(initialTimelineId(moka)).toBe(moka.timelines![0].id);
  });

  it("opens onto the timeline this machine was left on", () => {
    const moka = project("p1", 2);
    rememberTimelineId("p1", moka.timelines![1].id);
    expect(initialTimelineId(moka)).toBe(moka.timelines![1].id);
  });

  it("falls back to the first when the remembered one left the document", () => {
    const moka = project("p1", 2);
    rememberTimelineId("p1", "timeline-gone");
    expect(initialTimelineId(moka)).toBe(moka.timelines![0].id);
  });

  it("has nothing to open onto in a document without timelines", () => {
    expect(initialTimelineId(project("p1", 0))).toBeNull();
  });

  it("keeps one project's timeline out of another's", () => {
    const first = project("p1", 2);
    const second = project("p2", 2);
    rememberTimelineId("p1", first.timelines![1].id);
    expect(initialTimelineId(second)).toBe(second.timelines![0].id);
    expect(rememberedTimelineId("p2")).toBeNull();
  });

  it("takes nothing from a store holding something else", () => {
    localStorage.setItem(
      "moka-canvas:clip-timeline:p1",
      JSON.stringify({ id: "x" }),
    );
    expect(rememberedTimelineId("p1")).toBeNull();
    localStorage.setItem("moka-canvas:clip-timeline:p1", "{not json");
    expect(rememberedTimelineId("p1")).toBeNull();
    localStorage.setItem("moka-canvas:clip-timeline:p1", JSON.stringify(""));
    expect(rememberedTimelineId("p1")).toBeNull();
  });
});

describe("what the cutting room is looking at", () => {
  it("remembers the switch for the project it was made in", () => {
    const moka = project("p1", 2);
    open(moka);
    store().setActiveTimeline(moka.timelines![1].id);
    expect(
      JSON.parse(localStorage.getItem("moka-canvas:clip-timeline:p1")!),
    ).toBe(moka.timelines![1].id);
  });

  it("forgets the place when there is no timeline to be at", () => {
    const moka = project("p1", 2);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    store().setActiveTimeline(null);
    expect(localStorage.getItem("moka-canvas:clip-timeline:p1")).toBeNull();
    expect(store().activeTimelineId).toBeNull();
  });

  it("turns the column to the face it was asked for", () => {
    expect(store().face).toBe("local");
    store().setFace("filters");
    expect(store().face).toBe("filters");
  });

  it("merges a selection patch rather than replacing the choice", () => {
    store().select({ clipIds: ["clip-a"] });
    store().select({ transitionId: "transition-a" });
    expect(store().selection).toEqual({
      clipIds: ["clip-a"],
      transitionId: "transition-a",
    });
    store().select({ clipIds: [] });
    expect(store().selection).toEqual({
      clipIds: [],
      transitionId: "transition-a",
    });
  });

  it("opens and closes the new-timeline question", () => {
    expect(store().newTimelineOpen).toBe(false);
    store().setNewTimelineOpen(true);
    expect(store().newTimelineOpen).toBe(true);
    store().setNewTimelineOpen(false);
    expect(store().newTimelineOpen).toBe(false);
  });
});
