import { describe, expect, it } from "vitest";

import { CommandError } from "../../shared/domain/commands";
import { i18n } from "../../shared/i18n";
import { buildStoryMokaFile, storyIds } from "../../shared/domain/fixtures";
import { createAct, createKeyframe } from "../../shared/domain/factories";
import type {
  MokaFile,
  ResourceEntry,
  StoryChapter,
} from "../../shared/domain";
import { assemblyCommands, assemblySummary, planAssembly } from "./assembly";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

/** A video on the shelf, measured or not. */
function video(id: string, durationMs?: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp4`,
    path: `assets/videos/${id}.mp4`,
    mime: "video/mp4",
    createdAt: T0,
    updatedAt: T0,
    ...(durationMs === undefined
      ? {}
      : {
          probe: {
            mime: "video/mp4",
            bytes: 1024,
            sha256: "0".repeat(64),
            durationMs,
          },
        }),
  };
}

/** One act of an episode, with a clip of its own and a shot or two. */
function actFor(
  id: string,
  videoId: string,
  options: { shots?: number; lines?: boolean } = {},
): ReturnType<typeof createAct> {
  const act = createAct(`Act ${id}`, "What happens in it.");
  const shots = options.shots ?? 1;
  act.keyframes = Array.from({ length: shots }, (_, at) => {
    const keyframe = createKeyframe(at, "medium", "static", "eyeLevel");
    keyframe.content = `Shot ${at + 1} of ${id}.`;
    keyframe.durationMs = 2_000;
    return keyframe;
  });
  if (options.lines === true) {
    act.keyframes = act.keyframes.map((keyframe, at) => ({
      ...keyframe,
      dialogue: [
        { speaker: "Keeper", text: `Line ${at * 2 + 1}.` },
        { speaker: "", text: `Line ${at * 2 + 2}.` },
      ],
    }));
  }
  act.video = {
    takes: [{ assetIds: [videoId], createdAt: T0 }],
    confirmed: true,
  };
  act.videoConfirmed = true;
  return act;
}

/**
 * A telling whose first episode is filmed and whose second is not, on the
 * fixtures the room's own tests are built from.
 */
function filmed(
  settings: {
    secondAct?: boolean;
    videos?: ResourceEntry[];
  } = {},
): MokaFile {
  const moka = buildStoryMokaFile();
  const story = moka.stories![0];
  story.chapters[1] = {
    ...story.chapters[1]!,
    acts: settings.secondAct === true ? [actFor("act-2", "asset-video-2")] : [],
  };
  moka.resources.videos = settings.videos ?? [
    video(ids.actVideo, 5_000),
    video("asset-video-2", 4_000),
  ];
  return moka;
}

function story(moka: MokaFile) {
  return moka.stories![0];
}

describe("planAssembly", () => {
  it("lays a telling's clips down in episode, act and shot order", () => {
    const moka = filmed({ secondAct: true });
    const plan = planAssembly(story(moka), moka);
    expect(
      plan.units.map((unit) => [unit.chapterIndex, unit.actIndex]),
    ).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(plan.units.map((unit) => unit.startMs)).toEqual([0, 5_000]);
    expect(plan.units.map((unit) => unit.durationMs)).toEqual([5_000, 4_000]);
    expect(plan.totalPlannedMs).toBe(9_000);
    expect(plan.warnings).toEqual([]);
  });

  it("lays an act filmed in pieces down as the pieces, in order", () => {
    // An act longer than one clip may be was filmed in two, the second opening
    // where the first closed: the track reads them one after another, and the
    // act is only as long as the material it is made of.
    const moka = filmed({
      secondAct: true,
      videos: [
        video("asset-piece-one", 5_000),
        video("asset-piece-two", 4_000),
        video("asset-video-2", 3_000),
      ],
    });
    const held = story(moka);
    held.chapters[0]!.acts[0]!.video = {
      takes: [
        {
          assetIds: ["asset-piece-one", "asset-piece-two"],
          createdAt: T0,
        },
      ],
      confirmed: true,
    };
    const plan = planAssembly(held, moka);
    expect(plan.units.map((unit) => unit.assetId)).toEqual([
      "asset-piece-one",
      "asset-piece-two",
      "asset-video-2",
    ]);
    expect(plan.units.map((unit) => unit.startMs)).toEqual([0, 5_000, 9_000]);
    expect(plan.totalPlannedMs).toBe(12_000);
    expect(plan.warnings).toEqual([]);
  });

  it("takes one clip per shot when the telling is filmed by shot", () => {
    const moka = filmed();
    const held = story(moka);
    held.shotGranularity = "keyframe";
    const act = held.chapters[0]!.acts[0]!;
    act.keyframes[0]!.video = {
      takes: [{ assetIds: [ids.actVideo], createdAt: T0 }],
      confirmed: true,
    };
    const plan = planAssembly(held, moka);
    expect(plan.units.map((unit) => unit.keyframeId)).toEqual([ids.frameFirst]);
    expect(plan.units[0]?.durationMs).toBe(5_000);
    // The shot nobody filmed is said out loud rather than passed over.
    expect(
      plan.warnings.map(({ kind, chapterId, actId, keyframeId }) => ({
        kind,
        chapterId,
        actId,
        keyframeId,
      })),
    ).toEqual([
      {
        kind: "noVideo",
        chapterId: ids.chapterFirst,
        actId: ids.act,
        keyframeId: ids.frameSecond,
      },
    ]);
    expect(plan.warnings[0]?.place).toContain("1");
  });

  it("falls back to the planned length for material that was never measured", () => {
    const moka = filmed({ videos: [video(ids.actVideo)] });
    const plan = planAssembly(story(moka), moka);
    expect(plan.units[0]?.durationMs).toBe(5_000);
    expect(plan.warnings.map((warning) => warning.kind)).toEqual([
      "noDuration",
    ]);
  });

  it("keeps an unmeasured clip out of nothing, and says it is unmeasured", () => {
    const moka = filmed();
    const act = story(moka).chapters[0]!.acts[0]!;
    act.video = { takes: act.video.takes, confirmed: false };
    act.videoConfirmed = false;
    const plan = planAssembly(story(moka), moka);
    expect(plan.units).toHaveLength(1);
    expect(plan.warnings.map((warning) => warning.kind)).toEqual([
      "unconfirmed",
    ]);
  });

  it("leaves out a clip whose material has left the project", () => {
    const moka = filmed({ secondAct: true, videos: [video("asset-video-2")] });
    const plan = planAssembly(story(moka), moka);
    expect(plan.units.map((unit) => unit.assetId)).toEqual(["asset-video-2"]);
    expect(plan.units[0]?.startMs).toBe(0);
    expect(plan.warnings.map((warning) => warning.kind)).toEqual([
      "assetMissing",
      "noDuration",
    ]);
  });
});

describe("assemblyCommands", () => {
  it("brings a timeline of the telling's own, whole, in one command", () => {
    const moka = filmed({ secondAct: true });
    const plan = planAssembly(story(moka), moka);
    const { commands, clipByAct } = assemblyCommands(story(moka), moka, plan, {
      withSubtitles: false,
    });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    if (command?.type !== "addTimeline") throw new Error("a timeline is added");
    const timeline = command.timeline;
    expect(timeline.name).toContain(story(moka).name);
    expect(timeline.settings).toMatchObject({
      fps: 30,
      width: 1920,
      height: 1080,
      background: "#000000",
    });
    expect(timeline.clips.map((clip) => clip.startMs)).toEqual([0, 5_000]);
    expect(timeline.clips.map((clip) => clip.outPointMs)).toEqual([
      5_000, 4_000,
    ]);
    expect(timeline.clips.every((clip) => clip.kind === "video")).toBe(true);
    expect(clipByAct).toHaveLength(2);
    expect(clipByAct.map((entry) => entry.clipId)).toEqual(
      timeline.clips.map((clip) => clip.id),
    );
  });

  it("takes back its own clips and leaves the reader's alone", () => {
    const moka = filmed({ secondAct: true });
    const held = story(moka);
    const plan = planAssembly(held, moka);
    const first = assemblyCommands(held, moka, plan, { withSubtitles: false });
    const command = first.commands[0];
    if (command?.type !== "addTimeline") throw new Error("a timeline is added");
    const timeline = command.timeline;
    // The reader's own clip, on the same track as the telling's.
    const foreign = {
      ...timeline.clips[0]!,
      id: "clip-by-hand",
      assetId: ids.actVideo,
      startMs: 20_000,
      durationMs: 1_000,
    };
    moka.timelines = [{ ...timeline, clips: [...timeline.clips, foreign] }];
    held.edit = { timelineId: timeline.id, clipByAct: first.clipByAct };

    const again = assemblyCommands(held, moka, plan, {
      withSubtitles: false,
      timelineId: timeline.id,
    });
    const removed = again.commands[0];
    if (removed?.type !== "removeClips") throw new Error("clips are removed");
    expect(removed.clipIds).toEqual(timeline.clips.map((clip) => clip.id));
    expect(removed.clipIds).not.toContain("clip-by-hand");
    const added = again.commands[1];
    if (added?.type !== "addClips") throw new Error("clips are added");
    expect(added.clips).toHaveLength(2);
    expect(added.timelineId).toBe(timeline.id);
    // Two clips and nothing else: the frame is the one it was made with.
    expect(again.commands).toHaveLength(2);
  });

  it("refuses an assembly with nothing to lay down", () => {
    const moka = buildStoryMokaFile();
    const held = story(moka);
    held.chapters = held.chapters.map((chapter) => ({ ...chapter, acts: [] }));
    const plan = planAssembly(held, moka);
    expect(plan.units).toHaveLength(0);
    expect(() =>
      assemblyCommands(story(moka), moka, plan, { withSubtitles: false }),
    ).toThrow(CommandError);
    expect(() =>
      assemblyCommands(story(moka), moka, plan, { withSubtitles: false }),
    ).toThrow(i18n.t("story:edit.nothingToAssemble"));
  });
});

describe("the captions of an assembly", () => {
  it("places every line inside the shot it is said in, sharing its length", () => {
    const moka = filmed({ secondAct: true });
    const held = story(moka);
    // Three lines over two shots of one act: the first shot says two of them.
    const act = held.chapters[0]!.acts[0]!;
    act.keyframes[0]!.dialogue = [
      { speaker: "Keeper", text: "It stopped running years ago." },
      { speaker: "", text: "The doors stay shut." },
    ];
    act.keyframes[1]!.dialogue = [{ speaker: "Keeper", text: "Not tonight." }];
    // And one line in the episode that follows, whose clip starts at 5s.
    held.chapters[1]!.acts[0]!.keyframes[0]!.dialogue = [
      { speaker: "", text: "The carriage is empty." },
    ];
    const plan = planAssembly(held, moka);
    const { commands, clipByAct } = assemblyCommands(held, moka, plan, {
      withSubtitles: true,
    });
    const command = commands[0];
    if (command?.type !== "addTimeline") throw new Error("a timeline is added");
    const captions = command.timeline.clips.filter(
      (clip) => clip.kind === "text",
    );
    expect(captions).toHaveLength(4);
    // The first shot runs 2s and holds two lines; the second starts at 2s.
    expect(captions.map((clip) => clip.startMs)).toEqual([
      0, 1_000, 2_000, 5_000,
    ]);
    expect(captions.map((clip) => clip.durationMs)).toEqual([
      1_000, 1_000, 3_000, 2_000,
    ]);
    expect(captions[0]?.text?.content).toBe(
      "Keeper: It stopped running years ago.",
    );
    expect(captions[1]?.text?.content).toBe("The doors stay shut.");
    // A caption belongs to the moment it is heard in: the second episode's
    // line sits where that episode's clip does.
    expect(captions[3]?.text?.content).toBe("The carriage is empty.");
    // Captions are this telling's own too: a re-assembly takes them back with it.
    expect(clipByAct.filter((entry) => entry.keyframeId === "")).toHaveLength(
      4,
    );
  });

  it("writes no words at all when the reader asked for none", () => {
    const moka = filmed();
    const act = story(moka).chapters[0]!.acts[0]!;
    act.keyframes[0]!.dialogue = [{ speaker: "Keeper", text: "Nothing." }];
    const plan = planAssembly(story(moka), moka);
    const { commands } = assemblyCommands(story(moka), moka, plan, {
      withSubtitles: false,
    });
    const command = commands[0];
    if (command?.type !== "addTimeline") throw new Error("a timeline is added");
    expect(command.timeline.clips.every((clip) => clip.kind === "video")).toBe(
      true,
    );
  });
});

describe("assemblySummary", () => {
  it("says how much was filmed and in what order it will be laid down", () => {
    const moka = filmed({ secondAct: true });
    const held = story(moka);
    const plan = planAssembly(held, moka);
    expect(assemblySummary(held, plan)).toContain("9.0");
    expect(assemblySummary(held, plan)).toContain("2");
    held.shotGranularity = "keyframe";
    expect(assemblySummary(held, plan)).toContain("shot");
  });
});

describe("a telling on an episode everybody forgot", () => {
  it("says which shot of which act is missing its clip", () => {
    const moka = filmed({ secondAct: true });
    const held = story(moka);
    const chapter: StoryChapter = held.chapters[1]!;
    chapter.acts = [];
    const plan = planAssembly(held, moka);
    expect(plan.units).toHaveLength(1);
  });
});

/** An audio file on the shelf, as a voice-over or a score. */
function sound(id: string, durationMs: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp3`,
    path: `assets/audio/${id}.mp3`,
    mime: "audio/mpeg",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "audio/mpeg",
      bytes: 2048,
      sha256: "1".repeat(64),
      durationMs,
    },
  };
}

