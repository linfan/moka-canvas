import { beforeEach, describe, expect, it } from "vitest";

import type { ModelsView } from "../../../api/models";
import { buildStoryMokaFile, storyIds } from "../../../shared/domain/fixtures";
import type { StoryDocument } from "../../../shared/domain/types";
import { useModelStore } from "../../settings/modelStore";
import {
  clampSeconds,
  imageSizeForAspect,
  itemsForTargets,
  jobKey,
  planActMusic,
  planActVideos,
  planActVoice,
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

/**
 * The settings as the room reads them, with the machine's own video length —
 * the number a canvas node asks with when nobody says, and the one the story
 * room must not mistake for a length its board is cut to.
 */
function settingsWithVideoSeconds(seconds: number): ModelsView {
  return {
    version: 1,
    revision: 1,
    models: [],
    defaults: {
      text: null,
      image: null,
      audio: null,
      music: null,
      video: null,
      asr: null,
    },
    preferences: {
      systemPrompt: "",
      reasoningEffort: "auto",
      image: { size: "1024x1024", quality: "auto", background: "", count: 1 },
      video: {
        seconds,
        resolution: "",
        generateAudio: false,
        watermark: false,
        mode: "auto",
        ratio: "",
      },
      audio: {
        voice: "",
        format: "",
        speed: 1,
        instructions: "",
        sampleRate: 22_050,
        volume: 50,
        rate: 1,
        pitch: 1,
      },
      story: { splitChars: 12_000, readChars: 8_000 },
    },
    secretStorage: "unset",
  };
}

/** The fixture with both shots of its first act set to run this long. */
function plannedShot(ms: number): StoryDocument {
  const held = drawnStory();
  return {
    ...held,
    chapters: held.chapters.map((chapter) => ({
      ...chapter,
      acts: chapter.acts.map((heldAct) => ({
        ...heldAct,
        keyframes: heldAct.keyframes.map((keyframe) => ({
          ...keyframe,
          durationMs: ms,
        })),
      })),
    })),
  };
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
  it("asks under the room's standing instruction, which drawings never carry", () => {
    // A written answer is shaped by it — one json block and nothing around it —
    // and a picture has no room for a shape that is about words.
    const words = planOutline(story(), { mode: "expand", chapters: 2 });
    expect(words[0].system).toContain("Answer with one json shape");
    expect(planElements(story())[0].system).toContain("json shape");
    expect(planStoryboard(story(), [ids.chapterFirst])[0].system).toContain(
      "json shape",
    );

    const pictures = planElementArt(story(), [
      { elementId: ids.hero, view: "main" },
    ]);
    expect(pictures[0].system).toBeUndefined();
  });

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
    // Only the chapters this part is for are listed, and under the numbers the
    // telling gives them: that number is how the answer says where each thing
    // was noticed, and it is read against the whole table rather than the part.
    expect(items[0].prompt).toContain("2. 第二章 车厢 — 车厢比站台更暗。");
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
    // The story says how long and how wide; the machine's preferences say the
    // rest, since whether a provider writes sound into its clip is not the
    // telling's opinion.
    expect(items[0].params).toEqual({
      seconds: 5,
      ratio: "16:9",
      generateAudio: false,
      watermark: false,
    });
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
    // The shot is drawn for two seconds, which is what it is asked for; the
    // app's own ceiling is six hundred by default and nowhere near.
    expect(items[0].params).toEqual({
      seconds: 2,
      ratio: "16:9",
      generateAudio: false,
      watermark: false,
    });
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

  it("asks for the length the board planned, not the video settings' own", () => {
    // The video settings say what a canvas node asks for when nobody says:
    // six seconds unless the reader changed it. A telling says what each clip
    // is for, shot by shot, and is not cut to that number — an act of two
    // five-second shots is ten seconds wherever the setting stands.
    useModelStore.setState({ view: settingsWithVideoSeconds(6) });

    const items = planActVideos(plannedShot(5_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items[0].params).toEqual({
      seconds: 10,
      ratio: "16:9",
      generateAudio: false,
      watermark: false,
    });
    expect(items[0].prompt).toContain("about 10 seconds");
  });

  it("asks a long shot for its own length, and a score for the act it sits under", () => {
    useModelStore.setState({ view: settingsWithVideoSeconds(6) });
    const long = plannedShot(9_000);

    const [shot] = planKeyframeVideos(long, ids.chapterFirst, ids.act, [
      ids.frameFirst,
    ]);
    expect(shot.params?.seconds).toBe(9);

    const [score] = planActMusic(long, ids.chapterFirst, ids.act);
    // An act of two nine-second shots runs eighteen seconds, so the score
    // asked to sit under it is asked for eighteen rather than for six.
    expect(score.prompt).toContain("18 seconds");
  });

  it("still keeps a clip inside the length one may be", () => {
    // Two shots of four hundred seconds is over thirteen minutes, past the ten
    // a clip may run: what the app's own ceiling cuts is the board's
    // arithmetic, and nothing in the settings is.
    useModelStore.setState({ view: settingsWithVideoSeconds(6) });

    const items = planActVideos(plannedShot(400_000), ids.chapterFirst, [
      ids.act,
    ]);
    expect(items[0].params?.seconds).toBe(600);
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

describe("the sound of an act", () => {
  it("reads an act's lines aloud as one ask, in the order the board tells them", () => {
    const held = story();
    const act = held.chapters[0].acts[0];
    // A line in the second shot too, so the order it is read in is a claim
    // the fixture can be wrong about.
    const lined: StoryDocument = {
      ...held,
      chapters: held.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((each) =>
          each.id !== act.id
            ? each
            : {
                ...each,
                keyframes: each.keyframes.map((keyframe) =>
                  keyframe.id !== ids.frameSecond
                    ? keyframe
                    : {
                        ...keyframe,
                        dialogue: [
                          { speaker: "周", text: "下一班还来。", tone: "" },
                        ],
                      },
                ),
              },
        ),
      })),
    };

    const items = planActVoice(lined, ids.chapterFirst, ids.act);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`actVoice:${ids.chapterFirst}:${ids.act}`);
    expect(items[0].capability).toBe("audio");
    expect(items[0].prompt).toContain("林：车已经停运了。（平静）");
    expect(items[0].prompt).toContain("周：下一班还来。");
    expect(items[0].prompt.indexOf("车已经停运了")).toBeLessThan(
      items[0].prompt.indexOf("下一班还来"),
    );
  });

  it("asks for nothing when an act says nothing", () => {
    const held = story();
    const silent: StoryDocument = {
      ...held,
      chapters: held.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((act) => ({
          ...act,
          keyframes: act.keyframes.map((keyframe) => ({
            ...keyframe,
            dialogue: [],
          })),
        })),
      })),
    };
    expect(planActVoice(silent, ids.chapterFirst, ids.act)).toEqual([]);
  });

  it("asks for the score with the board's own words and the music flag", () => {
    const items = planActMusic(story(), ids.chapterFirst, ids.act);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`actMusic:${ids.chapterFirst}:${ids.act}`);
    expect(items[0].capability).toBe("audio");
    expect(items[0].prompt).toContain("低音提琴，缓慢");
    expect(items[0].prompt).toContain("雨声");
    expect(items[0].prompt).toContain("空站台");
    // The flag is what the server files the answer by: without it a score
    // would land on the voice shelf.
    expect(items[0]?.params?.music).toBe(true);
    // A score plays under the lines rather than being sung over them: the
    // service that can write words for a song is told not to.
    expect(items[0]?.params?.instrumental).toBe(true);
  });

  it("asks for nothing when the board says nothing about the sound", () => {
    const held = story();
    const act = held.chapters[0].acts[0];
    const hushed: StoryDocument = {
      ...held,
      chapters: held.chapters.map((chapter) => ({
        ...chapter,
        acts: chapter.acts.map((each) =>
          each.id !== act.id
            ? each
            : { ...each, sound: { music: "", sfx: "", ambience: "  " } },
        ),
      })),
    };
    expect(planActMusic(hushed, ids.chapterFirst, ids.act)).toEqual([]);
  });

  it("asks for both again when a retry names the act's sound", () => {
    const held = story();
    const items = itemsForTargets(held, [
      { kind: "voice", chapterId: ids.chapterFirst, actId: ids.act },
      { kind: "music", chapterId: ids.chapterFirst, actId: ids.act },
    ]);
    expect(items.map((item) => item.id)).toEqual([
      `actVoice:${ids.chapterFirst}:${ids.act}`,
      `actMusic:${ids.chapterFirst}:${ids.act}`,
    ]);
  });
});
