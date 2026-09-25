import { describe, expect, it } from "vitest";
import { applyCommands, CommandError } from "./commands";
import {
  MAX_ACTS_PER_CHAPTER,
  MAX_CHAPTERS_PER_STORY,
  MAX_ELEMENTS_PER_STORY,
  MAX_KEYFRAMES_PER_ACT,
  MAX_TAKES_PER_SLOT,
  STORY_NAME_MAX,
} from "./constants";
import { decodeMokaFile, encodeMokaFile } from "./codec";
import { i18n } from "../i18n";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
  timelineIds,
} from "./fixtures";
import {
  createChapter,
  createKeyframe,
  createStory,
  defaultChapterCount,
  emptyStorySlot,
  nextStoryName,
} from "./factories";
import {
  actPlannedMs,
  chapterRegenerationCost,
  chunkWaves,
  currentTake,
  elementOf,
  formatDuration,
  ideaReady,
  keyframeCount,
  mergeActs,
  mergeChapters,
  mergeChaptersAt,
  mergeElements,
  stepReachable,
  STORY_STEPS,
  storyProgress,
  targetKey,
  timelineSizeForAspect,
  withTake,
  type ActDraft,
  type StoryChapterDraft,
  type StoryElementDraft,
} from "./story";
import {
  collectAssetReferences,
  unreferencedAssets,
  validateMokaFile,
  validateStory,
} from "./validate";
import type {
  DocumentCommand,
  MokaFile,
  StoryAct,
  StoryChapter,
  StoryDocument,
  StoryElement,
  StorySlot,
} from "./types";

const NOW = "2026-01-01T00:00:00.000Z";

function apply(moka: MokaFile, ...commands: DocumentCommand[]) {
  return applyCommands(moka, commands);
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return (error as CommandError).code;
  }
  return "NO_ERROR";
}

/** Every command must survive this: apply, undo, and be where it started. */
function expectRoundTrip(
  moka: MokaFile,
  ...commands: DocumentCommand[]
): MokaFile {
  const { next, inverse } = apply(moka, ...commands);
  const undone = apply(next, ...inverse).next;
  expect(undone).toEqual(moka);
  return next;
}

function storyOfFile(moka: MokaFile): StoryDocument {
  return moka.stories![0];
}

function take(assetId: string): StorySlot["takes"][number] {
  return { assetId, createdAt: NOW };
}

// -----------------------------------------------------------------------------
// Where each step has got to
// -----------------------------------------------------------------------------

describe("storyProgress", () => {
  const ids = storyIds();

  it("counts the premise as the one thing step one settles", () => {
    const empty = createStory("新的故事");
    expect(storyProgress(empty).idea).toEqual({
      step: "idea",
      state: "empty",
      done: 0,
      total: 1,
    });
    const told = createStory("新的故事", { idea: "一个人等一班停运的车。" });
    expect(storyProgress(told).idea.state).toBe("confirmed");
    expect(storyProgress(told).idea.done).toBe(1);
  });

  it("calls an outline working until every chapter is confirmed, then ready until every one is boarded", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.chapters = [
      { ...createChapter("一"), synopsisConfirmed: true },
      createChapter("二"),
    ];
    expect(storyProgress(story).outline).toMatchObject({
      state: "working",
      done: 1,
      total: 2,
    });

    story.chapters = story.chapters.map((chapter) => ({
      ...chapter,
      synopsisConfirmed: true,
    }));
    expect(storyProgress(story).outline.state).toBe("ready");

    story.chapters = story.chapters.map((chapter) => ({
      ...chapter,
      acts: [createActFor(chapter.id)],
    }));
    expect(storyProgress(story).outline.state).toBe("confirmed");
  });

  it("counts an element only when its words and its drawings are both agreed to", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.elements = [
      {
        ...element(ids.hero, "character"),
        descriptionConfirmed: true,
        main: { takes: [take(ids.heroMain)], confirmed: true },
        turnaround: { takes: [take(ids.heroSheet)], confirmed: true },
      },
      {
        ...element(ids.prop, "prop"),
        descriptionConfirmed: true,
        main: { takes: [take(ids.sceneMain)], confirmed: false },
      },
    ];
    // Everything is drawn, and one of the two is not yet agreed to.
    expect(storyProgress(story).elements).toMatchObject({
      state: "ready",
      done: 1,
      total: 2,
    });
  });

  it("calls the characters drawn when both drawings are there, even before anyone agrees", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.elements = [
      {
        ...element(ids.hero, "character"),
        main: { takes: [take(ids.heroMain)], confirmed: false },
        turnaround: { takes: [take(ids.heroSheet)], confirmed: false },
      },
    ];
    expect(storyProgress(story).elements.state).toBe("ready");
  });

  it("counts an act as settled only when its clip is made and agreed to", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    const act = createActFor(ids.chapterFirst);
    const frame = createKeyframe(0);
    frame.art = { takes: [take(ids.frameArt)], confirmed: true };
    act.keyframes = [frame];
    act.video = { takes: [take(ids.actVideo)], confirmed: true };
    act.videoConfirmed = true;
    story.chapters = [{ ...createChapter("一"), acts: [act] }];
    expect(storyProgress(story).storyboard).toMatchObject({
      state: "confirmed",
      done: 1,
      total: 1,
    });

    act.videoConfirmed = false;
    expect(storyProgress(story).storyboard).toMatchObject({
      state: "ready",
      done: 0,
    });
  });

  it("reads a shot-at-a-time telling as filmed only when every shot has a clip", () => {
    const story = createStory("新的故事", {
      idea: "一句话",
    });
    story.shotGranularity = "keyframe";
    const act = createActFor(ids.chapterFirst);
    const first = createKeyframe(0);
    const second = createKeyframe(1);
    first.video = { takes: [take(ids.actVideo)], confirmed: false };
    act.keyframes = [first, second];
    act.videoConfirmed = true;
    story.chapters = [{ ...createChapter("一"), acts: [act] }];
    expect(storyProgress(story).storyboard.done).toBe(0);

    second.video = { takes: [take(ids.actVideo)], confirmed: false };
    expect(storyProgress(story).storyboard.done).toBe(1);
  });

  it("reads the assembly as ready once a timeline is named, and done once the film is filed", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    expect(storyProgress(story).edit.state).toBe("empty");
    story.edit = { timelineId: "timeline-1" };
    expect(storyProgress(story).edit.state).toBe("ready");
    story.edit = { timelineId: "timeline-1", film: take(ids.actVideo) };
    expect(storyProgress(story).edit.state).toBe("confirmed");
  });
});

