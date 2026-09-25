import { beforeEach, describe, expect, it } from "vitest";

import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryDocument } from "../../../shared/domain/types";
import { useModelStore } from "../../settings/modelStore";
import {
  clampSeconds,
  imageSizeForAspect,
  itemsForTargets,
  jobKey,
  planActVideos,
  planElementArt,
  planElements,
  planKeyframeArt,
  planKeyframeVideos,
  planOutline,
  planStoryboard,
} from "./plan";

const ids = storyIds();

function story(): StoryDocument {
  const held = buildStoryMokaFile().stories?.[0];
  if (held === undefined) throw new Error("the fixture holds a story");
  return held;
}

/** A story whose first act has both of its shots drawn. */
function drawnStory(): StoryDocument {
  const held = story();
  const act = held.chapters[0].acts[0];
  const second = act.keyframes[1];
  return {
    ...held,
    chapters: held.chapters.map((chapter) => ({
      ...chapter,
      acts: chapter.acts.map((heldAct) =>
        heldAct.id !== act.id
          ? heldAct
          : {
              ...heldAct,
              keyframes: heldAct.keyframes.map((keyframe) =>
                keyframe.id !== second.id
                  ? keyframe
                  : {
                      ...keyframe,
                      art: {
                        takes: [
                          {
                            assetId: "asset-frame-second",
                            createdAt: "2026-01-01T00:00:00Z",
                          },
                        ],
                        confirmed: false,
                      },
                    },
              ),
            },
      ),
    })),
  };
}

beforeEach(() => {
  useModelStore.setState({ view: null });
});

describe("the two numbers a plan turns on", () => {
  it("asks a picture for the size closest to the frame", () => {
    expect(imageSizeForAspect("16:9")).toBe("1536x1024");
    expect(imageSizeForAspect("21:9")).toBe("1536x1024");
    expect(imageSizeForAspect("4:3")).toBe("1536x1024");
    expect(imageSizeForAspect("9:16")).toBe("1024x1536");
    expect(imageSizeForAspect("1:1")).toBe("1024x1024");
  });

  it("asks a clip for what it is meant to run, up to the ceiling", () => {
    expect(clampSeconds(4_400)).toBe(4);
    expect(clampSeconds(0)).toBe(1);
    expect(clampSeconds(120_000, 8)).toBe(8);
  });

  it("names a piece after the place it is for", () => {
    expect(
      jobKey({
        kind: "keyframeArt",
        chapterId: "chapter-1",
        actId: "act-1",
        keyframeId: "frame-1",
      }),
    ).toBe("keyframe:chapter-1:act-1:frame-1");
    expect(jobKey({ kind: "elements" })).toBe("elements");
    expect(
      jobKey({
        kind: "elementArt",
        elementId: "element-hero",
        view: "main",
      }),
    ).toBe("element:main:element-hero");
  });
});

