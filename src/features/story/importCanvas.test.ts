import { beforeEach, describe, expect, it } from "vitest";

import { applyCommands } from "../../shared/domain/commands";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
} from "../../shared/domain/fixtures";
import type {
  CanvasDocument,
  MokaFile,
  StoryDocument,
  WorkflowNode,
} from "../../shared/domain";
import { useModelStore } from "../settings/modelStore";
import { planKeyframeArt, planOutline, planStoryboard } from "./jobs/plan";
import {
  canvasImportCounts,
  hasCanvasImport,
  planStoryCanvas,
} from "./importCanvas";

const ids = storyIds();

function fixture(): { moka: MokaFile; story: StoryDocument } {
  const moka = buildStoryMokaFile();
  const story = moka.stories?.[0];
  if (story === undefined) throw new Error("the fixture holds a story");
  return { moka, story };
}

function board(): {
  moka: MokaFile;
  story: StoryDocument;
  canvas: CanvasDocument;
} {
  const { moka, story } = fixture();
  return { moka, story, canvas: planStoryCanvas(story, moka, "雨夜列车") };
}

/** The card a title names, which the import gives one of. */
function card(canvas: CanvasDocument, title: string): WorkflowNode {
  const found = canvas.nodes.find((node) => node.title === title);
  if (found === undefined) {
    throw new Error(
      `no card “${title}” among ${canvas.nodes.map((node) => node.title).join(", ")}`,
    );
  }
  return found;
}

/** Whether two cards are joined the way the telling joins them. */
function joined(
  canvas: CanvasDocument,
  from: WorkflowNode,
  to: WorkflowNode,
  portId: string,
): boolean {
  return canvas.edges.some(
    (edge) =>
      edge.source.nodeId === from.id &&
      edge.target.nodeId === to.id &&
      edge.target.portId === portId,
  );
}

beforeEach(() => {
  useModelStore.setState({ view: null });
});