describe("which step a reader can walk to", () => {
  const ids = storyIds();

  it("lets step two open on a premise, and no sooner", () => {
    const story = createStory("新的故事");
    expect(stepReachable(storyProgress(story), "outline")).toBe(false);
    story.brief.idea = "一个人等一班停运的车。";
    expect(stepReachable(storyProgress(story), "outline")).toBe(true);
  });

  it("opens the elements on chapters that are all confirmed, boarded or not", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.chapters = [{ ...createChapter("一"), synopsisConfirmed: true }];
    // One of two confirmed: the elements are not yet a door.
    story.chapters.push(createChapter("二"));
    expect(stepReachable(storyProgress(story), "elements")).toBe(false);

    story.chapters = story.chapters.map((chapter) => ({
      ...chapter,
      synopsisConfirmed: true,
    }));
    // Confirmed all through, and not one board between them: the boards are
    // what step four is for, and step three is where they are drawn from.
    expect(storyProgress(story).outline.state).toBe("ready");
    expect(stepReachable(storyProgress(story), "elements")).toBe(true);
  });

  it("opens the board on elements that are described and drawn, all of them", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    story.chapters = [{ ...createChapter("一"), synopsisConfirmed: true }];
    story.elements = [
      {
        ...element(ids.hero, "character"),
        descriptionConfirmed: true,
        main: { takes: [take(ids.heroMain)], confirmed: true },
        turnaround: { takes: [take(ids.heroSheet)], confirmed: true },
      },
      {
        ...element(ids.prop, "prop"),
        descriptionConfirmed: true,
        main: { takes: [take(ids.sceneMain)], confirmed: false },
      },
    ];
    expect(stepReachable(storyProgress(story), "storyboard")).toBe(false);

    story.elements = story.elements.map((held) => ({
      ...held,
      main: { ...held.main, confirmed: true },
    }));
    expect(stepReachable(storyProgress(story), "storyboard")).toBe(true);
  });

  it("opens the cutting room on the first clip that is settled", () => {
    const story = createStory("新的故事", { idea: "一句话" });
    const act = createActFor(ids.chapterFirst);
    act.video = { takes: [take(ids.actVideo)], confirmed: true };
    act.videoConfirmed = true;
    story.chapters = [{ ...createChapter("一"), acts: [act] }];
    expect(stepReachable(storyProgress(story), "edit")).toBe(true);

    // A story with nothing filmed is not a cutting room yet.
    act.videoConfirmed = false;
    expect(stepReachable(storyProgress(story), "edit")).toBe(false);
  });

  it("always offers the first step, and keeps the other four in order", () => {
    const bare = storyProgress(createStory("新的故事"));
    expect(stepReachable(bare, "idea")).toBe(true);
    for (const step of STORY_STEPS) {
      expect(stepReachable(bare, step)).toBe(step === "idea");
    }
  });
});

describe("counting a story's parts", () => {
  it("adds up an act's shots, and an episode's", () => {
    const chapter = createChapter("一");
    const act = createActFor(chapter.id);
    const first = createKeyframe(0);
    first.durationMs = 2_000;
    const second = createKeyframe(1);
    second.durationMs = 3_000;
    act.keyframes = [first, second];
    chapter.acts = [act];
    expect(actPlannedMs(act)).toBe(5_000);
    expect(keyframeCount(chapter)).toBe(2);
  });
});

