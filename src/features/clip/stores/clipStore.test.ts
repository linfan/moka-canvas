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
  rememberedView,
  useClipStore,
} from "./clipStore";
import { msAt } from "../timeline/geometry";

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
    mediaSelection: null,
    newTimelineOpen: false,
    view: { pxPerSec: 60, scrollLeftPx: 0 },
    playheadMs: 0,
    viewportPx: 0,
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

  it("keeps the shelf's chosen file apart from the timeline's own choice", () => {
    store().selectMedia("asset-a");
    store().select({ clipIds: ["clip-a"] });
    expect(store().mediaSelection).toBe("asset-a");
    expect(store().selection.clipIds).toEqual(["clip-a"]);
    store().selectMedia(null);
    expect(store().mediaSelection).toBeNull();
    expect(store().selection.clipIds).toEqual(["clip-a"]);
  });
});

describe("how the timeline is looked at", () => {
  /** A project with one timeline open on the store. */
  function openOne(): MokaFile {
    const moka = project("p1", 1);
    open(moka);
    store().setActiveTimeline(moka.timelines![0].id);
    store().setViewportPx(800);
    return moka;
  }

  it("zooms by a step of one and a half and stops at the limits", () => {
    openOne();
    expect(store().view.pxPerSec).toBe(60);

    store().zoomBy(1.5);
    expect(store().view.pxPerSec).toBe(90);
    store().zoomBy(1 / 1.5);
    expect(store().view.pxPerSec).toBe(60);

    store().zoomTo(10_000);
    expect(store().view.pxPerSec).toBe(960);
    store().zoomTo(0.1);
    expect(store().view.pxPerSec).toBe(4);
  });

  it("holds the playhead where it stands when it is on screen", () => {
    openOne();
    store().setPlayhead(5_000);
    store().zoomTo(90);
    expect(store().view).toEqual({ pxPerSec: 90, scrollLeftPx: 50 });
    // The playhead sits exactly where it sat: 400px into an 800px screen.
    expect(
      (5_000 / 1_000) * store().view.pxPerSec - store().view.scrollLeftPx,
    ).toBe(400);
  });

  it("zooms about the middle of the screen when the playhead is out of sight", () => {
    openOne();
    store().setView({ scrollLeftPx: 2_000 });
    const anchor = msAt(400, { pxPerSec: 60, scrollLeftPx: 2_000 });
    store().zoomTo(30);
    // 40s of anchor at 30px/s wants an 800px offset; 34s of content stop it at 220.
    expect(store().view).toEqual({ pxPerSec: 30, scrollLeftPx: 220 });
    expect((anchor / 1_000) * 30 - 220).toBeCloseTo(980);
  });

  it("clamps what a hand sets on the view", () => {
    openOne();
    store().setView({ pxPerSec: 1, scrollLeftPx: -20 });
    expect(store().view).toEqual({ pxPerSec: 4, scrollLeftPx: 0 });
  });

  it("fits the whole cut on screen", () => {
    openOne();
    store().fit(800, 30_000);
    expect(store().view.pxPerSec).toBeCloseTo(800 / 30, 2);
    expect(store().view.scrollLeftPx).toBe(0);
    // Nothing to fit, nothing to do.
    store().zoomTo(120);
    store().fit(0, 30_000);
    expect(store().view.pxPerSec).toBe(120);
  });

  it("remembers each timeline's own view and playhead, on this machine", () => {
    const moka = project("p1", 2);
    open(moka);
    const [first, second] = moka.timelines!;

    store().setActiveTimeline(first.id);
    store().setPlayhead(4_321);
    store().zoomTo(120);
    store().setView({ scrollLeftPx: 90 });

    store().setActiveTimeline(second.id);
    expect(store().view).toEqual({ pxPerSec: 60, scrollLeftPx: 0 });
    expect(store().playheadMs).toBe(0);
    store().zoomTo(240);

    store().setActiveTimeline(first.id);
    expect(store().view).toEqual({ pxPerSec: 120, scrollLeftPx: 90 });
    expect(store().playheadMs).toBe(4_321);

    // Written down by id, and nothing about a view goes into the document.
    expect(
      JSON.parse(localStorage.getItem(`moka-canvas:clip-view:${first.id}`)!),
    ).toEqual({ pxPerSec: 120, scrollLeftPx: 90, playheadMs: 4_321 });
    expect(localStorage.getItem("moka-canvas:clip-view:p1")).toBeNull();
  });

  it("starts a timeline it has never seen at the default", () => {
    openOne();
    expect(rememberedView("fresh")).toBeNull();
    expect(store().view).toEqual({ pxPerSec: 60, scrollLeftPx: 0 });
  });

  it("takes nothing from a view store holding something else", () => {
    localStorage.setItem("moka-canvas:clip-view:t1", "{not json");
    expect(rememberedView("t1")).toBeNull();
    localStorage.setItem(
      "moka-canvas:clip-view:t1",
      JSON.stringify({ pxPerSec: "90", scrollLeftPx: -5, playheadMs: -2 }),
    );
    expect(rememberedView("t1")).toEqual({
      view: { pxPerSec: 60, scrollLeftPx: 0 },
      playheadMs: 0,
    });
    localStorage.setItem(
      "moka-canvas:clip-view:t1",
      JSON.stringify({ pxPerSec: 20_000, scrollLeftPx: 12 }),
    );
    expect(rememberedView("t1")).toEqual({
      view: { pxPerSec: 960, scrollLeftPx: 12 },
      playheadMs: 0,
    });
  });

  it("holds the playhead at the head rather than before it", () => {
    openOne();
    store().setPlayhead(-25);
    expect(store().playheadMs).toBe(0);
    store().setPlayhead(Number.NaN);
    expect(store().playheadMs).toBe(0);
  });
});