describe("the board a telling makes", () => {
  it("holds every piece the steps generated, naming the files already on the shelf", () => {
    const { canvas } = board();
    // The premise and both episodes, the act and its two shots.
    expect(card(canvas, "Premise").data).toMatchObject({
      content: "末班列车上，两个陌生人交换了各自要说的话。",
    });
    expect(card(canvas, "1. 第一章 站台").data).toMatchObject({
      content: "他在站台上等一班已经停运的列车。",
    });
    expect(card(canvas, "1.1 第 1 幕 空站台").data).toMatchObject({
      content: "站台上的灯一盏一盏亮起来。",
    });
    // The words of a shot are what it shows and what is said in it — written
    // without the backticks that mark a mention, which are the room's own.
    expect(card(canvas, "1.1.1").data).toMatchObject({
      content: "雨中的站台，林立在灯下。\n林：车已经停运了。（平静）",
    });
    expect(card(canvas, "2. 第二章 车厢")).toBeDefined();
    // The drawings and the clip are the shelf's own files, read through the
    // takes the story keeps, and never copies of them.
    const shelf = new Set([
      ...fixture().moka.resources.images.map((entry) => entry.id),
      ...fixture().moka.resources.videos.map((entry) => entry.id),
    ]);
    const held = canvas.nodes.flatMap((node) => {
      const assetId = (node.data as { assetId?: string }).assetId;
      return assetId === undefined ? [] : [assetId];
    });
    expect(held).toEqual(
      expect.arrayContaining([
        ids.heroMain,
        ids.heroSheet,
        ids.partnerMain,
        ids.sceneMain,
        ids.frameArt,
        ids.actVideo,
      ]),
    );
    for (const assetId of held) expect(shelf.has(assetId)).toBe(true);
    // A character drawn twice is one card each; an element never drawn is
    // described and nothing more.
    expect(card(canvas, "林")).toBeDefined();
    expect(card(canvas, "林 · main")).toBeDefined();
    expect(card(canvas, "林 · turn-around")).toBeDefined();
    expect(card(canvas, "周")).toBeDefined();
    expect(card(canvas, "1.1.1 · frame")).toBeDefined();
    expect(card(canvas, "1.1 · clip")).toBeDefined();
  });

  it("joins every card to what it was made from", () => {
    const { canvas } = board();
    const premise = card(canvas, "Premise");
    const chapter = card(canvas, "1. 第一章 站台");
    const act = card(canvas, "1.1 第 1 幕 空站台");
    const shot = card(canvas, "1.1.1");
    const frame = card(canvas, "1.1.1 · frame");
    const clip = card(canvas, "1.1 · clip");

    expect(joined(canvas, premise, chapter, "prompt")).toBe(true);
    expect(joined(canvas, chapter, act, "prompt")).toBe(true);
    expect(joined(canvas, act, shot, "prompt")).toBe(true);
    expect(joined(canvas, shot, frame, "prompt")).toBe(true);
    expect(joined(canvas, act, clip, "prompt")).toBe(true);
    // The frame was drawn from the picture its own words named, and the clip
    // starts from the frame — the wires an ask's own references make. A name
    // the words do not mention is not wired, however drawn it is.
    expect(joined(canvas, card(canvas, "林 · main"), frame, "images")).toBe(
      true,
    );
    expect(joined(canvas, card(canvas, "周 · main"), frame, "images")).toBe(
      false,
    );
    // The clip's ask travels with its pictures as references — no frame has
    // been given a shoot role — so the wire runs into the images port, the
    // same one a frame's own drawn-from pictures use.
    expect(joined(canvas, frame, clip, "images")).toBe(true);
    expect(joined(canvas, frame, clip, "firstFrame")).toBe(false);
    // A turn-around is drawn from the one picture of the character there is.
    expect(
      joined(
        canvas,
        card(canvas, "林 · main"),
        card(canvas, "林 · turn-around"),
        "images",
      ),
    ).toBe(true);
  });

  it("wires a clip the way the shoot role of its piece says its pictures travel", () => {
    const { moka, story } = fixture();
    story.chapters[0].acts[0].keyframes[0].filmRole = "firstFrame";
    const canvas = planStoryCanvas(story, moka, "雨夜列车");
    const frame = card(canvas, "1.1.1 · frame");
    const clip = card(canvas, "1.1 · clip");

    // A frame marked as a first frame opens a piece of its own, and the wire
    // runs into the port that role names rather than into the images port.
    expect(joined(canvas, frame, clip, "firstFrame")).toBe(true);
    expect(joined(canvas, frame, clip, "images")).toBe(false);
  });

  it("carries the ask each card was made with", () => {
    const { moka, story, canvas } = board();
    const asked = (node: WorkflowNode) =>
      (
        node.data as {
          generation?: {
            prompt: string;
            params: Record<string, unknown>;
            inputMode: string;
          };
        }
      ).generation;

    expect(asked(card(canvas, "Premise"))?.prompt).toBe(
      planOutline(story, { mode: "expand", chapters: 2 })[0]?.prompt,
    );
    // The standing instruction a written answer was asked under rides in the
    // parameters, where a text ask carries the framing of its answer.
    expect(asked(card(canvas, "Premise"))?.params.instructions).toBe(
      planOutline(story, { mode: "expand", chapters: 2 })[0]?.system,
    );
    expect(asked(card(canvas, "1. 第一章 站台"))?.prompt).toBe(
      planStoryboard(story, [ids.chapterFirst])[0]?.prompt,
    );
    const frameAsk = planKeyframeArt(story, [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ])[0];
    expect(asked(card(canvas, "1.1.1 · frame"))?.prompt).toBe(frameAsk?.prompt);
    expect(asked(card(canvas, "1.1.1 · frame"))?.params).toEqual(
      frameAsk?.params,
    );
    // Everything wired into a card is what its ask was made of.
    expect(asked(card(canvas, "1.1.1 · frame"))?.inputMode).toBe("upstream");
    // A card of words that nothing was asked for carries no ask at all.
    expect(asked(card(canvas, "1.1.1"))).toBeUndefined();
    expect(asked(card(canvas, "1.1.1 · frame"))?.prompt).toContain("林");
    expect(moka.stories?.[0]).toBe(story);
  });

  it("is a canvas the document takes as it stands", () => {
    const { moka, canvas } = board();
    const applied = applyCommands(moka, [{ type: "addCanvas", canvas }]);
    expect(applied.next.canvas).toHaveLength(moka.canvas.length + 1);
    // Cards that share a row never overlap, and neither do the rows.
    const boxes = canvas.nodes.map((node) => node.bounds);
    for (let one = 0; one < boxes.length; one += 1) {
      for (let other = one + 1; other < boxes.length; other += 1) {
        const a = boxes[one];
        const b = boxes[other];
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart).toBe(true);
      }
    }
    // The board also says where it wants to be looked at from: a point it
    // covers, held whole rather than magnified past its own size.
    const xs = boxes.flatMap((box) => [box.x, box.x + box.width]);
    const ys = boxes.flatMap((box) => [box.y, box.y + box.height]);
    expect(canvas.viewport.x).toBeGreaterThan(Math.min(...xs));
    expect(canvas.viewport.x).toBeLessThan(Math.max(...xs));
    expect(canvas.viewport.y).toBeGreaterThan(Math.min(...ys));
    expect(canvas.viewport.y).toBeLessThan(Math.max(...ys));
    expect(canvas.viewport.zoom).toBeLessThanOrEqual(1);
  });

  it("counts what there is to import, and says when there is nothing", () => {
    const { story } = fixture();
    expect(canvasImportCounts(story)).toEqual({
      chapters: 2,
      elements: 4,
      pictures: 5,
      clips: 1,
      sounds: 0,
    });
    expect(hasCanvasImport(story)).toBe(true);
    const empty = buildEmptyStory();
    expect(hasCanvasImport(empty.stories![0])).toBe(false);
    expect(planStoryCanvas(empty.stories![0], empty, "新的故事").nodes).toEqual(
      [],
    );
  });
});