describe("what a story is told and cut to", () => {
  it("turns a frame into the size a film is exported at", () => {
    expect(timelineSizeForAspect("16:9")).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(timelineSizeForAspect("9:16")).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(timelineSizeForAspect("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(timelineSizeForAspect("4:3")).toEqual({ width: 1440, height: 1080 });
    expect(timelineSizeForAspect("21:9")).toEqual({
      width: 2560,
      height: 1080,
    });
  });

  it("reads a running time the way a reader says it", () => {
    expect(formatDuration(30_000)).toBe("00:30");
    expect(formatDuration(180_000)).toBe("03:00");
    expect(formatDuration(8 * 60 * 60 * 1000)).toBe("8:00:00");
  });
});

describe("whether the premise is one", () => {
  const story = () => {
    const held = createStory("一个故事");
    return held;
  };

  it("wants words or a manuscript before anything can be written from it", () => {
    expect(ideaReady(story())).toBe(false);
    expect(
      ideaReady({ ...story(), brief: { ...story().brief, idea: "太短" } }),
    ).toBe(false);
    expect(
      ideaReady({
        ...story(),
        brief: { ...story().brief, idea: "末班列车上，两个陌生人交换了话。" },
      }),
    ).toBe(true);
    expect(
      ideaReady({
        ...story(),
        brief: { ...story().brief, sourceAssetId: "asset-novel" },
      }),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Merging an answer into what is there
// -----------------------------------------------------------------------------

describe("mergeChapters", () => {
  it("keeps the board of a chapter that stands where it stood", () => {
    const existing: StoryChapter[] = [
      { ...createChapter("一", "旧梗概"), acts: [createActFor("chapter-1")] },
    ];
    const proposed: StoryChapterDraft[] = [
      { title: "一", synopsis: "新梗概", targetDurationMs: 30_000 },
    ];
    const merged = mergeChapters(existing, proposed);
    expect(merged[0].id).toBe(existing[0].id);
    expect(merged[0].synopsis).toBe("新梗概");
    expect(merged[0].targetDurationMs).toBe(30_000);
    expect(merged[0].acts).toHaveLength(1);
  });

  it("gives a chapter with no chapter in its place one of its own, and lets the chapters no longer told go", () => {
    const existing: StoryChapter[] = [createChapter("一"), createChapter("二")];
    const merged = mergeChapters(existing, [
      { title: "一", synopsis: "" },
      { title: "多出来的一章", synopsis: "" },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(existing[0].id);
    expect(merged[1].id).not.toBe(existing[0].id);
    expect(merged[1].acts).toEqual([]);

    // The second chapter is gone from the telling, and so is its board.
    const shortened = mergeChapters(existing, [{ title: "一", synopsis: "" }]);
    expect(shortened).toHaveLength(1);
  });
});

describe("mergeElements", () => {
  const hero: StoryElement = {
    ...element("element-hero", "character"),
    name: "林",
    description: "旧描述",
    descriptionConfirmed: true,
    main: { takes: [take("asset-hero-main")], confirmed: true },
    turnaround: { takes: [take("asset-hero-sheet")], confirmed: true },
  };

  it("matches a character by kind and name however the airs around the name move", () => {
    const identified: StoryElementDraft[] = [
      { kind: "character", name: "  林 ", description: "新描述" },
    ];
    const merged = mergeElements([hero], identified, [createChapter("一")]);
    expect(merged[0].id).toBe(hero.id);
    expect(merged[0].description).toBe("新描述");
    expect(merged[0].descriptionConfirmed).toBe(true);
    expect(merged[0].main.takes[0].assetId).toBe("asset-hero-main");
    expect(merged[0].turnaround?.takes).toHaveLength(1);
  });

  it("drops a character the reading no longer finds, and gives a new one no drawings", () => {
    const merged = mergeElements(
      [hero],
      [{ kind: "prop", name: "旧车票", description: "一张车票" }],
      [],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).not.toBe(hero.id);
    expect(merged[0].main.takes).toEqual([]);
    expect(merged[0].turnaround).toBeUndefined();
  });

  it("keeps what a part of the telling did not name, since it never saw it", () => {
    const merged = mergeElements(
      [hero],
      [{ kind: "character", name: "周", description: "年轻。" }],
      [],
      { partial: true },
    );
    expect(merged.map((each) => each.name)).toEqual(["周", "林"]);
    // The cast it did name is still matched and rewritten, drawings and all.
    const again = mergeElements(
      [hero],
      [{ kind: "character", name: "林", description: "换了衣服。" }],
      [],
      { partial: true },
    );
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(hero.id);
    expect(again[0].description).toBe("换了衣服。");
    expect(again[0].main.takes).toHaveLength(1);
  });

  it("resolves the chapters a draft was noticed in, and drops a number that names none", () => {
    const chapters = [createChapter("一"), createChapter("二")];
    const merged = mergeElements(
      [],
      [
        {
          kind: "character",
          name: "林",
          description: "",
          chapterIndexes: [1, 9],
        },
        { kind: "prop", name: "票", description: "", chapterIndexes: [] },
      ],
      chapters,
    );
    expect(merged[0].chapterIds).toEqual([chapters[1].id]);
    expect(merged[1].chapterIds).toEqual([]);
  });
});

describe("mergeActs", () => {
  it("keeps the frames and the clip of an act that stands where it stood", () => {
    const held = createActFor("chapter-1");
    const frame = createKeyframe(0);
    frame.art = { takes: [take("asset-frame-art")], confirmed: true };
    frame.video = { takes: [take("asset-frame-video")], confirmed: true };
    held.keyframes = [frame];
    held.video = { takes: [take("asset-act-video")], confirmed: true };
    held.videoConfirmed = true;

    const draft: ActDraft = {
      title: "新标题",
      summary: "新内容",
      characters: ["element-hero"],
      props: [],
      sound: { music: "低音", sfx: "雨" },
      keyframes: [
        {
          shotSize: "close",
          cameraMove: "static",
          angle: "low",
          content: "新画面",
          dialogue: [
            { speaker: "林", text: "走吧", characterId: "element-hero" },
          ],
          durationMs: 1_500,
        },
      ],
    };
    const merged = mergeActs([held], [draft]);
    expect(merged[0].id).toBe(held.id);
    expect(merged[0].title).toBe("新标题");
    expect(merged[0].videoConfirmed).toBe(true);
    expect(merged[0].video.takes).toHaveLength(1);
    expect(merged[0].keyframes[0].id).toBe(frame.id);
    expect(merged[0].keyframes[0].art.takes).toHaveLength(1);
    expect(merged[0].keyframes[0].video.takes).toHaveLength(1);
    expect(merged[0].keyframes[0].content).toBe("新画面");
    expect(merged[0].keyframes[0].dialogue[0].characterId).toBe("element-hero");
  });

  it("lets an act that is no longer boarded go, with its frames", () => {
    const merged = mergeActs([createActFor("chapter-1")], []);
    expect(merged).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

describe("withTake", () => {
  it("does not keep the same drawing twice", () => {
    const once = withTake(emptyStorySlot(), take("asset-a"), 12);
    const twice = withTake(once, take("asset-a"), 12);
    expect(twice.takes).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it("keeps the newest takes and lets the oldest go", () => {
    let slot = emptyStorySlot();
    for (let n = 0; n < MAX_TAKES_PER_SLOT + 2; n += 1) {
      slot = withTake(slot, take(`asset-${n}`), MAX_TAKES_PER_SLOT);
    }
    expect(slot.takes).toHaveLength(MAX_TAKES_PER_SLOT);
    expect(slot.takes[0].assetId).toBe("asset-2");
    expect(currentTake(slot)?.assetId).toBe(`asset-${MAX_TAKES_PER_SLOT + 1}`);
  });
});

describe("the name a place is known by", () => {
  it("is written from the target alone, in one spelling per kind of place", () => {
    expect(targetKey({ kind: "element", elementId: "e1", view: "main" })).toBe(
      "element:main:e1",
    );
    expect(
      targetKey({
        kind: "keyframe",
        chapterId: "c",
        actId: "a",
        keyframeId: "k",
      }),
    ).toBe("keyframe:c:a:k");
    expect(targetKey({ kind: "actVideo", chapterId: "c", actId: "a" })).toBe(
      "actVideo:c:a",
    );
    expect(
      targetKey({
        kind: "keyframeVideo",
        chapterId: "c",
        actId: "a",
        keyframeId: "k",
      }),
    ).toBe("keyframeVideo:c:a:k");
  });
});

describe("reading a story's cast", () => {
  it("finds the element an id names, and nothing for one the story let go", () => {
    const story = storyOfFile(buildStoryMokaFile());
    const ids = storyIds();
    expect(elementOf(story, ids.hero)?.name).toBe("林");
    expect(elementOf(story, "gone")).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// The commands
// -----------------------------------------------------------------------------

function createActFor(chapterId: string): StoryAct {
  return {
    id: `act-${chapterId}`,
    title: "第 1 幕",
    summary: "内容",
    characterIds: [],
    propIds: [],
    sound: { music: "", sfx: "" },
    keyframes: [],
    keysConfirmed: false,
    imagesConfirmed: false,
    video: emptyStorySlot(),
    videoConfirmed: false,
  };
}

function element(id: string, kind: StoryElement["kind"]): StoryElement {
  return {
    id,
    kind,
    name: id,
    description: "",
    descriptionConfirmed: false,
    chapterIds: [],
    main: emptyStorySlot(),
    ...(kind === "character" ? { turnaround: emptyStorySlot() } : {}),
  };
}

describe("story lifecycle commands", () => {
  it("adds a story at the place it asks for, and puts it back there on undo", () => {
    const moka = buildEmptyStory();
    const added = expectRoundTrip(moka, {
      type: "addStory",
      story: createStory("雨夜列车", { idea: "一句话" }),
      index: 0,
    });
    expect(added.stories).toHaveLength(2);
    expect(added.stories![0].name).toBe("雨夜列车");
  });

  it("refuses a story past the limit, a name nobody could read, and a duplicate id", () => {
    const moka = buildEmptyStory();
    const full = { ...moka, stories: [] as StoryDocument[] };
    for (let n = 0; n < 20; n += 1) {
      full.stories = [...full.stories!, createStory(`故事 ${n}`)];
    }
    expect(
      codeOf(() =>
        apply(full, { type: "addStory", story: createStory("多出来的") }),
      ),
    ).toBe("STORY_LIMIT_REACHED");

    expect(
      codeOf(() => apply(moka, { type: "addStory", story: createStory("") })),
    ).toBe("STORY_NAME_INVALID");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addStory",
          story: createStory("x".repeat(STORY_NAME_MAX + 1)),
        }),
      ),
    ).toBe("STORY_NAME_INVALID");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "addStory",
          story: { ...createStory("同名"), id: moka.stories![0].id },
        }),
      ),
    ).toBe("STORY_ID_EXISTS");
  });

  it("takes a story out whole, and puts everything back with it", () => {
    const moka = buildStoryMokaFile();
    const { next, inverse } = apply(moka, {
      type: "removeStory",
      storyId: storyIds().story,
    });
    expect(next.stories).toBeUndefined();
    // The timeline the story assembled stays where a reader can still watch it.
    expect(next.timelines).toHaveLength(1);
    expect(apply(next, ...inverse).next).toEqual(moka);
  });

  it("renames a story", () => {
    const moka = buildStoryMokaFile();
    const renamed = expectRoundTrip(moka, {
      type: "renameStory",
      storyId: storyIds().story,
      name: "站台与车厢",
    });
    expect(storyOfFile(renamed).name).toBe("站台与车厢");
  });

  it("moves only the fields a brief patch names", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryBrief",
      storyId: storyIds().story,
      patch: { totalDurationMs: 300_000, genre: "悬疑" },
    });
    const brief = storyOfFile(next).brief;
    expect(brief.totalDurationMs).toBe(300_000);
    expect(brief.genre).toBe("悬疑");
    expect(brief.style).toBe("现代都市风");
    expect(brief.idea).toBe(storyOfFile(moka).brief.idea);
  });

  it("refuses a running time and a frame nobody offered", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryBrief",
          storyId: storyIds().story,
          patch: { totalDurationMs: 1 },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryBrief",
          storyId: storyIds().story,
          patch: { aspect: "5:4" as never },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });

  it("changes the granularity, and leaves the clips already made alone", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryGranularity",
      storyId: storyIds().story,
      shotGranularity: "keyframe",
    });
    const story = storyOfFile(next);
    expect(story.shotGranularity).toBe("keyframe");
    expect(story.chapters[0].acts[0].video.takes).toHaveLength(1);
  });

  it("refuses a granularity that is neither of the two", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryGranularity",
          storyId: storyIds().story,
          shotGranularity: "scene" as never,
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("the outline command", () => {
  it("keeps a chapter's board when the chapter keeps its id, and drops one that leaves", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const kept = createChapter("第一章 站台", "重写的梗概");
    const rewritten: StoryChapter[] = [
      { ...kept, id: ids.chapterFirst },
      { ...createChapter("第三章 终点"), id: "chapter-third" },
    ];
    const next = expectRoundTrip(moka, {
      type: "setStoryChapters",
      storyId: ids.story,
      chapters: rewritten,
    });
    const chapters = storyOfFile(next).chapters;
    expect(chapters.map((chapter) => chapter.id)).toEqual([
      ids.chapterFirst,
      "chapter-third",
    ]);
    // The board shot from the first chapter is still on it.
    expect(chapters[0].acts).toHaveLength(1);
    expect(chapters[1].acts).toEqual([]);
  });

  it("refuses more chapters than a story holds", () => {
    const moka = buildStoryMokaFile();
    const chapters = Array.from(
      { length: MAX_CHAPTERS_PER_STORY + 1 },
      (_, n) => createChapter(`第 ${n} 章`),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryChapters",
          storyId: storyIds().story,
          chapters,
        }),
      ),
    ).toBe("STORY_CHAPTER_LIMIT");
  });
});

describe("the elements commands", () => {
  it("keeps an element's drawings and answers when it keeps its id", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const before = storyOfFile(moka).elements.find((e) => e.id === ids.hero)!;
    const next = expectRoundTrip(moka, {
      type: "setStoryElements",
      storyId: ids.story,
      elements: [{ ...before, description: "重写的描述" }],
    });
    const hero = storyOfFile(next).elements[0];
    expect(hero.description).toBe("重写的描述");
    expect(hero.descriptionConfirmed).toBe(true);
    expect(hero.main.takes).toHaveLength(1);
    expect(hero.turnaround?.takes).toHaveLength(1);
  });

  it("refuses more elements than a story holds", () => {
    const moka = buildStoryMokaFile();
    const elements = Array.from(
      { length: MAX_ELEMENTS_PER_STORY + 1 },
      (_, n) => element(`element-${n}`, "prop"),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryElements",
          storyId: storyIds().story,
          elements,
        }),
      ),
    ).toBe("STORY_ELEMENT_LIMIT");
  });

  it("moves only the fields an element patch names", () => {
    const moka = buildStoryMokaFile();
    const next = expectRoundTrip(moka, {
      type: "updateStoryElement",
      storyId: storyIds().story,
      elementId: storyIds().hero,
      patch: { descriptionConfirmed: false },
    });
    const hero = storyOfFile(next).elements.find(
      (e) => e.id === storyIds().hero,
    )!;
    expect(hero.descriptionConfirmed).toBe(false);
    expect(hero.description).toBe("四十岁上下，深色大衣，说话很慢。");
  });

  it("names the chapters an element was seen in, and refuses one the story has not", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryElement",
      storyId: ids.story,
      elementId: ids.hero,
      patch: { chapterIds: [ids.chapterSecond] },
    });
    const hero = storyOfFile(next).elements.find((e) => e.id === ids.hero)!;
    expect(hero.chapterIds).toEqual([ids.chapterSecond]);

    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryElement",
          storyId: ids.story,
          elementId: ids.hero,
          patch: { chapterIds: ["chapter-gone"] },
        }),
      ),
    ).toBe("STORY_TARGET_INVALID");
  });
});

