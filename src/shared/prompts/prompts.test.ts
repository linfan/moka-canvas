import { describe, expect, it } from "vitest";

import {
  answerSystemPrompt,
  askPrompt,
  contextBlockPrompt,
  describeDefaultPrompt,
  describeFramingPrompt,
  historyLinePrompt,
  historyPrompt,
  rewriteSystemPrompt,
  storyActVideoPrompt,
  storyElementMainPrompt,
  storyElementTurnaroundPrompt,
  storyElementsPrompt,
  storyFactsPrompt,
  storyKeyframePrompt,
  storyKeyframeVideoPrompt,
  storyOutlinePrompt,
  storySplitPrompt,
  storyStoryboardPrompt,
  storySystemPrompt,
  type StoryFacts,
} from "./index";

/**
 * Every template is read here rather than only through the code that sends it,
 * so a template that does not parse, or one whose words drifted from what the
 * callers were written against, fails in one place instead of in whichever
 * dialog happened to be opened.
 */
describe("prompts", () => {
  it("answers from the cards and says so", () => {
    expect(answerSystemPrompt()).toBe(
      "Answer from the cards given to you. Where they do not say, say that rather than filling the gap.",
    );
  });

  it("asks a rewrite for the text and nothing around it", () => {
    expect(rewriteSystemPrompt()).toBe(
      "Send the text given to you back written again as the reader asked. Return only that text, with no heading and nothing said about it.",
    );
  });

  it("starts a description with a question a reader can change", () => {
    expect(describeDefaultPrompt()).toBe(
      "Describe this picture as the prompt that would make it.",
    );
  });

  it("frames a description as the words that would make the picture", () => {
    const framing = describeFramingPrompt();
    expect(framing).toContain("Answer with a description of the picture alone");
    expect(framing.endsWith("no mention of this request.")).toBe(true);
  });

  it("names who said a line of the conversation", () => {
    expect(historyLinePrompt("You", "what is that?")).toBe(
      "You: what is that?",
    );
    expect(historyLinePrompt("Assistant", "a lantern.")).toBe(
      "Assistant: a lantern.",
    );
  });

  it("carries the earlier turns under one heading", () => {
    expect(historyPrompt(["You: hi", "Assistant: hello"])).toBe(
      "Earlier in this conversation:\nYou: hi\nAssistant: hello",
    );
  });

  it("quotes a card under its title", () => {
    expect(contextBlockPrompt("Brief", "A lantern over a lake.")).toBe(
      "[Brief]\nA lantern over a lake.",
    );
  });

  it("puts the parts of a question in the order they are read", () => {
    expect(askPrompt(["cards", "earlier", "the ask"])).toBe(
      "cards\n\n---\n\nearlier\n\n---\n\nthe ask",
    );
  });

  it("leaves out a part there is nothing to say", () => {
    expect(askPrompt(["", "earlier", "the ask"])).toBe(
      "earlier\n\n---\n\nthe ask",
    );
    expect(askPrompt(["the ask"])).toBe("the ask");
    expect(askPrompt([])).toBe("");
  });

  it("writes a reader's own characters rather than a reference to them", () => {
    expect(contextBlockPrompt("Brief", "rock & roll <b>now</b>")).toBe(
      "[Brief]\nrock & roll <b>now</b>",
    );
  });

  it("carries no newline of its own", () => {
    for (const words of [
      answerSystemPrompt(),
      rewriteSystemPrompt(),
      describeDefaultPrompt(),
      describeFramingPrompt(),
      historyLinePrompt("You", "hi"),
      contextBlockPrompt("Brief", "words"),
    ]) {
      expect(words.endsWith("\n")).toBe(false);
    }
  });
});

/**
 * A story's prompts are read here for the same reason the others are, and for
 * one more: they are built out of the brief, and a value that never made it
 * through a hole — a style, a frame, the list a framing has to be chosen from —
 * is an ask that quietly stopped asking for it.
 */
