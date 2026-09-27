import { beforeEach, describe, expect, it } from "vitest";

import { applyCommands, CommandError } from "../../shared/domain/commands";
import {
  buildEmptyStory,
  buildStoryMokaFile,
  storyIds,
} from "../../shared/domain/fixtures";
import { createAct, createKeyframe } from "../../shared/domain/factories";
import type {
  MokaFile,
  ResourceEntry,
  StoryAct,
  TimelineDocument,
} from "../../shared/domain";
import { useModelStore } from "../settings/modelStore";
import { importTimelineCommands } from "./assembly";

const ids = storyIds();
const T0 = "2026-01-01T00:00:00.000Z";

/** A piece of sound on the shelf, measured. */
function sound(id: string, durationMs: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp3`,
    path: `assets/voice/${id}.mp3`,
    mime: "audio/mpeg",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "audio/mpeg",
      bytes: 1024,
      sha256: "0".repeat(64),
      durationMs,
    },
  };
}

/** A clip on the shelf, measured. */
function video(id: string, durationMs: number): ResourceEntry {
  return {
    id,
    name: `${id}.mp4`,
    path: `assets/videos/${id}.mp4`,
    mime: "video/mp4",
    createdAt: T0,
    updatedAt: T0,
    probe: {
      mime: "video/mp4",
      bytes: 1024,
      sha256: "0".repeat(64),
      durationMs,
    },
  };
}

/** One act with a clip of its own, as the fourth step leaves it. */
function filmedAct(id: string, videoId: string, summary: string): StoryAct {
  const act = createAct(`Act ${id}`, summary);
  const shot = createKeyframe(0, "medium", "static", "eyeLevel");
  shot.content = summary;
  shot.durationMs = 1_000;
  act.keyframes = [shot];
  act.video = {
    takes: [{ assetIds: [videoId], createdAt: T0 }],
    confirmed: true,
  };
  act.videoConfirmed = true;
  return act;
}

/**
 * The fixture, walked further: a filmed act in each episode, and the first
 * act with its lines read aloud and a score under them.
 */
function told(): MokaFile {
  const moka = buildStoryMokaFile();
  const story = moka.stories![0];
  const first = filmedAct("first", ids.actVideo, "站台上的灯亮起来。");
  first.voice = {
    takes: [{ assetIds: ["asset-voice"], createdAt: T0 }],
    confirmed: true,
  };
  first.music = {
    takes: [{ assetIds: ["asset-music"], createdAt: T0 }],
    confirmed: true,
  };
  story.chapters[0] = { ...story.chapters[0], acts: [first] };
  story.chapters[1] = {
    ...story.chapters[1],
    acts: [filmedAct("second", "asset-video-2", "车厢比站台更暗。")],
  };
  moka.resources.videos.push(video("asset-video-2", 4_000));
  moka.resources.voice.push(sound("asset-voice", 3_000));
  moka.resources.music.push(sound("asset-music", 6_000));
  return moka;
}

/** The cut a batch of commands adds, which the import adds exactly one of. */
function addedTimeline(
  moka: MokaFile,
  commands: ReturnType<typeof importTimelineCommands>["commands"],
): TimelineDocument {
  const applied = applyCommands(moka, commands);
  const held = applied.next.timelines ?? [];
  const added = held.filter(
    (timeline) => !(moka.timelines ?? []).some((was) => was.id === timeline.id),
  );
  expect(added).toHaveLength(1);
  return added[0];
}

/** A telling with more shots filmed than a timeline holds. */
function crowded(): MokaFile {
  const moka = buildEmptyStory("挤满的一篇");
  const story = moka.stories![0];
  story.shotGranularity = "keyframe";
  let filmed = 0;
  moka.resources.videos = [];
  const acts = (count: number, chapter: number): StoryAct[] =>
    Array.from({ length: count }, (_, actAt) => {
      const act = createAct(`第 ${actAt + 1} 幕`, "内容");
      act.keyframes = Array.from({ length: 12 }, (_, shotAt) => {
        const shot = createKeyframe(shotAt, "medium", "static", "eyeLevel");
        shot.content = "画面";
        shot.durationMs = 1_000;
        const assetId = `asset-${chapter}-${actAt}-${shotAt}`;
        shot.video = {
          takes: [{ assetIds: [assetId], createdAt: T0 }],
          confirmed: true,
        };
        moka.resources.videos.push(video(assetId, 1_000));
        filmed += 1;
        return shot;
      });
      return act;
    });
  story.chapters = [
    { ...story.chapters[0], acts: acts(30, 0) },
    { ...story.chapters[0], acts: acts(4, 1) },
  ].map((chapter, at) => ({ ...chapter, id: `chapter-${at}` }));
  expect(filmed).toBeGreaterThan(400);
  return moka;
}

beforeEach(() => {
  useModelStore.setState({ view: null });
});

describe("the cut a telling hands over", () => {
  it("is a timeline of its own, named by the reader and framed like the telling", () => {
    const moka = told();
    const story = moka.stories![0];
    const { commands, timelineId, clips } = importTimelineCommands(
      story,
      moka,
      "雨夜列车 · 初剪",
    );
    expect(commands).toHaveLength(1);
    const timeline = addedTimeline(moka, commands);
    expect(timeline.id).toBe(timelineId);
    expect(timeline.name).toBe("雨夜列车 · 初剪");
    expect(timeline.settings).toMatchObject({
      width: 1920,
      height: 1080,
      fps: 30,
    });
    expect(clips).toBe(4);
  });

  it("lays the clips down in telling order, with each act's sound under it", () => {
    const moka = told();
    const story = moka.stories![0];
    const timeline = addedTimeline(
      moka,
      importTimelineCommands(story, moka, "初剪").commands,
    );
    const row = (kind: "video" | "audio" | "text", name?: string) =>
      timeline.tracks.find(
        (track) =>
          track.kind === kind && (name === undefined || track.name === name),
      )?.id;

    const pictures = timeline.clips
      .filter((clip) => clip.kind === "video")
      .sort((one, other) => one.startMs - other.startMs);
    expect(pictures.map((clip) => [clip.assetId, clip.startMs])).toEqual([
      [ids.actVideo, 0],
      ["asset-video-2", 5_000],
    ]);
    expect(pictures.every((clip) => clip.trackId === row("video"))).toBe(true);
    // The lines and the score go down where their act begins, each on a row of
    // its own so a reader can weigh them apart afterwards.
    const voice = timeline.clips.find((clip) => clip.assetId === "asset-voice");
    const music = timeline.clips.find((clip) => clip.assetId === "asset-music");
    expect(voice).toMatchObject({ startMs: 0, kind: "audio" });
    expect(music).toMatchObject({ startMs: 0, kind: "audio" });
    expect(voice?.trackId).not.toBe(music?.trackId);
    expect(voice?.trackId).toBe(row("audio", "Voice-over"));
    expect(timeline.clips.some((clip) => clip.kind === "text")).toBe(false);
  });

  it("leaves the timeline the telling assembled where it stands", () => {
    const moka = told();
    const story = moka.stories![0];
    const before = (moka.timelines ?? []).find(
      (timeline) => timeline.id === story.edit.timelineId,
    );
    const commands = importTimelineCommands(story, moka, "初剪").commands;
    const applied = applyCommands(moka, commands);
    const after = (applied.next.timelines ?? []).find(
      (timeline) => timeline.id === story.edit.timelineId,
    );
    expect(after).toEqual(before);
    expect(applied.next.timelines).toHaveLength(
      (moka.timelines ?? []).length + 1,
    );
  });

  it("refuses a telling with more clips than one timeline holds", () => {
    const moka = crowded();
    expect(() =>
      importTimelineCommands(moka.stories![0], moka, "初剪"),
    ).toThrow(CommandError);
    try {
      importTimelineCommands(moka.stories![0], moka, "初剪");
    } catch (problem) {
      expect((problem as Error).message).toContain("400");
    }
  });
});