describe("the board commands", () => {
  it("keeps an act's frames, clip and answers when it keeps its id, and lets one that leaves go", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const act = storyOfFile(moka).chapters[0].acts[0];
    const next = expectRoundTrip(moka, {
      type: "setStoryActs",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      acts: [
        { ...act, title: "第 1 幕 站台的灯", summary: "重写的内容" },
        createActFor(ids.chapterFirst),
      ],
    });
    const acts = storyOfFile(next).chapters[0].acts;
    expect(acts).toHaveLength(2);
    expect(acts[0].title).toBe("第 1 幕 站台的灯");
    expect(acts[0].video.takes).toHaveLength(1);
    expect(acts[0].videoConfirmed).toBe(true);
    expect(acts[0].keyframes[0].art.takes).toHaveLength(1);
    expect(acts[1].video.takes).toEqual([]);
  });

  it("refuses more acts than an episode holds, and more shots than an act holds", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const acts = Array.from({ length: MAX_ACTS_PER_CHAPTER + 1 }, () =>
      createActFor(ids.chapterFirst),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryActs",
          storyId: ids.story,
          chapterId: ids.chapterFirst,
          acts,
        }),
      ),
    ).toBe("STORY_ACT_LIMIT");

    const crowded = createActFor(ids.chapterFirst);
    crowded.keyframes = Array.from(
      { length: MAX_KEYFRAMES_PER_ACT + 1 },
      (_, n) => createKeyframe(n),
    );
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryActs",
          storyId: ids.story,
          chapterId: ids.chapterFirst,
          acts: [crowded],
        }),
      ),
    ).toBe("STORY_KEYFRAME_LIMIT");
  });

  it("keeps a reference to an element that is no longer there, once, and says nothing", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const act = storyOfFile(moka).chapters[0].acts[0];
    const next = apply(moka, {
      type: "setStoryActs",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      acts: [{ ...act, characterIds: [ids.hero, "gone", ids.hero] }],
    }).next;
    expect(storyOfFile(next).chapters[0].acts[0].characterIds).toEqual([
      ids.hero,
      "gone",
    ]);
  });

  it("moves only the fields an act patch names, replacing a sound whole", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryAct",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      patch: { sound: { music: "大提琴", sfx: "" }, imagesConfirmed: true },
    });
    const act = storyOfFile(next).chapters[0].acts[0];
    expect(act.sound).toEqual({ music: "大提琴", sfx: "" });
    expect(act.imagesConfirmed).toBe(true);
    expect(act.title).toBe("第 1 幕 空站台");
  });

  it("moves only the fields a shot patch names, and keeps a shot to its length", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryKeyframe",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      keyframeId: ids.frameSecond,
      patch: {
        shotSize: "extremeWide",
        durationMs: 1_200,
        dialogue: [{ speaker: "周", text: "车还会来。" }],
      },
    });
    const frame = storyOfFile(next).chapters[0].acts[0].keyframes[1];
    expect(frame.shotSize).toBe("extremeWide");
    expect(frame.durationMs).toBe(1_200);
    expect(frame.dialogue).toEqual([{ speaker: "周", text: "车还会来。" }]);
    expect(frame.content).toBe("另一人转过身来。");

    expect(
      codeOf(() =>
        apply(moka, {
          type: "updateStoryKeyframe",
          storyId: ids.story,
          chapterId: ids.chapterFirst,
          actId: ids.act,
          keyframeId: ids.frameSecond,
          patch: { durationMs: 10 },
        }),
      ),
    ).toBe("VALIDATION_FAILED");
  });
});