describe("story prompts", () => {
  const facts: StoryFacts = {
    aspect: "16:9",
    genre: "对白剧情",
    style: "现代都市风",
    totalDurationMs: 120_000,
  };

  it("tells a written answer what shape to come back in", () => {
    const system = storySystemPrompt();
    expect(system).toContain("json");
    expect(system).toContain("nothing else");
  });

  it("states the standing facts of the telling", () => {
    const stated = storyFactsPrompt(facts);
    expect(stated).toContain("Aspect: 16:9");
    expect(stated).toContain("Genre: 对白剧情");
    expect(stated).toContain("Visual style: 现代都市风");
    expect(stated).toContain("2:00");
  });

  it("asks for the premise as chapters, carrying the brief with it", () => {
    const prompt = storyOutlinePrompt({
      ...facts,
      idea: "末班列车上，两个陌生人交换了各自要说的话。",
      chapters: 4,
    });
    expect(prompt).toContain("末班列车上，两个陌生人交换了各自要说的话。");
    expect(prompt).toContain("as 4 chapters");
    expect(prompt).toContain("Aspect: 16:9");
    expect(prompt).toContain('"chapters"');
    expect(prompt).not.toContain("{{");
  });

  it("asks for one part of a manuscript, and says which part it is", () => {
    const prompt = storySplitPrompt({
      text: "他在站台上等一班已经停运的列车。",
      index: 2,
      total: 5,
      genre: "对白剧情",
      style: "现代都市风",
    });
    expect(prompt).toContain("Part 2 of 5");
    expect(prompt).toContain("他在站台上等一班已经停运的列车。");
    expect(prompt).toContain("对白剧情");
    expect(prompt).not.toContain("{{");
  });

  it("lists the chapters an answer is read for elements, one person per character", () => {
    const prompt = storyElementsPrompt({
      chapters: [
        { title: "第一章 站台", synopsis: "他在站台上等列车。" },
        { title: "第二章 车厢", synopsis: "车厢比站台更暗。" },
      ],
      genre: "对白剧情",
      style: "现代都市风",
    });
    expect(prompt).toContain("1. 第一章 站台 — 他在站台上等列车。");
    expect(prompt).toContain("2. 第二章 车厢 — 车厢比站台更暗。");
    // A couple or a crowd read as one character cannot be drawn: the
    // turn-around is four views of one person, and the cast sheet is one face.
    expect(prompt).toContain("a character is one person");
    expect(prompt).toContain(
      "a couple, a pair, a family or any other two or more the telling follows are that many characters",
    );
    expect(prompt).toContain("is not a character — keep it out of the cast");
    expect(prompt).toContain(
      "name them after the words it uses and what tells them apart",
    );
    expect(prompt).toContain('"characters"');
    expect(prompt).not.toContain("{{");
  });

  it("keeps a scene to one place, and its change to its description", () => {
    const prompt = storyElementsPrompt({
      chapters: [{ title: "第一章 站台", synopsis: "他在站台上等列车。" }],
      genre: "对白剧情",
      style: "现代都市风",
    });
    // A scene is drawn once and every shot of that place points at the one
    // picture, so two places in one entry cannot be drawn and an hour or a
    // weather of its own is a state the drawing is given, not a second entry.
    expect(prompt).toContain("one place to an entry");
    expect(prompt).toContain(
      "is still the one place, with the change written into its description",
    );
  });

  it("asks for props a shot must show, not light or weather", () => {
    const prompt = storyElementsPrompt({
      chapters: [{ title: "第一章 站台", synopsis: "他在站台上等列车。" }],
      genre: "对白剧情",
      style: "现代都市风",
    });
    // A prop is drawn on its own and carried into the shots as a reference
    // picture, so one nobody has to design — light, a moon, a chair — is a
    // drawing owed for nothing and a reference the frame must work around.
    expect(prompt).toContain(
      "only earns a listing where the story turns on it",
    );
    expect(prompt).toContain("are not props");
    expect(prompt).toContain("Leave out anything no shot would have to show");
    expect(prompt).toContain(
      "Do not invent anyone or anything that is not in the telling",
    );
  });

  it("boards a chapter with the names it must be written in", () => {
    const prompt = storyStoryboardPrompt({
      ...facts,
      number: 2,
      chapter: { title: "第二章 车厢", synopsis: "车厢比站台更暗。" },
      targetDurationMs: 60_000,
      elements: [
        { kind: "character", name: "林", description: "四十岁上下。" },
        { kind: "scene", name: "末班车车厢", description: "灯管忽明忽暗。" },
      ],
      shotSizes: ["mediumClose", "wide"],
      cameraMoves: ["static", "pushIn"],
      angles: ["eyeLevel", "high"],
    });
    expect(prompt).toContain("Chapter 2 of the telling: 第二章 车厢");
    expect(prompt).toContain("- 林 (character) — 四十岁上下。");
    expect(prompt).toContain("- 末班车车厢 (scene) — 灯管忽明忽暗。");
    expect(prompt).toContain("60 seconds");
    expect(prompt).toContain("mediumClose, wide");
    expect(prompt).toContain("static, pushIn");
    expect(prompt).toContain("eyeLevel, high");
    expect(prompt).toContain('"keyframes"');
    expect(prompt).not.toContain("{{");
  });

  it("draws a character whole, in the film's own look", () => {
    const prompt = storyElementMainPrompt({
      aspect: "16:9",
      style: "现代都市风",
      kind: "character",
      name: "林",
      description: "四十岁上下，深色大衣，说话很慢。",
    });
    expect(prompt).toContain("林 — 四十岁上下，深色大衣，说话很慢。");
    expect(prompt).toContain("现代都市风");
    expect(prompt).toContain("16:9");
    expect(prompt).toContain("head to foot");
    expect(prompt).toContain("no watermark");
    expect(prompt).not.toContain("{{");
  });

  it("draws a place as a place rather than as a person", () => {
    const prompt = storyElementMainPrompt({
      aspect: "16:9",
      style: "现代都市风",
      kind: "scene",
      name: "末班车车厢",
      description: "空车厢，灯管忽明忽暗。",
    });
    expect(prompt).toContain("unmistakable");
    expect(prompt).not.toContain("head to foot");
  });

  it("asks for four views of one character on one picture", () => {
    const prompt = storyElementTurnaroundPrompt({
      aspect: "16:9",
      style: "现代都市风",
      name: "林",
      description: "四十岁上下。",
    });
    expect(prompt).toContain("four views");
    expect(prompt).toContain("white background");
    expect(prompt).toContain("林 — 四十岁上下。");
    expect(prompt).toContain("现代都市风");
  });

  it("numbers a frame's references in the order its pictures travel", () => {
    const prompt = storyKeyframePrompt({
      aspect: "16:9",
      style: "现代都市风",
      chapter: { title: "第一章 站台" },
      act: { summary: "站台上的灯一盏一盏亮起来。" },
      keyframe: {
        content: "雨中的站台，一个人立在灯下。",
        shotSize: "wide",
        cameraMove: "pushIn",
        angle: "eyeLevel",
      },
      cast: [
        { name: "林", description: "四十岁上下。" },
        { name: "周", description: "年轻。" },
      ],
    });
    expect(prompt).toContain("第一章 站台");
    expect(prompt).toContain("雨中的站台，一个人立在灯下。");
    expect(prompt).toContain("wide shot");
    expect(prompt).toContain("pushIn");
    expect(prompt).toContain("1. 林 — 四十岁上下。");
    expect(prompt).toContain("2. 周 — 年轻。");
    expect(prompt).toContain("现代都市风");
    expect(prompt).not.toContain("{{");
  });

  it("draws a frame with no cast without asking for references", () => {
    const prompt = storyKeyframePrompt({
      aspect: "16:9",
      style: "现代都市风",
      chapter: { title: "第一章 站台" },
      act: { summary: "站台上的灯一盏一盏亮起来。" },
      keyframe: {
        content: "空站台。",
        shotSize: "wide",
        cameraMove: "static",
        angle: "eyeLevel",
      },
      cast: [],
    });
    expect(prompt).not.toContain("reference");
    expect(prompt).toContain("空站台。");
  });

  it("shoots an act between the frames that were drawn for it", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      first: "雨中的站台。",
      last: "另一人转过身来。",
      middle: "灯亮了。",
      seconds: 5,
    });
    expect(prompt).toContain("about 5 seconds");
    expect(prompt).toContain("It opens on: 雨中的站台。");
    expect(prompt).toContain("It passes through: 灯亮了。");
    expect(prompt).toContain("It ends on: 另一人转过身来。");
    expect(prompt).not.toContain("{{");
  });

  it("shoots an act with nothing in the middle without saying it passes through nothing", () => {
    const prompt = storyActVideoPrompt({
      aspect: "16:9",
      style: "现代都市风",
      title: "第 1 幕 空站台",
      summary: "站台上的灯一盏一盏亮起来。",
      first: "雨中的站台。",
      last: "另一人转过身来。",
      middle: "",
      seconds: 4,
    });
    expect(prompt).not.toContain("passes through");
  });

  it("shoots one shot from the frame it starts on", () => {
    const prompt = storyKeyframeVideoPrompt({
      aspect: "9:16",
      style: "现代都市风",
      title: "#1",
      content: "雨中的站台，一个人立在灯下。",
      seconds: 2,
    });
    expect(prompt).toContain("about 2 seconds");
    expect(prompt).toContain("雨中的站台，一个人立在灯下。");
    expect(prompt).toContain("9:16");
    expect(prompt).not.toContain("{{");
  });

  it("carries no newline of its own, in any of them", () => {
    const written = [
      storySystemPrompt(),
      storyFactsPrompt(facts),
      storyOutlinePrompt({ ...facts, idea: "…", chapters: 1 }),
      storySplitPrompt({
        text: "…",
        index: 1,
        total: 1,
        genre: "…",
        style: "…",
      }),
      storyElementsPrompt({ chapters: [], genre: "…", style: "…" }),
      storyStoryboardPrompt({
        ...facts,
        number: 1,
        chapter: { title: "…", synopsis: "…" },
        targetDurationMs: 1000,
        elements: [],
        shotSizes: [],
        cameraMoves: [],
        angles: [],
      }),
      storyElementMainPrompt({
        aspect: "16:9",
        style: "…",
        kind: "prop",
        name: "…",
        description: "…",
      }),
      storyElementTurnaroundPrompt({
        aspect: "16:9",
        style: "…",
        name: "…",
        description: "…",
      }),
      storyKeyframePrompt({
        aspect: "16:9",
        style: "…",
        chapter: { title: "…" },
        act: { summary: "…" },
        keyframe: {
          content: "…",
          shotSize: "wide",
          cameraMove: "static",
          angle: "eyeLevel",
        },
        cast: [],
      }),
      storyActVideoPrompt({
        aspect: "16:9",
        style: "…",
        title: "…",
        summary: "…",
        first: "…",
        last: "…",
        middle: "",
        seconds: 1,
      }),
      storyKeyframeVideoPrompt({
        aspect: "16:9",
        style: "…",
        title: "…",
        content: "…",
        seconds: 1,
      }),
    ];
    for (const words of written) {
      expect(words.endsWith("\n")).toBe(false);
      expect(words).not.toContain("{{");
    }
  });
});