describe("planning the words", () => {
  it("asks for the telling as chapters, from the premise as typed", () => {
    const items = planOutline(story(), { mode: "expand", chapters: 2 });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("outline");
    expect(items[0].capability).toBe("text");
    expect(items[0].target).toEqual({ kind: "outline" });
    expect(items[0].prompt).toContain(
      "末班列车上，两个陌生人交换了各自要说的话。",
    );
    expect(items[0].prompt).toContain("Write this telling as 2 chapters.");
    expect(items[0].prompt).toContain("16:9");
    expect(items[0].prompt).toContain("对白剧情");
    expect(items[0].prompt).toContain("2:00");
    expect(items[0].prompt).not.toContain("{{");
  });

  it("asks for each part of a manuscript on its own, numbered in order", () => {
    const items = planOutline(story(), {
      mode: "split",
      chapters: 2,
      chunks: [
        { title: "第一章", text: "他在站台上等一班已经停运的列车。" },
        { title: "第二章", text: "车厢比站台更暗。" },
      ],
    });

    // The number on the piece is the place in the telling its answer belongs,
    // so the parts are in the order the manuscript was read in.
    expect(items.map((item) => item.id)).toEqual(["outline:1", "outline:2"]);
    expect(items[0].prompt).toContain("Part 1 of 2");
    expect(items[1].prompt).toContain("Part 2 of 2");
    expect(items[1].prompt).toContain("车厢比站台更暗。");
    // A chapter is asked for under the name the manuscript gave it.
    expect(items[0].prompt).toContain("第一章");
    expect(items[1].prompt).toContain("第二章");
  });

  it("asks what the telling is made of, chapter by chapter", () => {
    const items = planElements(story());

    expect(items[0].id).toBe("elements");
    expect(items[0].target).toEqual({ kind: "elements" });
    expect(items[0].prompt).toContain(
      "1. 第一章 站台 — 他在站台上等一班已经停运的列车。",
    );
    expect(items[0].prompt).toContain("2. 第二章 车厢 — 车厢比站台更暗。");
    // Reading the whole telling is one ask, and it is not numbered as a part.
    expect(items[0].prompt).not.toContain("This is part");
  });

  it("reads a long telling a part at a time, and says which part it is", () => {
    const items = planElements(story(), {
      chapterIds: [ids.chapterSecond],
      part: 2,
      total: 3,
    });

    // The piece is numbered the way a manuscript's parts are, so the answer
    // comes home to the part that asked for it.
    expect(items[0].id).toBe("elements:2");
    expect(items[0].prompt).toContain("This is part 2 of 3 of the telling");
    // Only the chapters this part is for are listed, counted from one.
    expect(items[0].prompt).toContain("1. 第二章 车厢 — 车厢比站台更暗。");
    expect(items[0].prompt).not.toContain("第一章 站台");
  });

  it("asks for a board with the names the story holds", () => {
    const items = planStoryboard(story(), [ids.chapterFirst]);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`storyboard:${ids.chapterFirst}`);
    expect(items[0].capability).toBe("text");
    expect(items[0].prompt).toContain("Chapter 1 of the telling: 第一章 站台");
    expect(items[0].prompt).toContain("- 林 (character)");
    expect(items[0].prompt).toContain("- 末班车车厢 (scene)");
    // The list the framing is chosen from is the list the parser reads.
    expect(items[0].prompt).toContain("mediumClose");
    expect(items[0].prompt).toContain("pushIn");
    expect(items[0].prompt).toContain("eyeLevel");
  });

  it("asks for no board of a chapter the story does not have", () => {
    expect(planStoryboard(story(), ["chapter-gone"])).toEqual([]);
  });
});

describe("planning the drawings", () => {
  it("asks for a character's main picture in the frame of the film", () => {
    const items = planElementArt(story(), [
      { elementId: ids.hero, view: "main" },
    ]);

    expect(items[0].id).toBe(`element:main:${ids.hero}`);
    expect(items[0].capability).toBe("image");
    expect(items[0].params).toEqual({ size: "1536x1024" });
    expect(items[0].inputs).toEqual([]);
    expect(items[0].prompt).toContain("林");
    expect(items[0].prompt).toContain("现代都市风");
  });

  it("draws a turn-around from the picture the character already has", () => {
    const items = planElementArt(story(), [
      { elementId: ids.hero, view: "turnaround" },
    ]);

    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.heroMain },
    ]);
    expect(items[0].prompt).toContain("four views");
  });

  it("plans no turn-around for a character nobody has drawn", () => {
    const items = planElementArt(story(), [
      { elementId: ids.prop, view: "turnaround" },
    ]);
    expect(items).toEqual([]);
  });

  it("draws a frame with its act's cast, in the order the pictures travel", () => {
    const items = planKeyframeArt(story(), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);

    expect(items[0].id).toBe(
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
    expect(items[0].capability).toBe("image");
    // The cast is what the act names and the story has a picture of, in the
    // order the prompt numbers them: characters, then the place, then things.
    expect(items[0].inputs).toEqual([
      { role: "reference", assetId: ids.heroMain },
      { role: "reference", assetId: ids.partnerMain },
      { role: "reference", assetId: ids.sceneMain },
    ]);
    expect(items[0].prompt).toContain("1. 林 —");
    expect(items[0].prompt).toContain("2. 周 —");
    expect(items[0].prompt).toContain("3. 末班车车厢 —");
    // The prop has no drawing, so it is not numbered as a reference.
    expect(items[0].prompt).not.toContain("旧车票");
  });

  it("writes a scene into the prompt and leaves it out of the pictures", () => {
    // A place is drawn like anything else, so it travels as a reference;
    // what must not happen is a numbered reference with no picture behind it.
    const items = planKeyframeArt(story(), [
      {
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
    ]);
    const numbered = (
      items[0].prompt.split("in the order they are given:")[1] ?? ""
    )
      .split("\n")
      .filter((line) => /^\d+\./.test(line.trim()));
    expect(numbered.length).toBe(items[0].inputs?.length);
  });

  it("plans nothing for a frame that was taken away", () => {
    expect(
      planKeyframeArt(story(), [
        {
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: "frame-gone",
        },
      ]),
    ).toEqual([]);
  });
});