describe("filing a drawing at a place", () => {
  it("adds a take to the place a target names, and puts the old slot back on undo", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const slot: StorySlot = {
      takes: [{ assetId: "asset-new", createdAt: NOW }],
      confirmed: true,
    };
    const next = expectRoundTrip(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: {
        kind: "keyframe",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
      slot,
    });
    expect(storyOfFile(next).chapters[0].acts[0].keyframes[1].art).toEqual(
      slot,
    );
  });

  it("trims a slot to what a place keeps, oldest first, and refuses two of one drawing", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const takes = Array.from({ length: MAX_TAKES_PER_SLOT + 3 }, (_, n) =>
      take(`asset-${n}`),
    );
    takes.push(take("asset-0"));
    const next = apply(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: { kind: "element", elementId: ids.prop, view: "main" },
      slot: { takes, confirmed: false },
    }).next;
    const prop = storyOfFile(next).elements.find((e) => e.id === ids.prop)!;
    expect(prop.main.takes).toHaveLength(MAX_TAKES_PER_SLOT);
    expect(prop.main.takes[0].assetId).toBe("asset-3");
  });

  it("refuses a place the story no longer holds", () => {
    const moka = buildStoryMokaFile();
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStorySlot",
          storyId: storyIds().story,
          target: { kind: "element", elementId: "gone", view: "main" },
          slot: { takes: [], confirmed: false },
        }),
      ),
    ).toBe("STORY_TARGET_INVALID");
    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStorySlot",
          storyId: storyIds().story,
          target: {
            kind: "element",
            elementId: storyIds().scene,
            view: "turnaround",
          },
          slot: { takes: [], confirmed: false },
        }),
      ),
    ).toBe("STORY_TARGET_INVALID");
  });

  it("files an act's clip at the act, and a shot's clip at the shot", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const withAct = apply(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: { kind: "actVideo", chapterId: ids.chapterFirst, actId: ids.act },
      slot: { takes: [take("asset-second-take")], confirmed: false },
    }).next;
    expect(storyOfFile(withAct).chapters[0].acts[0].video.takes).toEqual([
      take("asset-second-take"),
    ]);

    const withShot = apply(moka, {
      type: "setStorySlot",
      storyId: ids.story,
      target: {
        kind: "keyframeVideo",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
      slot: { takes: [take("asset-shot")], confirmed: true },
    }).next;
    expect(
      storyOfFile(withShot).chapters[0].acts[0].keyframes[1].video.takes,
    ).toHaveLength(1);
  });
});