/** The same telling, with its first act voiced and scored. */
function sounded(): MokaFile {
  const moka = filmed({ secondAct: true });
  moka.resources.voice = [sound("asset-act-voice", 4_000)];
  moka.resources.music = [sound("asset-act-music", 9_000)];
  const act = story(moka).chapters[0]!.acts[0]!;
  act.voice = {
    takes: [{ assetIds: ["asset-act-voice"], createdAt: T0 }],
    confirmed: true,
  };
  act.music = {
    takes: [{ assetIds: ["asset-act-music"], createdAt: T0 }],
    confirmed: false,
  };
  return moka;
}

describe("a telling that has been voiced and scored", () => {
  it("brings two rows of its own, and lays the sound where the act begins", () => {
    const moka = sounded();
    const held = story(moka);
    const plan = planAssembly(held, moka);
    const { commands, clipByAct } = assemblyCommands(held, moka, plan, {
      withSubtitles: false,
    });
    const command = commands[0];
    if (command?.type !== "addTimeline") throw new Error("a timeline is added");

    const audio = command.timeline.tracks.filter(
      (track) => track.kind === "audio",
    );
    expect(audio.map((track) => track.name)).toEqual([
      i18n.t("story:edit.voiceTrack"),
      i18n.t("story:edit.musicTrack"),
    ]);

    const voice = command.timeline.clips.find(
      (clip) => clip.assetId === "asset-act-voice",
    );
    const music = command.timeline.clips.find(
      (clip) => clip.assetId === "asset-act-music",
    );
    // Cued to the act, not to a shot: the line is the whole act's.
    expect(voice?.startMs).toBe(0);
    expect(voice?.trackId).toBe(audio[0]?.id);
    expect(voice?.durationMs).toBe(4_000);
    expect(music?.startMs).toBe(0);
    expect(music?.trackId).toBe(audio[1]?.id);
    // The second act has nothing said over it, so no second voice.
    expect(
      command.timeline.clips.filter((clip) => clip.kind === "audio"),
    ).toHaveLength(2);
    // And what the telling laid down is written down, so assembling again can
    // take exactly these back.
    expect(clipByAct.filter((entry) => entry.keyframeId === "")).toHaveLength(
      2,
    );
  });

  it("takes the sound it laid down back, and leaves a reader's own row alone", () => {
    const moka = sounded();
    const held = story(moka);
    const plan = planAssembly(held, moka);
    const first = assemblyCommands(held, moka, plan, { withSubtitles: false });
    const added = first.commands[0];
    if (added?.type !== "addTimeline") throw new Error("a timeline is added");
    held.edit = { timelineId: added.timeline.id, clipByAct: first.clipByAct };
    // A clip of the reader's own on the same timeline, and a row they added.
    moka.timelines = [
      ...(moka.timelines ?? []),
      {
        ...added.timeline,
        tracks: [
          ...added.timeline.tracks,
          {
            id: "track-mine",
            kind: "audio",
            name: "My own",
            muted: false,
            hidden: false,
            locked: false,
            createdAt: T0,
          },
        ],
        clips: [
          ...added.timeline.clips,
          {
            id: "clip-mine",
            trackId: "track-mine",
            kind: "audio",
            label: "mine",
            assetId: "asset-act-music",
            startMs: 20_000,
            durationMs: 1_000,
            inPointMs: 0,
            outPointMs: 1_000,
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
            muted: false,
            opacity: 1,
            createdAt: T0,
            updatedAt: T0,
          },
        ],
      },
    ];
    // The document is read as it stands, with the row the reader added on it.
    const again = story(moka);
    const second = assemblyCommands(again, moka, planAssembly(again, moka), {
      withSubtitles: false,
      timelineId: added.timeline.id,
    });

    const removed = second.commands.find(
      (command) => command.type === "removeClips",
    );
    if (removed?.type !== "removeClips")
      throw new Error("clips are taken back");
    expect(removed.clipIds).not.toContain("clip-mine");
    expect(removed.clipIds).toEqual(
      expect.arrayContaining(
        added.timeline.clips
          .filter((clip) => clip.kind === "audio")
          .map((clip) => clip.id),
      ),
    );
    // The row the reader added is where the score goes the second time: it is
    // an audio row, and this telling does not make new ones to spite it.
    expect(second.commands.some((command) => command.type === "addTrack")).toBe(
      false,
    );
  });
});