describe("planning the clips", () => {
  it("films an act from the drawings its shots were given", () => {
    const items = planActVideos(drawnStory(), ids.chapterFirst, [ids.act]);

    expect(items[0].id).toBe(`actVideo:${ids.chapterFirst}:${ids.act}`);
    expect(items[0].capability).toBe("video");
    // The act is five seconds of shots, so five seconds are asked for.
    expect(items[0].params).toEqual({ seconds: 5, ratio: "16:9" });
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: ids.frameArt },
      { role: "lastFrame", assetId: "asset-frame-second" },
    ]);
    expect(items[0].prompt).toContain("雨中的站台，一个人立在灯下。");
    expect(items[0].prompt).toContain("另一人转过身来。");
  });

  it("plans no act video while none of its shots is drawn", () => {
    const unfilmed: StoryDocument = {
      ...story(),
      chapters: story().chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((act) => ({
          ...act,
          keyframes: act.keyframes.map((keyframe) => ({
            ...keyframe,
            art: { takes: [], confirmed: false },
          })),
        })),
      })),
    };
    expect(planActVideos(unfilmed, ids.chapterFirst, [ids.act])).toEqual([]);
  });

  it("films a shot from its own drawing, ending on the next one's", () => {
    const items = planKeyframeVideos(drawnStory(), ids.chapterFirst, ids.act, [
      ids.frameFirst,
    ]);

    expect(items[0].id).toBe(
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
    // The shot is drawn for two seconds; the ceiling is sixty by default.
    expect(items[0].params).toEqual({ seconds: 2, ratio: "16:9" });
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: ids.frameArt },
      { role: "lastFrame", assetId: "asset-frame-second" },
    ]);
  });

  it("ends the last shot on itself rather than on a shot that is not there", () => {
    const items = planKeyframeVideos(drawnStory(), ids.chapterFirst, ids.act, [
      ids.frameSecond,
    ]);
    expect(items[0].inputs).toEqual([
      { role: "firstFrame", assetId: "asset-frame-second" },
    ]);
  });

  it("keeps a clip inside the length the video settings allow", () => {
    useModelStore.setState({
      view: {
        version: 1,
        revision: 1,
        models: [],
        defaults: {
          text: null,
          image: null,
          audio: null,
          video: null,
          asr: null,
        },
        secretStorage: "unset",
        preferences: {
          systemPrompt: "",
          reasoningEffort: "",
          image: { size: "", quality: "", background: "", count: 1 },
          video: {
            seconds: 3,
            resolution: "",
            generateAudio: false,
            watermark: false,
            mode: "",
            ratio: "",
          },
          audio: {
            voice: "",
            format: "",
            speed: 1,
            instructions: "",
            sampleRate: 0,
            volume: 1,
            rate: 1,
            pitch: 1,
          },
        },
      },
    });

    const items = planActVideos(drawnStory(), ids.chapterFirst, [ids.act]);
    expect(items[0].params).toEqual({ seconds: 3, ratio: "16:9" });
  });
});

describe("asking again for what did not come back", () => {
  it("plans today's ask for a place, from today's document", () => {
    const held = story();
    const edited: StoryDocument = {
      ...held,
      elements: held.elements.map((element) =>
        element.id === ids.hero
          ? { ...element, description: "四十岁上下，灰呢大衣。" }
          : element,
      ),
    };

    const items = itemsForTargets(edited, [
      {
        kind: "keyframeArt",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(
      `keyframe:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    );
    expect(items[0].prompt).toContain("灰呢大衣");
  });

  it("plans a batch per kind for a mixed list of places", () => {
    const items = itemsForTargets(drawnStory(), [
      { kind: "actVideo", chapterId: ids.chapterFirst, actId: ids.act },
      {
        kind: "keyframeVideo",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameFirst,
      },
    ]);

    expect(items.map((item) => item.id)).toEqual([
      `actVideo:${ids.chapterFirst}:${ids.act}`,
      `keyframeVideo:${ids.chapterFirst}:${ids.act}:${ids.frameFirst}`,
    ]);
  });
});