describe("taking a field away", () => {
  it("takes an act's scene away when the patch carries a null for it", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryAct",
      storyId: ids.story,
      chapterId: ids.chapterFirst,
      actId: ids.act,
      patch: { sceneId: null },
    });
    expect(storyOfFile(next).chapters[0].acts[0].sceneId).toBeUndefined();
    expect(storyOfFile(moka).chapters[0].acts[0].sceneId).toBe(ids.scene);
  });

  it("takes the manuscript away when the brief patch carries a null for it", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "updateStoryBrief",
      storyId: ids.story,
      patch: { sourceAssetId: null, sourceName: null, sourceSplit: null },
    });
    const brief = storyOfFile(next).brief;
    expect(brief.sourceAssetId).toBeUndefined();
    expect(brief.sourceName).toBeUndefined();
    expect(brief.sourceSplit).toBeUndefined();
    // The premise itself is untouched: only the keys the patch named moved.
    expect(brief.idea).toBe(storyOfFile(moka).brief.idea);
  });

  it("clears an assembly and puts it back whole", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const cleared = expectRoundTrip(moka, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: { timelineId: null, clipByAct: null, film: null },
    });
    expect(storyOfFile(cleared).edit).toEqual({});

    // And the other way: an assembly put on a story that had none, undone.
    const bare = apply(cleared, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: { timelineId: timelineIds().timeline },
    }).next;
    const { next, inverse } = apply(bare, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: { film: take(ids.actVideo) },
    });
    expect(storyOfFile(next).edit.film?.assetId).toBe(ids.actVideo);
    expect(storyOfFile(apply(next, ...inverse).next).edit.film).toBeUndefined();
  });
});

describe("what a story was assembled into", () => {
  it("remembers the timeline and its own clips, and refuses one nobody holds", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const next = expectRoundTrip(moka, {
      type: "setStoryEdit",
      storyId: ids.story,
      patch: {
        clipByAct: [{ actId: ids.act, clipId: "clip-cut-a" }],
        film: take(ids.actVideo),
      },
    });
    const edit = storyOfFile(next).edit;
    expect(edit.clipByAct).toEqual([{ actId: ids.act, clipId: "clip-cut-a" }]);
    expect(edit.film?.assetId).toBe(ids.actVideo);
    expect(edit.timelineId).toBe(timelineIds().timeline);

    expect(
      codeOf(() =>
        apply(moka, {
          type: "setStoryEdit",
          storyId: ids.story,
          patch: { timelineId: "timeline-gone" },
        }),
      ),
    ).toBe("TIMELINE_NOT_FOUND");
  });
});

// -----------------------------------------------------------------------------
// Guardrails
// -----------------------------------------------------------------------------

describe("validateStory", () => {
  it("passes the fixture and reports the things a hand-written file gets wrong", () => {
    const story = storyOfFile(buildStoryMokaFile());
    expect(validateStory(story)).toEqual([]);

    expect(
      validateStory({ ...story, name: "" }).map((issue) => issue.code),
    ).toEqual(["STORY_NAME_INVALID"]);
    expect(
      validateStory({ ...story, schemaVersion: 9 }).map((issue) => issue.code),
    ).toContain("STORY_SCHEMA_NEWER");
    expect(
      validateStory({
        ...story,
        brief: { ...story.brief, totalDurationMs: 1 },
      }).map((issue) => issue.code),
    ).toContain("VALIDATION_FAILED");
    const tooShort: StoryDocument = {
      ...story,
      chapters: story.chapters.map((chapter, index) =>
        index === 0
          ? {
              ...chapter,
              acts: [
                {
                  ...chapter.acts[0],
                  keyframes: [
                    { ...chapter.acts[0].keyframes[0], durationMs: 1 },
                  ],
                },
              ],
            }
          : chapter,
      ),
    };
    expect(validateStory(tooShort).map((issue) => issue.code)).toContain(
      "VALIDATION_FAILED",
    );
  });

  it("reports a slot that carries more takes than it may", () => {
    const story = storyOfFile(buildStoryMokaFile());
    const crowded: StoryDocument = {
      ...story,
      elements: story.elements.map((element) => ({
        ...element,
        main: {
          takes: Array.from({ length: MAX_TAKES_PER_SLOT + 1 }, (_, n) =>
            take(`asset-${n}`),
          ),
          confirmed: false,
        },
      })),
    };
    expect(validateStory(crowded).map((issue) => issue.code)).toContain(
      "STORY_SLOT_FULL",
    );
  });

  it("is read by the document validator, along with the timeline a story points at", () => {
    const moka = buildStoryMokaFile();
    expect(validateMokaFile(moka)).toEqual([]);

    const orphaned: MokaFile = {
      ...moka,
      stories: [
        { ...storyOfFile(moka), edit: { timelineId: "timeline-gone" } },
      ],
    };
    expect(validateMokaFile(orphaned).map((issue) => issue.code)).toContain(
      "STORY_TARGET_INVALID",
    );

    const doubled: MokaFile = {
      ...moka,
      stories: [storyOfFile(moka), storyOfFile(moka)],
    };
    expect(validateMokaFile(doubled).map((issue) => issue.code)).toContain(
      "STORY_ID_EXISTS",
    );
  });
});

describe("the assets a story holds", () => {
  it("counts every drawing, the manuscript and the film as in use", () => {
    const moka = buildStoryMokaFile();
    const ids = storyIds();
    const refs = collectAssetReferences(moka);
    for (const assetId of [
      ids.source,
      ids.heroMain,
      ids.heroSheet,
      ids.partnerMain,
      ids.sceneMain,
      ids.frameArt,
      ids.actVideo,
    ]) {
      expect(refs.has(assetId)).toBe(true);
    }
    const unused = unreferencedAssets(moka).map((entry) => entry.id);
    for (const assetId of refs.keys()) expect(unused).not.toContain(assetId);
  });
});

// -----------------------------------------------------------------------------
// What a document carries
// -----------------------------------------------------------------------------

describe("a story through the codec", () => {
  it("comes back as the document it went in as", () => {
    const moka = buildStoryMokaFile();
    const read = decodeMokaFile(encodeMokaFile(moka));
    expect(read).toEqual(moka);
    expect(read.stories![0].brief.style).toBe("现代都市风");
  });

  it("is absent from a document that tells no story, and stays absent", () => {
    const moka = buildEmptyStory();
    delete moka.stories;
    const read = decodeMokaFile(encodeMokaFile(moka));
    expect("stories" in read).toBe(false);
  });

  it("reads a word it does not know as the plainest thing it could be", () => {
    const moka = buildStoryMokaFile();
    // A board written by another build: the words are ones this one has no
    // meaning for, and the project still opens.
    const story = storyOfFile(moka);
    const act = story.chapters[0].acts[0];
    const read = decodeMokaFile(
      encodeMokaFile({
        ...moka,
        stories: [
          {
            ...story,
            shotGranularity: "everyShot" as never,
            chapters: [
              {
                ...story.chapters[0],
                acts: [
                  {
                    ...act,
                    keyframes: [
                      { ...act.keyframes[0], shotSize: "gigantic" as never },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(read.stories![0].shotGranularity).toBe("act");
    expect(read.stories![0].chapters[0].acts[0].keyframes[0].shotSize).toBe(
      "medium",
    );
  });

  it("refuses a story written by a newer build rather than reading it wrongly", () => {
    const moka = buildStoryMokaFile();
    const ahead: MokaFile = {
      ...moka,
      stories: [{ ...storyOfFile(moka), schemaVersion: 9 }],
    };
    expect(() => decodeMokaFile(encodeMokaFile(ahead))).toThrowError(
      /schema version 9 is not supported/,
    );
  });
});

describe("mergeChaptersAt", () => {
  it("writes each answer into the place it was asked for", () => {
    const existing: StoryChapter[] = [
      { ...createChapter("一", "旧梗概"), acts: [createActFor("chapter-1")] },
      createChapter("二", "第二章的梗概"),
    ];
    // A manuscript answers one part at a time: the second part rewrites the
    // second chapter, and the fourth is the next chapter the telling has not
    // been told yet.
    const merged = mergeChaptersAt(existing, [
      { at: 1, draft: { title: "二", synopsis: "新梗概" } },
      { at: 3, draft: { title: "四", synopsis: "第四段" } },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[1]?.id).toBe(existing[1]?.id);
    expect(merged[1]?.synopsis).toBe("新梗概");
    expect(merged[2]?.title).toBe("四");
    // The place nobody answered for is left as it stood, board and all.
    expect(merged[0]?.id).toBe(existing[0]?.id);
    expect(merged[0]?.acts).toHaveLength(1);
  });

  it("drops the chapters a whole-table answer left out", () => {
    const existing = [createChapter("一"), createChapter("二")];
    const merged = mergeChaptersAt(
      existing,
      [{ at: 0, draft: { title: "只有一章", synopsis: "" } }],
      true,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("只有一章");
  });
});

describe("chapterRegenerationCost", () => {
  it("counts the words a re-split writes over and the boards it leaves behind", () => {
    const story = createStory("新的故事");
    story.chapters = [
      {
        ...createChapter("一", "写过的梗概"),
        acts: [createActFor("chapter-1")],
      },
      {
        ...createChapter("二", "也写过的梗概"),
        acts: [createActFor("chapter-2")],
      },
      createChapter("三", ""),
    ];
    expect(chapterRegenerationCost(story, 3)).toEqual({
      chapters: 2,
      acts: 0,
    });
    // A telling divided into fewer chapters than it has leaves the last
    // chapter's board behind, which is what the question is asking about.
    expect(chapterRegenerationCost(story, 1)).toEqual({
      chapters: 2,
      acts: 1,
    });
    expect(chapterRegenerationCost(story)).toEqual({ chapters: 2, acts: 0 });
  });
});

describe("chunkWaves", () => {
  it("cuts a list into the asks a telling is made of", () => {
    expect(chunkWaves([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkWaves([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunkWaves([], 5)).toEqual([]);
    // A width nobody could take pieces in is one piece an ask.
    expect(chunkWaves([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("defaultChapterCount", () => {
  it("offers a chapter a minute, and never a telling of no chapters", () => {
    expect(defaultChapterCount(600_000)).toBe(10);
    expect(defaultChapterCount(180_000)).toBe(3);
    expect(defaultChapterCount(20_000)).toBe(1);
    expect(defaultChapterCount(0)).toBe(1);
  });
});

describe("the language the story room speaks", () => {
  it("names a new story in the interface's own language", async () => {
    await i18n.changeLanguage("zh");
    try {
      const moka = buildEmptyStory();
      expect(nextStoryName(moka)).toBe("故事 2");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
